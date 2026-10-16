import type { MessagePort } from "node:worker_threads";
import type { OpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  withOpenClawAgentDatabaseAdmission,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
  type OpenClawAgentDatabaseWriteAdmission,
} from "../../state/openclaw-agent-db.js";
import { SqliteReclamationRequestRefusedError } from "./session-accessor.sqlite-reclamation-commit.js";

export function withWorkerWriteAdmission<T>(
  port: MessagePort,
  operationId: number,
  databaseOptions: OpenClawAgentDatabaseOptions,
  operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
  assertSourceCurrent?: () => void,
): Promise<T> {
  const withAdmission: OpenClawAgentDatabaseWriteAdmission = async (run) => {
    const admission = await new Promise<{
      allowed: boolean;
      validation?: OpenClawAgentDatabaseValidation;
      integrityRevoked?: boolean;
    }>((resolve, reject) => {
      const receive = (admissionMessage: {
        type: string;
        operationId: number;
        allowed: boolean;
        validation?: OpenClawAgentDatabaseValidation;
        integrityRevoked?: boolean;
      }) => {
        cleanup();
        resolve(admissionMessage);
      };
      const closed = () => {
        cleanup();
        reject(new Error("SQLite reclamation parent closed during database admission"));
      };
      const cleanup = () => {
        port.off("message", receive);
        port.off("close", closed);
      };
      port.on("message", receive);
      port.once("close", closed);
      port.postMessage({
        type: "admission-request",
        operationId,
      });
    });
    return run(
      () => {
        if (!admission.allowed) {
          throw new SqliteReclamationRequestRefusedError(
            "SQLite reclamation database admission was revoked",
          );
        }
        assertSourceCurrent?.();
      },
      admission.validation,
      admission.integrityRevoked,
    );
  };
  return withOpenClawAgentDatabaseAdmission(databaseOptions, withAdmission, operation);
}
