import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
  type MarkdownFileLinkTarget,
} from "../../../components/markdown-file-links.ts";
import {
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
  type SessionLinkTarget,
} from "../../../components/markdown-session-links.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";

export type ChatMarkdownNavigationCallbacks = {
  basePath?: string;
  onOpenSessionLink?: ((target: SessionLinkTarget) => void) | null;
  onOpenWorkspaceFile?: ((target: MarkdownFileLinkTarget) => void) | null;
};

export function handleChatMarkdownLinkClick(
  event: MouseEvent,
  callbacks: ChatMarkdownNavigationCallbacks,
): void {
  const file = markdownFileLinkFromEvent(event);
  if (file) {
    callbacks.onOpenWorkspaceFile?.(file);
    return;
  }
  const session = markdownSessionLinkFromEvent(event, callbacks.basePath ?? "");
  if (session && shouldHandleNavigationClick(event)) {
    event.preventDefault();
    callbacks.onOpenSessionLink?.(session);
  }
}

export function handleChatMarkdownLinkKeydown(
  event: KeyboardEvent,
  callbacks: ChatMarkdownNavigationCallbacks,
): boolean {
  const file = markdownFileLinkFromKeyboardEvent(event);
  if (file) {
    callbacks.onOpenWorkspaceFile?.(file);
    return true;
  }
  const session = markdownSessionLinkFromKeyboardEvent(event, callbacks.basePath ?? "");
  if (!session) {
    return false;
  }
  callbacks.onOpenSessionLink?.(session);
  return true;
}
