import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import {
  availableLinkReaders,
  availableLinkPreviewReaders,
} from "../../app/link-reader-routing.ts";
import "../../components/link-reader-hovercard-registration.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import { ChatComposerCapabilityDialogs } from "./chat-composer-capability-host.tsx";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { ChatProviderReviewDialog } from "./chat-provider-review-controller.tsx";
import { createSolidRenderLifecycle } from "./solid-render-lifecycle.ts";

function MountedChatPaneRuntime(props: { runtime: ChatPaneRuntime }) {
  const runtime = untrack(() => props.runtime);
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  onCleanup(() => gateway.dispose());
  const [presented, setPresented] = createSignal(runtime.presented);
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden");
  const visibilityChanged = () => runtime.requestUpdate();
  document.addEventListener("visibilitychange", visibilityChanged);
  const lifecycle = createSolidRenderLifecycle({
    host: runtime.element,
    presented: () => presented() && visible(),
    read: () => {
      runtime.prepareRender();
      return runtime.render();
    },
  });
  const unsubscribe = runtime.subscribe(() => {
    setVisible(document.visibilityState !== "hidden");
    setPresented(runtime.presented);
    lifecycle.invalidate();
  });
  const frame = createMemo(() => lifecycle.snapshot());
  createEffect(
    () => frame(),
    () => runtime.commitRender(),
  );
  onCleanup(() => {
    unsubscribe();
    document.removeEventListener("visibilitychange", visibilityChanged);
  });
  const sessionKey = () => {
    frame();
    return runtime.sessionKey;
  };
  const agentId = () => {
    frame();
    return runtime.agentId ?? parseAgentSessionKey(runtime.sessionKey)?.agentId;
  };
  return (
    <openclaw-link-reader-hovercard-provider
      prop:client={
        gateway.read().snapshot.phase === "connected" ? gateway.read().snapshot.client : null
      }
      prop:readers={availableLinkPreviewReaders(gateway.read().snapshot)}
      prop:claimedReaders={availableLinkReaders(gateway.read().snapshot)}
      prop:pagePreviewContext={context}
      prop:agentId={agentId()}
      prop:sessionKey={sessionKey()}
    >
      <LitContent value={frame().layout} />
      <ChatProviderReviewDialog controller={runtime.providerReview} revision={frame()} />
      <Show when={frame().capabilityDialogs}>
        {(dialogs) => <ChatComposerCapabilityDialogs {...dialogs()} />}
      </Show>
    </openclaw-link-reader-hovercard-provider>
  );
}

export function ChatPaneRuntimeView(props: { runtime: ChatPaneRuntime }) {
  const [ready, setReady] = createSignal(false);
  let initialized = false;
  onSettled(() => {
    if (!props.runtime.isConnected) {
      props.runtime.connectedCallback();
    }
    props.runtime.performUpdate();
    initialized = true;
    setReady(true);
  });
  onCleanup(() => {
    if (initialized) {
      props.runtime.disconnectedCallback();
    }
  });
  return (
    <Show when={ready()}>
      <MountedChatPaneRuntime runtime={props.runtime} />
    </Show>
  );
}
