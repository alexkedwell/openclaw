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
import type { DatabaseEngineFamily, DatabaseEngineId } from "../infra/database-engine/types.js";
import { hasErrnoCode } from "../infra/errno.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { readBackupEngine, type BackupEngine } from "../snapshot/database-backup.js";

type Input = { config: OpenClawConfig; stateDir: string; env: NodeJS.ProcessEnv };
export type ObservedDatabaseEngines = Partial<Record<DatabaseEngineFamily, DatabaseEngineId[]>>;
export type DoctorDatabaseEngineInspection = {
  observed: ObservedDatabaseEngines;
  stateRoots: { path: string; physical: BackupEngine }[];
  stateInspectionFailed?: true;
};

/** Physical evidence stays in a worker and uses artifact-preserving anchor reads. */
export async function inspectDoctorDatabaseEngines(
  input: Input,
): Promise<DoctorDatabaseEngineInspection> {
  const pool = new WorkerTaskPool<Input, DoctorDatabaseEngineInspection>({
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
  serveWorkerTasks<DoctorDatabaseEngineInspection>(async (value) => {
    // SAFETY: The Doctor host supplies this private, serializable input.
    const input = value as Input;
    const result: DoctorDatabaseEngineInspection = { observed: {}, stateRoots: [] };
    const { observed, stateRoots } = result;
    const inspected = new Set<string>();
    const inspect = (source: string, family: keyof ObservedDatabaseEngines) => {
      if (!fs.existsSync(source)) {
        return;
      }
      try {
        const file = fs.realpathSync(source);
        if (inspected.has(file)) {
          return;
        }
        inspected.add(file);
        const physical = readBackupEngine(file);
        const { engine } = physical;
        if (family === "state") {
          stateRoots.push({ path: file, physical });
        }
        const engines = (observed[family] ??= []);
        if (!engines.includes(engine)) {
          engines.push(engine);
        }
      } catch {
        if (family === "state") {
          result.stateInspectionFailed = true;
        }
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
            paths: await Promise.all(
              (await provider.resolveRoots({ ...input, plugins })).map(async (root) => {
                try {
                  return await fs.promises.realpath(root);
                } catch (error) {
                  if (hasErrnoCode(error, "ENOENT")) {
                    return root;
                  }
                  throw error;
                }
              }),
            ),
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
      result.stateInspectionFailed = true;
      // Keep already observed state evidence when config or registry admission prevents discovery.
    }
    return result;
  });
}
