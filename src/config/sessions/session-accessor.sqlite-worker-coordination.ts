import type { MessagePort } from "node:worker_threads";
import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import {
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
  type StateDatabaseSchemaLease,
} from "../../infra/gateway-state-owner.js";
import { withSqliteDatabaseAdmissionExchange } from "../../infra/sqlite-database-admission.js";
import { retainSqliteWriteAdmissionService } from "../../infra/sqlite-transaction.js";
import { exchangeSqliteDatabaseAdmissions } from "../../infra/sqlite-worker-database-admission-relay.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteDatabaseAdmissionRelay,
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmissionAsync,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { resolveQuarantineStorePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  sqliteMutationWorkerThreadId,
  terminateSqliteMutationWorker,
  type SqliteMutationWorkerTransport,
} from "./session-accessor.sqlite-worker-transport.js";

export type SqliteMutationWorkerCoordination = {
  actorId: string;
  databasePath: string;
  stateContext: SqliteWorkerStateContext;
  databaseAdmission?: MessagePort;
  reconciliation?: { identity: string };
  opening?: {
    validation?: OpenClawAgentDatabaseValidation;
    integrityRevoked?: boolean;
  };
};

/** The request owns its native worker until a result or confirmed exit settles. */
export async function withSqliteMutationWorkerCoordination<T>(
  context: OpenClawStateWorkerContext,
  transport: SqliteMutationWorkerTransport,
  operationId: number,
  run: (coordination: SqliteMutationWorkerCoordination) => Promise<T>,
  assertRequestCurrent?: () => void,
  startupPaths?: readonly string[],
): Promise<T> {
  const worker = transport.channel;
  const actorId = `${sqliteMutationWorkerThreadId(transport)}:${operationId}`;
  const preparingError = () => {};
  worker.on("error", preparingError);
  try {
    return await withSqliteWorkerLifecycleCoordination(
      context,
      actorId,
      run,
      async () => {
        await terminateSqliteMutationWorker(transport);
      },
      "retained",
      assertRequestCurrent,
      startupPaths,
    );
  } finally {
    worker.off("error", preparingError);
  }
}

/** Join uncertain native work before the transport can release its owned resources. */
export async function withSqliteWorkerLifecycleCoordination<T>(
  context: OpenClawStateWorkerContext,
  actorId: string,
  run: (coordination: SqliteMutationWorkerCoordination) => Promise<T>,
  settleFailure: () => Promise<void>,
  mode: "retained" | "reconciliation" = "retained",
  assertRequestCurrent?: () => void,
  startupPaths?: readonly string[],
): Promise<T> {
  const identity = context.admission.identity.key;
  if (mode === "reconciliation") {
    context.admission.assertCurrent();
  }
  let active = true;
  const admission = assertRequestCurrent
    ? createSqliteWorkerOperationAdmission(() => {
        throw new Error("SQLite mutation file admission does not grant transaction authority");
      })
    : mode === "reconciliation"
      ? createSqliteDatabaseAdmissionRelay(() => {
          // Accepted lease cleanup remains valid after new read admission closes.
          if (!active) {
            throw new Error("SQLite reconciliation metadata outlived its operation");
          }
        })
      : undefined;
  if (admission && assertRequestCurrent) {
    let schemaLease: StateDatabaseSchemaLease | undefined;
    const creationPaths = new Set(
      (
        startupPaths ?? [
          context.admission.databasePath,
          resolveQuarantineStorePath(context.environment),
        ]
      ).map(resolveIdentityPathViaExistingAncestorSync),
    );
    const assertAccess = () => {
      context.admission.assertCurrent();
      // First creation stays path-bound until the native lease publishes its file identity.
      const current = context.admission.identity;
      if (current.key.startsWith("file:")) {
        assertExistingDatabaseIdentity(
          context.admission.databasePath,
          current.key,
          current.birthtime,
        );
      }
      context.maintenanceScope?.assertAdmission();
      assertStateDatabaseAccessAllowed(context.admission.databasePath, {
        maintenanceScope: context.maintenanceScope,
        schemaLease,
      });
    };
    admission.bindDatabaseAuthority({
      databasePath: context.admission.identity.canonicalPath,
      assertRequest: assertRequestCurrent,
      assertAccess,
      assertCreate(location) {
        if (!creationPaths.has(resolveIdentityPathViaExistingAncestorSync(location))) {
          throw new Error("SQLite mutation creation target differs from its captured companions");
        }
      },
      acquireSchema() {
        if (!startupPaths) {
          throw new Error("SQLite mutation file admission does not grant schema maintenance");
        }
        assertAccess();
        const acquire = () => acquireStateDatabaseSchemaLease(context.admission.databasePath);
        const lease = context.maintenanceScope ? context.maintenanceScope.run(acquire) : acquire();
        schemaLease = lease;
        context.maintenanceScope?.own(lease, "shared-resources", () => lease.release());
        return {
          assertCurrent() {
            assertAccess();
            lease.assertCurrent();
          },
          release: () => lease.release(),
        };
      },
    });
  }
  const releaseService = admission
    ? retainSqliteWriteAdmissionService(startupPaths ?? [context.admission.databasePath], () =>
        admission.service(),
      )
    : undefined;
  try {
    return await run({
      actorId,
      databasePath: context.admission.databasePath,
      stateContext: { environment: context.environment },
      ...(mode === "reconciliation" ? { reconciliation: { identity } } : {}),
      ...(admission ? { databaseAdmission: admission.port } : {}),
    });
  } catch (error) {
    try {
      await settleFailure();
    } catch (exitError) {
      throw new AggregateError(
        [admission?.failure ?? error, exitError],
        "SQLite mutation and Worker exit failed",
        { cause: exitError },
      );
    }
    // A refused grant retires the worker; confirmed exit must not hide the owner's refusal.
    throw admission?.failure ?? error;
  } finally {
    active = false;
    admission?.finish();
    releaseService?.();
  }
}

export async function runWithSqliteMutationWorkerCoordination<
  T,
  Options extends Pick<OpenClawAgentDatabaseOptions, "env">,
>(
  coordination: SqliteMutationWorkerCoordination,
  options: Options,
  run: (options: Options) => Promise<T>,
): Promise<T> {
  const execute = () =>
    run({
      ...options,
      env: { ...options.env, ...coordination.stateContext.environment },
    });
  const admission = coordination.databaseAdmission;
  if (!admission) {
    return await execute();
  }
  let active = true;
  try {
    return await withSqliteWorkerOperationAdmissionAsync({ port: admission }, () =>
      withSqliteDatabaseAdmissionExchange((facts, location, create) => {
        if (!active) {
          throw new Error("SQLite mutation file admission outlived its request");
        }
        if (create) {
          // First-open creation can run inside this worker's live schema lease.
          assertStateDatabaseAccessAllowed(coordination.databasePath);
        }
        return exchangeSqliteDatabaseAdmissions(admission, facts, location, create);
      }, execute),
    );
  } finally {
    active = false;
    admission.close();
  }
}
