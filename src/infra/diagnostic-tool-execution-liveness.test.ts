import { expect, it } from "vitest";
import {
  createDiagnosticToolExecutionLiveness,
  recordDiagnosticToolExecutionDeadline,
  registerDiagnosticToolExecutionDeadline,
} from "./diagnostic-tool-execution-liveness.js";

it("keeps fixed execution deadlines after an overlapping wait ends", () => {
  const invocation = createDiagnosticToolExecutionLiveness();
  try {
    invocation.run(() => {
      recordDiagnosticToolExecutionDeadline(100);
      const release = registerDiagnosticToolExecutionDeadline(200);
      expect(invocation.view.deadlineAtMs).toBe(200);
      release?.();
      expect(invocation.view.deadlineAtMs).toBe(100);
    });
  } finally {
    invocation.close();
  }
});
