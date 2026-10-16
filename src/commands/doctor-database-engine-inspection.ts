import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { discoverBackupDatabasePaths } from "../infra/backup-sqlite-snapshot.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import {
  getDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { databasePortProviders } from "../infra/database-engine/port-provider.js";
import { listDatabaseEngineStores } from "../infra/database-engine/registry.js";
import { resolveStatePortRoots } from "../infra/database-engine/state-port.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { readBackupEngine } from "../snapshot/database-backup.js";
import type { ObservedDatabaseEngines } from "./doctor-database-engine.js";

type Input = { config: OpenClawConfig; stateDir: string; env: NodeJS.ProcessEnv };

/** Physical evidence stays in a worker and uses artifact-preserving anchor reads. */
export async function inspectDoctorDatabaseEngines(input: Input): Promise<ObservedDatabaseEngines> {
  const pool = new WorkerTaskPool<Input, ObservedDatabaseEngines>({
    workerUrl: captureRuntimeWorkerSource(new URL(import.meta.url)).moduleUrl,
    maxWorkers: 1,
    workerOptions: { workerData: { doctorDatabaseEngines: true } },
  });
  try {
    return await pool.run(input, {});
  } finally {
    await pool.close();
  }
}

if (parentPort && workerData?.doctorDatabaseEngines === true) {
  const { serveWorkerTasks } = await import("../infra/worker-task-server.js");
  serveWorkerTasks<ObservedDatabaseEngines>(async (value) => {
    // SAFETY: The Doctor host supplies this private, serializable input.
    const input = value as Input;
    const observed: ObservedDatabaseEngines = {};
    const inspected = new Set<string>();
    const inspect = (file: string, family: keyof ObservedDatabaseEngines) => {
      if (inspected.has(file) || !fs.existsSync(file)) {
        return;
      }
      inspected.add(file);
      try {
        const engine = readBackupEngine(file).engine;
        const engines = (observed[family] ??= []);
        if (!engines.includes(engine)) {
          engines.push(engine);
        }
      } catch {
        // Unreadable stores have no engine evidence; schema/admission checks report them.
      }
    };
    for (const file of resolveStatePortRoots(input)) {
      inspect(file, "state");
    }
    try {
      const selection =
        getDatabaseEngineSelection() ??
        (await resolveDatabaseEngineSelection(input.config, input.env));
      await withDatabaseEngineSelection(selection, async () => {
        const plugins = resolvePluginMetadataSnapshot(input);
        const roots = await Promise.all(
          databasePortProviders.map(async (provider) => ({
            family: listDatabaseEngineStores().find((family) => family.id === provider.id),
            paths: await provider.resolveRoots({ ...input, plugins }),
          })),
        );
        for (const file of await discoverBackupDatabasePaths(input)) {
          const owner = roots.find(({ paths }) =>
            paths.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
          );
          if (owner?.family) {
            inspect(file, owner.family.id);
          }
        }
      });
    } catch {
      // Keep already observed state evidence when config or registry admission prevents discovery.
    }
    return observed;
  });
}
