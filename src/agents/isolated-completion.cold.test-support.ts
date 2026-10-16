import { performance } from "node:perf_hooks";
import { vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import * as completionRoute from "./isolated-completion-route.js";
import * as isolatedCompletion from "./isolated-completion.js";
import * as runtimeBuild from "./prepared-model-runtime.build.js";
import * as preparedRuntime from "./prepared-model-runtime.js";
import * as simpleCompletion from "./simple-completion-runtime.js";

/** Observe already-imported owners without preloading the cold harness or provider graph. */
export function traceIsolatedCompletionColdStart(scenario: "resources-overlap" | "native-title") {
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
  let calls = 0;
  const run = isolatedCompletion.runIsolatedCompletion;
  spies.push(
    vi.spyOn(isolatedCompletion, "runIsolatedCompletion").mockImplementation((params) => {
      const id = ++calls;
      record("caller-start", { id, timeoutMs: params.timeoutMs });
      return observe(run(params), "caller-result", id);
    }),
  );
  let acquisitions = 0;
  const acquire = preparedRuntime.acquireAgentRunPreparedModelRuntime;
  spies.push(
    vi
      .spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime")
      .mockImplementation((...args) => {
        const id = ++acquisitions;
        record("acquire-start", { id });
        const signal = args[1]?.abortSignal;
        const aborted = () => record("signal-abort", { id });
        signal?.addEventListener("abort", aborted, { once: true });
        removeListeners.push(() => signal?.removeEventListener("abort", aborted));
        return observe(acquire(...args), "acquire-result", id);
      }),
  );
  let routes = 0;
  const route = completionRoute.resolveIsolatedCompletionRoute;
  spies.push(
    vi.spyOn(completionRoute, "resolveIsolatedCompletionRoute").mockImplementation((params) => {
      const id = ++routes;
      record("route-start", { id });
      return observe(route(params), "route-result", id);
    }),
  );
  let preparations = 0;
  const prepare = simpleCompletion.prepareSimpleCompletionModel;
  spies.push(
    vi.spyOn(simpleCompletion, "prepareSimpleCompletionModel").mockImplementation((...args) => {
      const id = ++preparations;
      record("prepare-start", { id });
      return observe(prepare(...args), "prepare-result", id);
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
      observe(result.pending, "build-publication", id);
      observe(result.completion, "build-settled", id);
      return result;
    }),
  );
  record("fixture-start");
  return {
    mark(event: "fixture-ready" | "provider-arrival" | "provider-auth", id = 0) {
      record(event, { id });
    },
    async [Symbol.asyncDispose]() {
      await waitForDiagnosticEventsDrained();
      stop();
      for (const remove of removeListeners) {
        remove();
      }
      for (const spy of spies.reverse()) {
        spy.mockRestore();
      }
      record("fixture-settled");
      console.error("[isolated-cold-proof]", JSON.stringify({ scenario, events, dropped }));
    },
  };
}
