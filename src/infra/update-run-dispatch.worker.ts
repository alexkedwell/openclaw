import type { ExistingOpenClawStateWriter } from "../state/openclaw-state-db-existing-write.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import type {
  InterruptedUpdateSettlement,
  InterruptedUpdateSettlementResult,
} from "./update-run-interruption-contract.js";
import { persistInterruptedUpdateObservation } from "./update-run-interruption-store.js";
import type { UpdateRunWriteOperations } from "./update-run-mutation.types.js";
import {
  recordUpdateRunMutationInWorker,
  withUpdateRunWriteAdmission,
} from "./update-run-mutation.worker.js";
import type { UpdateRunReconciliationOperations } from "./update-run-reconciliation.types.js";
import { reconcileUpdateRunCandidatesInWorker } from "./update-run-reconciliation.worker.js";

export { openUpdateRunWriter } from "./update-run-mutation.worker.js";

export type UpdateRunWorkerOperations = UpdateRunWriteOperations &
  UpdateRunReconciliationOperations & {
    "updateRuns.reconcileInterrupted": {
      input: InterruptedUpdateSettlement;
      output: InterruptedUpdateSettlementResult;
    };
  };

export function isUpdateRunWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<UpdateRunWorkerOperations> {
  return command.type.startsWith("updateRuns.");
}

export function executeUpdateRunCommand(
  command: SqliteWorkerCommand<UpdateRunWorkerOperations>,
  options: UpdateRunLedgerOptions,
  writer: () => ExistingOpenClawStateWriter,
): UpdateRunWorkerOperations[keyof UpdateRunWorkerOperations]["output"] {
  return withUpdateRunWriteAdmission((assertCurrent) => {
    if (command.type === "updateRuns.reconcile") {
      return reconcileUpdateRunCandidatesInWorker(command.input, options, assertCurrent);
    }
    if (command.type === "updateRuns.reconcileInterrupted") {
      return persistInterruptedUpdateObservation(command.input, options, assertCurrent);
    }
    return recordUpdateRunMutationInWorker(command, options, assertCurrent, writer);
  });
}
