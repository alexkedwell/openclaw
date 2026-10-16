import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { waitForEmbeddedAgentRunEnd } from "../../agents/embedded-agent-runner/runs.js";
import { isRecordedModelFallbackStop } from "../../agents/model-fallback-stop.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import { SessionTranscriptMessageCommittedError } from "../../agents/sessions/session-manager-message-error.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentUserMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  CORE_WORKER_LAUNCH_TOOL_NAMES,
  resolveCoreToolExecutionLocation,
} from "../../agents/tool-catalog.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveSqliteReadScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { resolveNodeWorkerLaunchToolNames } from "../../infra/node-runner-inventory.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  parseWorkerLaunchDescriptor,
  parseWorkerLaunchPlan,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import { roundTripWorkerLaunchDescriptor } from "../../worker/launch-descriptor.test-support.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { getWorkerTurnToolSurface } from "./placement-turn-claim-events.js";
import {
  WorkerRunnerCapacityError,
  type WorkerTunnelHandle,
  type WorkerTurnTunnelHandle,
} from "./tunnel-contract.js";
import { registerWorkerTurnInferenceTests } from "./worker-turn-execution.inference.suite.js";
import {
  acknowledgeCompletedWorkerTurn,
  appendWorkerReply,
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  openSessionManager,
  readWorkerTurnTranscriptStorageRows,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  workerTurnEnvironments,
  workerTurnRequest,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

function makeTunnel(overrides: Partial<WorkerTurnTunnelHandle> = {}) {
  return createWorkerTurnTunnel({
    launchTurn: vi.fn(),
    runWorkspaceCommand: vi.fn(),
    quiesceWorkspace: vi.fn(),
    syncWorkspace: vi.fn(),
    reconcileWorkspace: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  });
}

function makeProvider(
  environments: WorkerTurnEnvironmentService,
  options: Partial<Parameters<typeof createWorkerSessionTurnPlacementProvider>[0]> = {},
) {
  return createWorkerSessionTurnPlacementProvider({ placements, environments, ...options });
}

function expectUnused(...mocks: Array<ReturnType<typeof vi.fn>>) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

async function preparePolicy(
  input: ReturnType<typeof turn>,
  handler: PluginHookHandlerMap["before_agent_run"],
) {
  const runtime = await acquireAgentRunPreparedModelRuntime({
    config: input.config,
    agentId: input.agentId,
    agentDir: resolveAgentDir(input.config, input.agentId),
    workspaceDir: input.workspaceDir,
  });
  try {
    const registry = runtime.snapshot.pluginRegistry;
    assert(registry);
    const registration = {
      pluginId: "policy",
      hookName: "before_agent_run" as const,
      handler,
      source: "test",
    };
    registry.typedHooks.push(registration);
    initializeGlobalHookRunner(registry);
    return {
      pluginGeneration: runtime.pluginGeneration,
      async [Symbol.asyncDispose]() {
        registry.typedHooks.splice(registry.typedHooks.indexOf(registration), 1);
        input.preparedRunAdmission.close();
        await runtime[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await runtime[Symbol.asyncDispose]();
    throw error;
  }
}

describe("worker turn execution", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
  afterEach(resetGlobalHookRunner);

  it.each([
    { recorderOwned: false, throws: false },
    { recorderOwned: true, throws: true },
  ])("redacts blocked input before launch (%j)", async ({ recorderOwned, throws }) => {
    await seedActivePlacement();
    const input = turn("blocked-input");
    const resolveTarget = vi.fn(() => ({ ...sessionTarget, sessionEntry: undefined }));
    const recorder = recorderOwned
      ? createUserTurnTranscriptRecorder({
          target: resolveTarget,
          input: { text: input.prompt },
        })
      : undefined;
    const handler = vi.fn(async () => {
      expect((await openSessionManager()).getEntries()).toEqual([]);
      if (throws) {
        throw new Error("synthetic policy failure");
      }
      return { outcome: "block" as const, reason: "synthetic policy", message: "Request blocked." };
    });
    await using runtime = await preparePolicy(input, handler);
    const environments = { ...unusedEnvironments(), get: attachedEnvironment };
    const provider = createWorkerSessionTurnPlacementProvider({ placements, environments });
    const runLocal = vi.fn();
    const onUserMessagePersisted = vi.fn();
    const result = await provider.executeTurn(
      { ...sessionTarget, runId: input.runId },
      {
        ...input,
        pluginGeneration: runtime.pluginGeneration,
        userTurnTranscriptRecorder: recorder,
        onUserMessagePersisted,
      },
      runLocal,
    );
    expect(result.meta.error?.kind).toBe("hook_block");
    expect(result.meta.livenessState).toBe("blocked");
    expect(handler).toHaveBeenCalledOnce();
    if (recorderOwned) {
      expect(resolveTarget).toHaveBeenCalledOnce();
    }
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(runLocal).not.toHaveBeenCalled();
    const messages = (await openSessionManager()).buildSessionContext().messages;
    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: result.payloads?.[0]?.text }],
        idempotencyKey: `hook-block:before_agent_run:user:${input.runId}`,
        __openclaw: {
          beforeAgentRunBlocked: {
            blockedBy: throws ? "before_agent_run" : "policy",
            blockedAt: expect.any(Number),
          },
        },
      }),
    ]);
    expect(JSON.stringify(readWorkerTurnTranscriptStorageRows())).not.toContain(input.prompt);
    expect(onUserMessagePersisted).toHaveBeenCalledExactlyOnceWith(messages[0]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("fences a passing gate when run authority closes during its await", async () => {
    await seedActivePlacement();
    const entered = createDeferred();
    const release = createDeferred();
    const input = turn("revoked-gate");
    await using runtime = await preparePolicy(input, async () => {
      entered.resolve();
      await release.promise;
      return { outcome: "pass" as const };
    });
    const environments = { ...unusedEnvironments(), get: attachedEnvironment };
    const provider = createWorkerSessionTurnPlacementProvider({ placements, environments });
    let current = true;
    const execution = provider.executeTurn(
      { ...sessionTarget, runId: input.runId },
      { ...input, pluginGeneration: runtime.pluginGeneration },
      vi.fn(),
      undefined,
      () => {
        if (!current) {
          throw new Error("synthetic authority closed");
        }
      },
    );
    const outcome = execution.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, execution, "turn skipped its input gate");
      current = false;
      release.resolve();
      expect(await outcome).toMatchObject({ message: "synthetic authority closed" });
      expect((await openSessionManager()).getEntries()).toEqual([]);
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await outcome;
    }
  });

  it.each(["authority", "acknowledgement"] as const)(
    "retains the committed user receipt when %s fails before worker launch",
    async (failure) => {
      await seedActivePlacement();
      const input = turn(`user-commit-${failure}`);
      const expectedFailure = new Error(`synthetic ${failure} failure`);
      let current = true;
      let committedMessageId: string | undefined;
      const open = SessionManager.openAsync.bind(SessionManager);
      const opened = vi
        .spyOn(SessionManager, "openAsync")
        .mockImplementationOnce(async (...args) => {
          const manager = await open(...args);
          const append = manager.appendMessageAsync.bind(manager);
          vi.spyOn(manager, "appendMessageAsync").mockImplementation(async (...appendArgs) => {
            committedMessageId = await append(...appendArgs);
            if (failure === "authority") {
              current = false;
            }
            return committedMessageId;
          });
          return manager;
        });
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>();
      const onUserMessagePersisted = vi.fn(() => {
        if (failure === "acknowledgement") {
          throw expectedFailure;
        }
      });
      const runLocal = vi.fn();
      const provider = makeProvider(workerTurnEnvironments(makeTunnel({ launchTurn })));
      try {
        const outcome = await provider
          .executeTurn(
            { ...sessionTarget, runId: input.runId },
            { ...input, onUserMessagePersisted },
            runLocal,
            undefined,
            () => {
              if (!current) {
                throw expectedFailure;
              }
            },
          )
          .catch((error: unknown) => error);
        expect(outcome).toBeInstanceOf(SessionTranscriptMessageCommittedError);
        expect(outcome).toMatchObject({
          committedMessageId,
          committedTarget: {
            ...sessionTarget,
            storePath: resolveSqliteReadScope(sessionTarget).path,
          },
          cause: expectedFailure,
        });
        expect(isRecordedModelFallbackStop(outcome)).toBe(true);
        expect(committedMessageId).toBeDefined();
        const entries = (await openSessionManager()).getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ id: committedMessageId, message: { role: "user" } });
        expect(onUserMessagePersisted).toHaveBeenCalledTimes(failure === "authority" ? 0 : 1);
        expectUnused(launchTurn, runLocal);
      } finally {
        opened.mockRestore();
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each([false, true])(
    "preserves prepared context and limits launch authority to supervisor tools (declared: %s)",
    async (declared) => {
      await seedActivePlacement();
      const launchToolNames = resolveNodeWorkerLaunchToolNames({
        enabled: true,
        capacity: { total: 1, available: 1 },
        environmentSession: 1,
        capturedExecPolicy: true,
        promptContext: 1,
        ...(declared ? { launchToolNames: [...CORE_WORKER_LAUNCH_TOOL_NAMES] } : {}),
      });
      const authorize = vi.spyOn(placements, "authorizeWorkerTurnTools");
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async (request) => {
        const runtime = getWorkerTurnToolSurface({
          sessionId: SESSION_ID,
          runId: request.plan.assignment.runId,
          environmentId: request.plan.admission.environmentId,
          ownerEpoch: request.plan.admission.ownerEpoch,
          turnClaim: request.turnClaim,
        });
        expect(runtime?.getInheritedPublicationToolName()).toBe(
          declared ? undefined : "github_publish",
        );
        throw new WorkerRunnerCapacityError();
      });
      const tunnel = makeTunnel({
        launchTurn,
        readLaunchToolNames: async () => launchToolNames,
      });
      const provider = makeProvider(workerTurnEnvironments(tunnel));
      const input = turn("launch-tool-negotiation");
      const agentWorkspace = path.join(root, "agent-bootstrap");
      await mkdir(agentWorkspace);
      await Promise.all([
        writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions."),
        writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent identity."),
        writeFile(path.join(agentWorkspace, "USER.md"), "Canonical user context."),
        writeFile(path.join(agentWorkspace, "TOOLS.md"), "Canonical tool instructions."),
        writeFile(path.join(root, "AGENTS.md"), "Selected execution project instructions."),
        writeFile(path.join(root, "SOUL.md"), "Unselected execution identity must stay private."),
      ]);
      try {
        await expect(
          provider.executeTurn(
            { ...sessionTarget, runId: input.runId },
            {
              ...input,
              toolsAllow: declared
                ? [...CORE_WORKER_LAUNCH_TOOL_NAMES, "sessions_list", "github_identity_status"]
                : undefined,
              config: {
                ...input.config,
                agents: {
                  defaults: { ...input.config.agents.defaults, workspace: agentWorkspace },
                },
              },
              currentInboundContext: { text: "Current sender: fixture-sender" },
            },
            vi.fn(),
          ),
        ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
        expect(launchTurn).toHaveBeenCalledOnce();
        const request = launchTurn.mock.calls[0]![0];
        expect(parseWorkerLaunchPlan(request.plan)).toEqual(request.plan);
        const { systemPrompt, prompt, runtimeContext } = request.plan.assignment;
        expect(systemPrompt).toContain("You are a personal assistant running inside OpenClaw.");
        expect(systemPrompt).toContain("Canonical agent instructions.");
        expect(systemPrompt).toContain("Canonical agent identity.");
        expect(systemPrompt).toContain("Canonical user context.");
        expect(systemPrompt).not.toContain("Canonical tool instructions.");
        expect(systemPrompt).toContain("Selected execution project instructions.");
        expect(systemPrompt).not.toContain("Unselected execution identity must stay private.");
        expect(systemPrompt).toContain("Working directory: /worker/workspace");
        expect(prompt).toMatch(
          /^\[[^\]]+\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] Inspect this workspace$/u,
        );
        expect(runtimeContext).toContainEqual({
          kind: "conversation-data",
          text: "Current sender: fixture-sender",
        });
        const allowed = request.plan.assignment.toolAuthority.allowedToolNames;
        expect(allowed.length).toBeGreaterThan(0);
        expect(allowed.filter((name) => !launchToolNames.includes(name))).toEqual([]);
        expect(
          allowed.every((name) => resolveCoreToolExecutionLocation(name) === "placement"),
        ).toBe(true);
        expect(allowed.includes("ls")).toBe(declared);
        expect(allowed).not.toContain("sessions_list");
        const authorized = authorize.mock.calls[0]?.[1];
        expect(authorized).toEqual(
          expect.arrayContaining([...allowed, "sessions_list", "github_identity_status"]),
        );
        expect(authorized).not.toContain("github_publish");
        expect(authorize).toHaveBeenCalledExactlyOnceWith(
          request.turnClaim,
          authorized,
          expect.any(Function),
        );
      } finally {
        authorize.mockRestore();
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each([
    ["execution-start", "current"],
    ["execution-start", "cancel"],
    ["hydration", "current"],
    ["hydration", "cancel"],
    ["hydration", "run"],
    ["hydration", "phase"],
    ["hydration", "claim"],
    ["hydration", "session"],
    ["node-context", "current"],
    ["node-context", "cancel"],
    ["node-context", "claim"],
    ["node-context", "session"],
  ])("revalidates %s authority after its await (%s)", async (stage, change) => {
    await seedActivePlacement();
    const hydrating = stage === "hydration";
    const node = stage === "node-context";
    const input = turn(`${stage}-${change}`);
    const abort = new AbortController();
    const entered = createDeferred();
    const release = createDeferred();
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const runLocal = vi.fn();
    let current = true;
    let before: ReturnType<SessionManager["getPersistedEntries"]> | undefined;
    let beforeRows: ReturnType<typeof readWorkerTurnTranscriptStorageRows> | undefined;
    if (hydrating) {
      const source = await SessionManager.openAsync(sessionTarget);
      await source.appendMessageAsync(
        makeAgentUserMessage({ content: "Preserve 🦞\nexact history", timestamp: 1 }),
      );
      before = source.getPersistedEntries();
      beforeRows = readWorkerTurnTranscriptStorageRows();
    }
    const open = SessionManager.openAsync.bind(SessionManager);
    const hydration = vi.spyOn(SessionManager, "openAsync");
    let placementSql: ReturnType<typeof observeHostDataSql> | undefined;
    if (hydrating) {
      hydration.mockImplementationOnce(async (...args) => {
        requireNodeSqlite();
        const probes = change === "current" ? observeMainThreadSql() : undefined;
        let manager: SessionManager;
        try {
          probes?.calibrate();
          manager = await open(...args);
          probes?.expectIdle();
        } finally {
          probes?.restore();
        }
        expect(manager.getPersistedEntries()).toEqual(before);
        await hold();
        if (change === "current") {
          placementSql = observeHostDataSql();
        }
        return manager;
      });
    }
    const deliberateStop = new WorkerRunnerCapacityError();
    const stopAtBoundary = vi.fn(() => {
      if (placementSql) {
        expect(
          placementSql.queries.filter((sql) => sql.includes("worker_session_placements")),
        ).toEqual([]);
        placementSql.restore();
        placementSql = undefined;
      }
      throw deliberateStop;
    });
    const startTunnel = vi.fn();
    const launchTurn = vi.fn();
    if (node) {
      setActiveNodeContexts([{ nodeId: "fixture-node", prepare: hold }]);
    }
    const environments = node
      ? workerTurnEnvironments(makeTunnel({ launchTurn, measureLaunchTurn: stopAtBoundary }))
      : {
          ...unusedEnvironments(),
          get: attachedEnvironment,
          acquireTurnCredential: async () => stopAtBoundary(),
          startTunnel,
        };
    const provider = makeProvider(
      environments,
      stage === "execution-start" ? {} : { reconcileActivePlacement: async () => {} },
    );
    const operation = provider
      .executeTurn(
        { ...sessionTarget, runId: input.runId },
        {
          ...input,
          abortSignal: abort.signal,
          onExecutionStarted:
            stage === "execution-start"
              ? async (info) => {
                  expect(info?.backend).toBe("cloud-worker");
                  // Exclude recovery work preceding this turn's execution-start boundary.
                  hydration.mockClear();
                  stopAtBoundary.mockClear();
                  startTunnel.mockClear();
                  await hold();
                }
              : undefined,
          onExecutionPhase: ({ phase }) => {
            if (change === "phase" && phase === "model_resolution") {
              current = false;
            }
          },
        },
        runLocal,
        undefined,
        hydrating
          ? () => {
              if (!current) {
                throw new Error("fixture run closed");
              }
            }
          : undefined,
      )
      .catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, operation, `${stage} never entered`);
      expect(stopAtBoundary).not.toHaveBeenCalled();
      if (stage === "execution-start") {
        expectUnused(hydration, startTunnel);
      }
      if (stage !== "execution-start") {
        const placement = placements.get(SESSION_ID);
        const claim = placement && projectWorkerSessionTurnClaim(placement);
        assert(claim, "expected admitted worker claim");
        if (change === "claim") {
          await placements.releaseTurn(claim);
        }
        if (change === "session") {
          await patchSessionEntryCore(sessionTarget, () => ({ sessionId: "replacement-session" }));
        }
      }
      if (change === "cancel") {
        abort.abort(new Error("fixture cancelled"));
      }
      if (change === "run") {
        current = false;
      }
      release.resolve();
      const outcome = await operation;
      if (change === "current") {
        expect(outcome).toBe(deliberateStop);
        expect(stopAtBoundary).toHaveBeenCalledOnce();
      } else {
        expect(outcome).toBeInstanceOf(Error);
        expect(stopAtBoundary).not.toHaveBeenCalled();
      }
      if (stage === "execution-start") {
        expect(hydration).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
      }
      expectUnused(runLocal, node ? launchTurn : startTunnel);
      if (hydrating && change !== "session") {
        expect((await SessionManager.openAsync(sessionTarget)).getPersistedEntries()).toEqual(
          before,
        );
        expect(readWorkerTurnTranscriptStorageRows()).toEqual(beforeRows);
      }
    } finally {
      release.resolve();
      await operation;
      hydration.mockRestore();
      placementSql?.restore();
      if (node) {
        setActiveNodeContexts([]);
      }
      input.preparedRunAdmission.close();
    }
  });

  it("settles the committed terminal result when execution is cancelled during hydration", async () => {
    await seedActivePlacement();
    const abort = new AbortController();
    const input = turn("terminal-hydration");
    const entered = createDeferred();
    const release = createDeferred();
    const open = SessionManager.openAsync.bind(SessionManager);
    let terminalAcknowledged = false;
    let terminalHydrationHeld = false;
    const hydration = vi.spyOn(SessionManager, "openAsync").mockImplementation(async (...args) => {
      const manager = await open(...args);
      if (terminalAcknowledged && !terminalHydrationHeld) {
        terminalHydrationHeld = true;
        entered.resolve();
        await release.promise;
      }
      return manager;
    });
    const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async (request) => {
      request.onDispatchReady?.();
      const leafId = await appendWorkerReply("Committed reply 🦞", 2);
      const result = await acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
      terminalAcknowledged = true;
      return result;
    });
    const tunnel = makeTunnel({
      launchTurn,
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    });
    const provider = makeProvider(
      workerTurnEnvironments(tunnel, {
        acknowledgeCredentialDelivery: async () => true,
      }),
    );
    const runLocal = vi.fn();
    const operation = provider.executeTurn(
      { ...sessionTarget, runId: input.runId },
      { ...input, abortSignal: abort.signal },
      runLocal,
    );
    const settled = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, settled, "terminal result never hydrated");
      const committed = (await openSessionManager()).getPersistedEntries();
      const committedRows = readWorkerTurnTranscriptStorageRows();
      expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
      abort.abort(new Error("cancel after terminal acknowledgement"));
      release.resolve();
      expect(await operation).toMatchObject({ payloads: [{ text: "Committed reply 🦞" }] });
      await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
      expect((await openSessionManager()).getPersistedEntries()).toEqual(committed);
      expect(readWorkerTurnTranscriptStorageRows()).toEqual(committedRows);
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      expect(launchTurn).toHaveBeenCalledOnce();
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await settled;
      hydration.mockRestore();
      input.preparedRunAdmission.close();
    }
  });

  it("disables unsupported worker reasoning with scheduled tools", async () => {
    await seedActivePlacement();
    let descriptor: WorkerLaunchPlan | undefined;
    const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
      descriptor = roundTripWorkerLaunchDescriptor(
        parseWorkerLaunchDescriptor({
          ...plan,
          connectionEndpoint: {
            kind: "unix",
            socketPath: "/tmp/worker-approval.sock",
          },
        }),
      );
      throw new WorkerRunnerCapacityError();
    });
    const provider = makeProvider(workerTurnEnvironments(makeTunnel({ launchTurn })));
    const runLocal = vi.fn();
    await expect(
      provider.executeTurn(
        workerTurnRequest("run-scheduled"),
        {
          ...turn("run-scheduled"),
          thinkLevel: "ultra",
          provider: "custom",
          model: "plain",
          config: {
            models: {
              mode: "merge",
              providers: {
                custom: {
                  baseUrl: "https://example.invalid/v1",
                  api: "openai-completions",
                  apiKey: "synthetic-worker-api-key",
                  models: [
                    {
                      id: "plain",
                      name: "Plain",
                      reasoning: false,
                      input: ["text"],
                      contextWindow: 8192,
                      maxTokens: 2048,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            },
          },
          permissionMode: "full",
          execSession: { permissionMode: "full" },
          execOverrides: { host: "gateway", security: "full", ask: "off" },
          toolsAllow: ["exec", "process"],
          scheduledToolPolicy: {
            version: 1,
            mode: "trusted",
            execTarget: { host: "gateway", ask: "always" },
          },
        },
        runLocal,
      ),
    ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
    expect(launchTurn).toHaveBeenCalledOnce();
    expect(descriptor?.assignment.inferenceOptions.reasoning).toBe("off");
    expect(descriptor?.assignment.systemPrompt).toContain("Ultra active for this turn");
    expect(descriptor?.assignment.systemPrompt).not.toContain("Use `sessions_spawn`");
    expect(runLocal).not.toHaveBeenCalled();
    expect(descriptor?.assignment.toolAuthority).toMatchObject({
      allowedToolNames: [],
      exec: { host: "gateway", security: "full", ask: "always" },
    });
  });

  registerWorkerTurnInferenceTests();

  it("fences a stale worker receipt while a current receipt proceeds to execution", async () => {
    await seedActivePlacement();
    const oldEnvironment = attachedEnvironment();
    const currentReceipt = oldEnvironment.bootstrapReceipt;
    oldEnvironment.bootstrapReceipt = {
      ...currentReceipt!,
      protocolFeatures: [
        WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
        WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
      ],
    };
    const passedFence = new Error("current worker receipt passed the turn-execution fence");
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => oldEnvironment),
      acquireTurnCredential: vi.fn(async () => {
        throw passedFence;
      }),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(workerTurnRequest("run-old-worker"), turn("run-old-worker"), runLocal),
    ).rejects.toThrow(
      "Active worker bundle lacks the current launch capability; reprovision the worker before launch",
    );

    expect(runLocal).not.toHaveBeenCalled();
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });

    oldEnvironment.bootstrapReceipt = currentReceipt;
    await expect(
      provider.executeTurn(
        workerTurnRequest("run-current-worker"),
        turn("run-current-worker"),
        runLocal,
      ),
    ).rejects.toBe(passedFence);

    expect(environments.acquireTurnCredential).toHaveBeenCalledOnce();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });
});
