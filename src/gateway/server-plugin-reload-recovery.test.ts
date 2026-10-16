import { expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";
import { createPluginReloadRecovery } from "./server-plugin-reload-recovery.js";
import { createGatewayPluginRuntimeState } from "./server-plugin-runtime-state.js";

it("preserves readiness when rollback restores an already unavailable startup plugin", () => {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "startup-error", status: "error" }));
  const selected = new Set(["startup-error"]);
  const recovery = createPluginReloadRecovery(registry, prepareGatewayPluginLoad);
  expect(recovery.capture(selected)).toEqual([]);
  const generation = createGatewayPluginRuntimeState({
    getServices: () => null,
    setServices() {},
  });
  generation.finishReload(undefined, "restored", selected, registry, recovery.unavailablePluginIds);
  expect(generation.getReloadStatus()).toBeUndefined();
});
