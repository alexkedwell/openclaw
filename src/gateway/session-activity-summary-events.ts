import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { sessionEventPublicationRows } from "./session-event-prepared-row.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { identity } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const pendingSummaries = new WeakMap<SessionRowProjection, Map<string, Promise<void>>>();

export async function broadcastSessionActivitySummary(
  target: { key: string; agentId: string; storePath: string },
  params: {
    getSessionRowProjection?: () => SessionRowProjection | undefined;
    broadcast: GatewayBroadcastFn;
  },
): Promise<void> {
  const projection = params.getSessionRowProjection?.();
  const query = { key: target.key, agentId: target.agentId, storePath: target.storePath };
  const captured = projection?.capture(query);
  const key = captured ? identity(captured) : undefined;
  const previous = projection && key ? pendingSummaries.get(projection)?.get(key) : undefined;
  if (previous) {
    return previous;
  }
  let release: (() => void) | undefined;
  const publish = (read?: SessionRowReadView) => {
    // A new summary during delivery must not join the snapshot already being sent.
    release?.();
    if (projection && (!captured || !projection.isCurrent(captured))) {
      return;
    }
    const record = read?.describe(query);
    const row = record && read?.present(record);
    params.broadcast(
      "sessions.changed",
      {
        sessionKey: target.key,
        agentId: target.agentId,
        reason: "activity-summary",
        ...buildGatewaySessionSnapshot({
          sessionRow: row,
          agentId: target.agentId,
          includeSession: true,
        }),
      },
      {
        sessionKeys: [target.key],
        agentId: target.agentId,
        dropIfSlow: true,
        ...(read && projection
          ? { prepareSessionProjection: prepareSessionEventProjection(projection, read) }
          : {}),
      },
    );
  };
  if (projection) {
    const publications = sessionEventPublicationRows(projection);
    const work = publications.track(
      Promise.resolve().then(() =>
        publications.withReadyRows(() => [query], publish, { includeAncestors: true }),
      ),
    );
    if (captured && key) {
      const owner = pendingSummaries.get(projection) ?? new Map<string, Promise<void>>();
      pendingSummaries.set(projection, owner);
      owner.set(key, work);
      release = () => {
        if (owner.get(key) === work) {
          owner.delete(key);
        }
      };
    }
    try {
      await work;
    } finally {
      release?.();
    }
  } else {
    publish();
  }
}
