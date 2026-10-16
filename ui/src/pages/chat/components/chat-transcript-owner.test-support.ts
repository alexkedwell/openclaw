import type { SolidControllerHost } from "../../../lib/reactive/solid-controller-host.ts";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import type { TranscriptCallbacks } from "./chat-transcript-session.ts";

/** Keep existing DOM fixtures' lifecycle vocabulary outside the production owner. */
export function createTranscriptTestOwner(
  host: SolidControllerHost,
  paneId: () => string,
  callbacks?: TranscriptCallbacks,
) {
  const owner = createChatTranscript(() => host.requestUpdate(), paneId, callbacks);
  const lifecycle = {
    hostConnected: owner.start,
    hostUpdated: owner.update,
    hostDisconnected: owner.dispose,
  };
  host.addController(lifecycle);
  return Object.assign(owner, lifecycle);
}

export type TestChatTranscript = ReturnType<typeof createTranscriptTestOwner>;
