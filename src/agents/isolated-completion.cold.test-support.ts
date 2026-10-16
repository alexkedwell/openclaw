import { performance } from "node:perf_hooks";
import { vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import * as pluginProfile from "../plugins/plugin-load-profile.js";
import * as runtimeBuild from "./prepared-model-runtime.build.js";
import * as runtimeFacts from "./prepared-model-runtime.facts.js";
import * as preparedRuntime from "./prepared-model-runtime.js";

/** Observe already-imported owners without preloading the cold harness or provider graph. */
export function traceIsolatedCompletionColdStart(
  scenario: "resources-overlap" | "native-title" | "direct-probe",
  completionOwners?: {
    completion: typeof import("./isolated-completion.js");
    route: typeof import("./isolated-completion-route.js");
    preparation: typeof import("./simple-completion-runtime.js");
  },
) {
  const startedAt = performance.now();
  const events: Array<Record<string, number | string>> = [];
  const spies: Array<{ mockRestore(): void }> = [];
  const removeListeners: Array<() => void> = [];
  let dropped = 0;
  const record = (event: string, values: Record<string, number | string> = {}) => {
    if (events.length < 128) {
      events.push({ event, atMs: performance.now() - startedAt, ...values });
    } else {
      dropped++;
    }
  };
  const observe = <T>(pending: Promise<T>, event: string, id: number): Promise<T> => {
    void pending.then(
      () => record(event, { id, outcome: "completed" }),
      () => record(event, { id, outcome: "error" }),
    );
    return pending;
  };
  const stop = onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type !== "diagnostic.phase.completed" || event.name !== "isolated-completion") {
        return;
      }
      const values: Record<string, number | string> = {};
      for (const key of [
        "attempts",
        "initialPreparationMs",
        "runtimeDurationMs",
        "resultDurationMs",
        "settlementDurationMs",
      ]) {
        const value = event.details?.[key];
        if (typeof value === "number") {
          values[key] = value;
        }
      }
      for (const key of ["outcome", "settlementOutcome"]) {
        const value = event.details?.[key];
        if (value === "completed" || value === "error" || value === "aborted") {
          values[key] = value;
        }
      }
      record("phase-settled", values);
    },
    { include: ["diagnostic.phase.completed"] },
  );
  // Direct probes import completion lazily; their trace must not move that cold boundary.
  if (completionOwners) {
    const { completion, route, preparation } = completionOwners;
    let calls = 0;
    const run = completion.runIsolatedCompletion;
    spies.push(
      vi.spyOn(completion, "runIsolatedCompletion").mockImplementation((params) => {
        const id = ++calls;
        record("caller-start", { id, timeoutMs: params.timeoutMs });
        return observe(run(params), "caller-result", id);
      }),
    );
    let routes = 0;
    const resolveRoute = route.resolveIsolatedCompletionRoute;
    spies.push(
      vi.spyOn(route, "resolveIsolatedCompletionRoute").mockImplementation((params) => {
        const id = ++routes;
        record("route-start", { id });
        return observe(resolveRoute(params), "route-result", id);
      }),
    );
    let preparations = 0;
    const prepare = preparation.prepareSimpleCompletionModel;
    spies.push(
      vi.spyOn(preparation, "prepareSimpleCompletionModel").mockImplementation((...args) => {
        const id = ++preparations;
        record("prepare-start", { id });
        return observe(prepare(...args), "prepare-result", id);
      }),
    );
  }
  let acquisitions = 0;
  for (const owner of [
    "acquireAgentRunPreparedModelRuntime",
    "acquireReadOnlyPreparedModelRuntime",
  ] as const) {
    const acquire = preparedRuntime[owner];
    spies.push(
      vi.spyOn(preparedRuntime, owner).mockImplementation((...args) => {
        const id = ++acquisitions;
        record("acquire-start", {
          id,
          mode: owner === "acquireReadOnlyPreparedModelRuntime" ? "read-only" : "run",
        });
        const signal = args[1]?.abortSignal;
        const aborted = () => record("signal-abort", { id });
        signal?.addEventListener("abort", aborted, { once: true });
        removeListeners.push(() => signal?.removeEventListener("abort", aborted));
        return observe(acquire(...args), "acquire-result", id);
      }),
    );
  }
  const workspaceBuild = runtimeFacts.prepareWorkspaceBuildGroup;
  spies.push(
    vi.spyOn(runtimeFacts, "prepareWorkspaceBuildGroup").mockImplementation((...args) => {
      const options = args[2];
      args[2] = {
        ...options,
        onStage: (stage) => {
          options?.onStage?.(stage);
          const label = [
            "workspace plugins",
            "static provider catalog",
            "ambient credentials",
            "agent facts",
            "configured model projection",
          ].find((label) => stage === label || stage.startsWith(`${label};`));
          record("build-stage", { stage: label ?? "other" });
        },
      };
      return workspaceBuild(...args);
    }),
  );
  let loads = 0;
  const profile = pluginProfile.withProfile;
  spies.push(
    vi.spyOn(pluginProfile, "withProfile").mockImplementation((...args) => {
      const id = ++loads;
      const labels = [
        "full",
        "discovery",
        "tool-discovery",
        "setup-only",
        "setup-runtime",
        "cli-metadata",
        "runtime-module",
      ];
      const phase =
        labels
          .flatMap((label) => [label, `${label}:register`])
          .find((label) => label === args[1]) ?? "other";
      record("plugin-load-start", { id, phase });
      let outcome = "error";
      try {
        const result = profile(...args);
        outcome = "completed";
        return result;
      } finally {
        record("plugin-load-result", { id, phase, outcome });
      }
    }),
  );
  let builds = 0;
  const build = runtimeBuild.startSerializedSnapshotBuildBatch;
  spies.push(
    vi.spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch").mockImplementation((...args) => {
      const id = ++builds;
      record("build-start", { id });
      const onBuildStats = args[4];
      args[4] = (stats) => {
        onBuildStats?.(stats);
        record("build-stats", { id, ...stats });
      };
      const result = build(...args);
      void observe(result.pending, "build-publication", id);
      void observe(result.completion, "build-settled", id);
      return result;
    }),
  );
  record("fixture-start");
  return {
    mark(event: "fixture-ready" | "provider-arrival" | "provider-auth" | "probe-start", id = 0) {
      record(event, { id });
    },
    async [Symbol.asyncDispose]() {
      await waitForDiagnosticEventsDrained();
      stop();
      for (const remove of removeListeners) {
        remove();
      }
      for (const spy of spies.toReversed()) {
        spy.mockRestore();
      }
      record("fixture-settled");
      console.error("[isolated-cold-proof]", JSON.stringify({ scenario, events, dropped }));
    },
  };
}
