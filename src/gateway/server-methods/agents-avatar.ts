import {
  ErrorCodes,
  errorShape,
  validateAgentsAvatarGenerateParams,
  validateAgentsAvatarGenerateResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { fetchClawHubJson } from "../../infra/clawhub-client.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const agentAvatarGenerateHandler = defineValidatedGatewayMethod(
  "agents.avatar.generate",
  validateAgentsAvatarGenerateParams,
  async ({ params, respond, signal, hasCurrentClientAuthority }) => {
    // Only creator-approved text crosses this boundary. Workspace files and
    // identity persistence belong to their existing, explicit operations.
    const result = await fetchClawHubJson<unknown>({
      path: "/api/v1/blobsters/generate",
      method: "POST",
      json: { prompt: params.prompt },
      timeoutMs: 90_000,
      maxResponseBytes: 256 * 1024,
      fetchImpl: (input, init) => {
        // Token lookup yields; revocation must still prevent the paid request.
        signal?.throwIfAborted();
        if (hasCurrentClientAuthority?.() === false) {
          throw new Error("Avatar generation access changed. Reconnect and try again.");
        }
        return fetch(input, init);
      },
    });
    if (!validateAgentsAvatarGenerateResult(result)) {
      throw new Error("ClawHub returned an invalid avatar preview. Try generating again.");
    }
    respond(true, result, undefined);
  },
  (error) => errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)),
);
