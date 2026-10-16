import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionBatchResultV2, DecisionRuntimeV2 } from "../decisions/types-v2.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.decision-prepared-path");
type Trace = {
  calls: number;
  onDispatch?: () => void;
  work?: Promise<void>;
  authenticated: boolean;
  usage?: DecisionBatchResultV2["usage"];
  modelKeys?: string[];
  resultReads?: number;
  modelBilling?: unknown;
  modelBaseUrl?: string;
  modelHeaders?: Record<string, string>;
  modelRequest?: unknown;
  modelApi?: string;
  preparedApi?: string;
  evaluate?: DecisionRuntimeV2["evaluateV2"];
};
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  resetDiagnosticEventsForTest();
  Reflect.deleteProperty(globalThis, traceKey);
});

it.each(["plugin", "agent", "exchange"] as const)(
  "runs the retained decision SDK through real preparation without primary fallback or fabricated chat fields (%s auth)",
  async (authScope) => {
    const root = roots.make("decision-prepared-integration-");
    const pluginRoot = path.join(root, "plugin");
    const emptyBundled = path.join(root, "bundled");
    fs.mkdirSync(pluginRoot);
    fs.mkdirSync(emptyBundled);
    const id = "decision-prepared-fixture";
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: id,
      providerId: id,
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        contracts: { decisionProviders: [id] },
        modelCatalog: {
          providers: {
            [id]: {
              authScope: authScope === "exchange" ? "agent" : authScope,
              models: [
                {
                  id: "native",
                  name: "Native fixture",
                  ...(authScope === "exchange"
                    ? {
                        api: "openai-completions",
                        baseUrl: "https://catalog.fixture.invalid/v1",
                        contextWindow: 4096,
                        maxTokens: 256,
                      }
                    : {}),
                  inference: {
                    chat: authScope === "exchange",
                    decision: {
                      protocol: "fixture",
                      billing: {
                        unit: "tokens",
                        source: "provider-catalog",
                        usdPerMillion: { input: 2 },
                      },
                      input: ["text"],
                      questions: { boolean: { probabilities: "none", abstention: true } },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      [
        'const trace = globalThis[Symbol.for("openclaw.test.decision-prepared-path")];',
        "module.exports = { id: " + JSON.stringify(id) + ", register(api) {",
        "api.registerDecisionProvider({ id: " + JSON.stringify(id) + ", contractVersion: 2,",
        'provider: { label: "Synthetic", auth: [], authScope: ' +
          JSON.stringify(authScope === "exchange" ? "agent" : authScope) +
          ', resolveSyntheticAuth() { return {apiKey: "synthetic-prepared-token", mode: "api-key", source: "synthetic fixture"}; },' +
          (authScope === "agent"
            ? 'normalizeTransport() { return { api: "openai-responses" }; },'
            : "") +
          (authScope === "exchange"
            ? 'normalizeResolvedModel(context) { return { ...context.model, api: "openai-responses" }; }, prepareRuntimeAuth(context) { trace.preparedApi=context.model.api; return { apiKey: context.apiKey, baseUrl: "https://entitlement.fixture.invalid/v1", request: { headers: { "x-fixture-entitlement": "synthetic-entitlement" }, auth: { mode: "header", headerName: "x-fixture-auth", value: "synthetic-exchanged-header" } } }; },'
            : "") +
          "} ,",
        'async evaluate(batch, context) { trace.calls++; trace.onDispatch?.(); await trace.work; trace.authenticated = context.auth.apiKey === "synthetic-prepared-token"; trace.modelKeys = Object.keys(context.model); trace.modelBilling=context.model.inference?.decision?.billing; trace.modelBaseUrl=context.model.baseUrl; trace.modelHeaders=context.model.headers; trace.modelRequest=context.model[Symbol.for("openclaw.modelProviderRequestTransport")]; trace.modelApi=context.model.api; let reads = 0; return { status: "ok", get result() { trace.resultReads = ++reads; return { model: context.model.id, answers: { q: reads === 1 ? { type: "boolean", answer: null } : { type: "boolean", probabilityTrue: 0.75 } }, usage: trace.usage }; } }; }',
        "}); trace.evaluate = api.runtime.decisions.evaluateV2; } };",
      ].join("\n"),
    );
    const trace: Trace = {
      calls: 0,
      authenticated: false,
      usage: { inputTokens: 100, costUsd: 0 },
    };
    Reflect.set(globalThis, traceKey, trace);
    const cfg: OpenClawConfig = {
      ...(authScope !== "plugin"
        ? {
            models: {
              providers: {
                [id]: {
                  api: "openai-completions",
                  baseUrl: "https://catalog.fixture.invalid/v1",
                  apiKey: "synthetic-prepared-token",
                  headers: { "x-provider": "provider", "X-Precedence": "provider" },
                  request: { headers: { "x-precedence": "request", "x-request": "request" } },
                  models: [
                    {
                      id: "native",
                      name: "Native fixture",
                      headers: { "x-model": "model", "X-PRECEDENCE": "model" },
                      ...(authScope === "exchange"
                        ? { contextWindow: 4096 }
                        : {
                            inference: {
                              chat: false,
                              decision: {
                                protocol: "fixture",
                                input: ["text"],
                                questions: { boolean: { probabilities: "none", abstention: true } },
                              },
                            },
                          }),
                      maxTokens: 256,
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            },
          }
        : {}),
      agents: {
        defaults: {
          model: "unrelated/not-configured",
          decisionModel: id + "/native",
          workspace: path.join(root, "workspace"),
        },
      },
      plugins: {
        load: { paths: [pluginRoot] },
        slots: { memory: "none" },
        entries: { [id]: { enabled: true } },
      },
    };
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      setRuntimeConfigSnapshot(cfg);
      const registry = await loadAndActivateRootPluginRegistry({
        config: cfg,
        env,
        workspaceDir: path.join(root, "workspace"),
      });
      expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
      expect(registry.providers.map((entry) => entry.provider.id)).toContain(id);
      const evaluate = trace.evaluate;
      expect(evaluate).toBeTypeOf("function");
      if (!evaluate) {
        throw new Error("Decision registration omitted its runtime capability");
      }
      const usageEvents: Array<Extract<DiagnosticEventPayload, { type: "model.usage" }>> = [];
      onTestFinished(
        onTrustedInternalDiagnosticEvent(
          markTrustedOtelDiagnosticListener((event) => {
            if (event.type === "model.usage") {
              usageEvents.push(event);
            }
          }),
        ),
      );
      const evaluateFixture = () =>
        evaluate(
          {
            state: { type: "text", text: "synthetic evidence" },
            questions: { q: { type: "boolean" } },
          },
          {
            purpose: "fixture",
            rubricVersion: "v2",
            timeoutMs: 5000,
            signal: new AbortController().signal,
          },
        );
      const outcome = await evaluateFixture();
      expect(
        outcome,
        JSON.stringify({
          outcome,
          providerCalls: trace.calls,
        }),
      ).toMatchObject({
        status: "ok",
        result: { answers: { q: { answer: null } }, usage: { costUsd: 0 } },
      });
      expect(trace.calls).toBe(1);
      expect(trace.resultReads).toBe(1);
      expect(trace.authenticated).toBe(true);
      expect(usageEvents).toEqual([
        expect.objectContaining({
          provider: id,
          model: "native",
          usage: { input: 100 },
          costUsd: 0,
        }),
      ]);
      trace.usage = { inputTokens: 100 };
      const unpriced = await evaluateFixture();
      expect(unpriced.status).toBe("ok");
      if (unpriced.status === "ok") {
        expect(unpriced.result.usage).toEqual({ inputTokens: 100 });
      }
      expect(usageEvents).toHaveLength(2);
      if (authScope === "plugin") {
        expect(usageEvents[1]?.costUsd).toBe(0.0002);
      } else {
        // API normalization and exchanged endpoints both invalidate catalog-route prices.
        expect(usageEvents[1]).not.toHaveProperty("costUsd");
      }
      if (authScope === "exchange") {
        expect(trace.modelBaseUrl).toBe("https://entitlement.fixture.invalid/v1");
        expect(trace.modelBilling).toBeUndefined();
        expect(trace.preparedApi).toBe("openai-responses");
        expect(trace.modelApi).toBe(trace.preparedApi);
        expect(trace.modelRequest).toMatchObject({
          headers: { "x-fixture-entitlement": "synthetic-entitlement" },
          auth: {
            mode: "header",
            headerName: "x-fixture-auth",
            value: "synthetic-exchanged-header",
          },
        });
        expect(trace.modelHeaders).toMatchObject({
          "x-fixture-entitlement": "synthetic-entitlement",
          "x-fixture-auth": "synthetic-exchanged-header",
        });
      } else {
        expect(trace.modelKeys).not.toContain("cost");
        expect(trace.modelKeys).not.toContain("maxTokens");
        expect(trace.modelKeys).not.toContain("contextWindow");
      }
      if (authScope === "agent") {
        expect(trace.modelHeaders).toEqual({
          "x-provider": "provider",
          "x-model": "model",
          "x-precedence": "request",
          "x-request": "request",
        });
        expect(trace.modelRequest).toMatchObject({
          headers: { "x-precedence": "request", "x-request": "request" },
        });
        expect(trace.modelApi).toBe("openai-responses");
        setRuntimeConfigSnapshot({
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              decisionModel: id + "/native@missing-fixture-profile",
            },
          },
        });
        await expect(
          evaluate(
            {
              state: { type: "text", text: "explicit profile" },
              questions: { q: { type: "boolean" } },
            },
            {
              purpose: "fixture",
              rubricVersion: "v2",
              timeoutMs: 5000,
              signal: new AbortController().signal,
            },
          ),
        ).resolves.toMatchObject({ status: "unavailable", reason: "credentials-unavailable" });
        expect(trace.calls).toBe(2);
        setRuntimeConfigSnapshot(cfg);
      }

      let started!: () => void;
      let finish!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        started = resolve;
      });
      trace.work = new Promise<void>((resolve) => {
        finish = resolve;
      });
      trace.onDispatch = started;
      const controller = new AbortController();
      const pending = evaluate(
        {
          state: { type: "text", text: "synthetic cancellation" },
          questions: { q: { type: "boolean" } },
        },
        { purpose: "fixture", rubricVersion: "v2", timeoutMs: 5000, signal: controller.signal },
      );
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      await dispatched;
      controller.abort(new Error("fixture cancelled"));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(1);
      finish();
      await expect(pending).rejects.toThrow("fixture cancelled");
      expect(usageEvents).toHaveLength(2);
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(0);
      await resetPreparedModelRuntimeSnapshotsForTest();
    });
  },
);
