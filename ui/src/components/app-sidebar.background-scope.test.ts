/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  createSidebarElement,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { childToggle, mountRoster } from "./app-sidebar-freshness.test-support.ts";
import {
  storeSidebarSessionStatusFilter,
  storeSidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";
import "./app-sidebar.tsx";

const row = (key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  ...fields,
});
const result = (rows: GatewaySessionRow[], timestamp = 1) => sessionsResult(rows, timestamp);
const parent = (key: string, child: string) => row(key, { childSessions: [child] });
const childrenOf = (rows: GatewaySessionRow[], key: unknown) =>
  result(
    rows.filter((entry) => entry.spawnedBy === key),
    2,
  );
const tick = async (sidebar: Awaited<ReturnType<typeof mountRoster>>["sidebar"], ms = 50) => {
  await settleLitElement(sidebar);
  await vi.advanceTimersByTimeAsync(ms);
};
function cleanup({ provider, context, sessions }: Awaited<ReturnType<typeof mountRoster>>) {
  provider.remove();
  context.connectionBootstrap.reset();
  sessions.dispose();
}
function mountBackground(
  list: (params: Record<string, unknown> | null | undefined) => unknown,
  rows?: () => GatewaySessionRow[],
) {
  return mountRoster(async (method, raw) => {
    const params = asOptionalRecord(raw);
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.describe" && rows) {
      return { session: rows().find((entry) => entry.key === params?.key) ?? null };
    }
    return method === "sessions.list" ? list(params) : {};
  }, TWO_AGENTS);
}

it("restores identical rows after a filter-menu close renders the pending list", async () => {
  vi.useFakeTimers();
  storeSidebarSessionStatusFilter("all");
  const archivedRow: GatewaySessionRow = {
    key: "agent:main:archived",
    kind: "direct",
    displayName: "Archived conversation",
    archived: true,
  };
  const response = sessionsResult([archivedRow], 1);
  const pending = deferred<ReturnType<typeof sessionsResult>>();
  const { sidebar, context, provider, sessions } = await mountRoster(async (method, raw) => {
    const params = asOptionalRecord(raw);
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method !== "sessions.list") {
      return {};
    }
    return params?.archived === true
      ? pending.promise
      : params?.archived === "all"
        ? response
        : sessionsResult([], 0);
  }, TWO_AGENTS);
  let unsubscribe: (() => void) | undefined;
  try {
    sidebar.connected = true;
    await vi.advanceTimersByTimeAsync(50);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain(archivedRow.displayName);

    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    sidebar.sessionOrganizer.setSessionsStatusFilter("archived");
    // Menu dismissal renders the empty pending view before the shared data frame.
    sidebar.sidebarMenus.closePositionedMenu("sessionSort");
    await settleLitElement(sidebar);
    expect(sidebar.textContent).not.toContain(archivedRow.displayName);

    const published = deferred();
    unsubscribe = sessions.subscribeList(
      sidebar.sessionData.sessionListQuery("main"),
      (snapshot) => {
        if (!snapshot.loading && snapshot.result) {
          published.resolve();
        }
      },
    );
    pending.resolve(response);
    await published.promise;
    const pendingFrames = [...frames.values()];
    frames.clear();
    for (const callback of pendingFrames) {
      callback(performance.now());
    }
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain(archivedRow.displayName);
  } finally {
    unsubscribe?.();
    pending.resolve(response);
    provider.remove();
    context.connectionBootstrap.reset();
    sessions.dispose();
    vi.useRealTimers();
  }
});

it("discovers current child parents after background work was queued", async () => {
  const previousParent = parent("agent:main:previous-parent", "agent:main:previous-child");
  const nextParent = parent("agent:main:next-parent", "agent:main:next-child");
  const mainParent = parent("agent:main:main", "agent:main:main-child");
  const children = [previousParent, nextParent, mainParent].map((entry) =>
    row(entry.childSessions![0]!, {
      label: `${entry.key} child`,
      spawnedBy: entry.key,
    }),
  );
  let roots = [previousParent];
  const parents: unknown[] = [];
  const mounted = await mountBackground(
    (params) => {
      if (params?.spawnedBy) {
        parents.push(params.spawnedBy);
        return childrenOf(children, params.spawnedBy);
      }
      return result(roots);
    },
    () => [...roots, ...children],
  );
  const { sidebar, context, sessions, data } = mounted;
  try {
    context.connectionBootstrap.setForegroundRoute(undefined);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = previousParent.key;
    await settleLitElement(sidebar);
    expect(parents).toEqual([]);

    roots = [previousParent, nextParent, mainParent];
    sidebar.sessionKey = nextParent.key;
    await sessions.refresh({ agentId: "main", force: true });
    await settleLitElement(sidebar);
    expect(parents).toEqual([]);
    expect(childToggle(sidebar, previousParent.key)?.getAttribute("aria-expanded")).toBe("false");

    context.connectionBootstrap.setForegroundRoute(null);
    await waitForFast(() =>
      expect(parents).toEqual(expect.arrayContaining([nextParent.key, mainParent.key])),
    );
    await settleLitElement(sidebar);
    expect(parents).toHaveLength(2);
    expect(data.childSessionRowsByParent[previousParent.key]).toBeUndefined();
    expect(data.childSessionRowsByParent[mainParent.key]?.[0]?.key).toBe(
      mainParent.childSessions![0],
    );
    const expand = childToggle(sidebar, nextParent.key);
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
    expect(sidebar.textContent).toContain(`${nextParent.key} child`);
    expect(parents).toHaveLength(2);
  } finally {
    cleanup(mounted);
  }
});

it.each([false, true])(
  "loads selected filtered rosters before chat readiness (automatic first: %s)",
  async (automaticFirst) => {
    vi.useFakeTimers();
    const previous = deferred<ReturnType<typeof sessionsResult>>();
    const targets: unknown[] = [];
    let mainReads = 0;
    const archived = (agentId: string, label: string) =>
      result([row(`agent:${agentId}:archived`, { archived: true, label })]);
    const mounted = await mountBackground((params) => {
      if (params?.archived !== true) {
        return sessionsResult([], 0);
      }
      targets.push(params.agentId);
      if (params.agentId === "research") {
        return previous.promise;
      }
      return archived("main", `Main archived ${++mainReads}`);
    });
    const { sidebar, context } = mounted;
    try {
      sidebar.connected = true;
      await settleLitElement(sidebar);
      sidebar.sessionOrganizer.setSessionsStatusFilter("archived");
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Main archived 1");

      context.connectionBootstrap.setForegroundRoute("agent:research:pending");
      if (automaticFirst) {
        context.agentSelection.set("main");
      }
      context.agentSelection.set("research", { background: automaticFirst });
      await tick(sidebar);
      if (automaticFirst) {
        expect(targets).toEqual(["main"]);
        expect(sidebar.textContent).not.toContain("Main archived 1");
        context.connectionBootstrap.setForegroundRoute(null);
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(targets).toEqual(["main", "research"]);
      context.connectionBootstrap.setForegroundRoute("agent:main:pending");
      context.agentSelection.set("main");
      await tick(sidebar);
      previous.resolve(archived("research", "Stale Research archived"));
      await vi.advanceTimersByTimeAsync(50);
      await settleLitElement(sidebar);

      expect(sidebar.textContent).not.toContain("Stale Research archived");
      expect(targets).toEqual(["main", "research", "main"]);
      expect(sidebar.textContent).toContain("Main archived 2");
    } finally {
      previous.resolve(sessionsResult([], 0));
      cleanup(mounted);
    }
  },
);

it.each(["research", "main"])(
  "loads the next active parent's children when its agent is %s",
  async (nextAgent) => {
    vi.useFakeTimers();
    const mainParent = "agent:main:parent";
    const researchParent = `agent:${nextAgent}:next-parent`;
    const mainChild = "agent:main:child";
    const researchChild = `agent:${nextAgent}:next-child`;
    const rows = [
      parent(mainParent, mainChild),
      parent(researchParent, researchChild),
      row(mainChild, { label: "Stale Main child", spawnedBy: mainParent }),
      row(researchChild, { label: "Next child", spawnedBy: researchParent }),
    ];
    const previous = deferred<ReturnType<typeof sessionsResult>>();
    const parents: unknown[] = [];
    let primaryReads = 0;
    const mounted = await mountBackground(
      (params) => {
        if (params?.spawnedBy) {
          parents.push(params.spawnedBy);
          return params.spawnedBy === mainParent
            ? previous.promise
            : childrenOf(rows, params.spawnedBy);
        }
        primaryReads += 1;
        const knownParents =
          nextAgent === "main"
            ? [mainParent, researchParent]
            : [params?.agentId === "research" ? researchParent : mainParent];
        return result(rows.filter((entry) => knownParents.includes(entry.key)));
      },
      () => rows,
    );
    const { sidebar, context, sessions } = mounted;
    try {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = mainParent;
      sidebar.connected = true;
      await tick(sidebar);
      expect(parents).toEqual([mainParent]);

      context.agentSelection.set(nextAgent);
      sidebar.sessionKey = researchParent;
      if (nextAgent !== "main") {
        await sessions.refresh({ agentId: nextAgent, force: true });
      }
      await tick(sidebar);
      expect(primaryReads).toBe(nextAgent === "main" ? 1 : 2);
      previous.resolve(result(rows.filter((entry) => entry.key === mainChild)));
      await vi.advanceTimersByTimeAsync(50);
      await settleLitElement(sidebar);

      if (nextAgent !== "main") {
        expect(sidebar.textContent).not.toContain("Stale Main child");
      }
      expect(parents).toEqual([mainParent, researchParent]);
      const expand = childToggle(sidebar, researchParent);
      expect(expand).not.toBeNull();
      // Only the cross-agent roster discovers a new child after the initial baseline.
      expect(expand?.getAttribute("aria-expanded")).toBe(nextAgent === "main" ? "false" : "true");
      if (nextAgent === "main") {
        expand!.click();
      }
      await tick(sidebar, 0);
      expect(sidebar.textContent).toContain("Next child");
      expect(parents).toEqual([mainParent, researchParent]);
    } finally {
      previous.resolve(sessionsResult([], 0));
      cleanup(mounted);
    }
  },
);

it.each([
  ["ordinary overlap", false, false, "self"],
  ["queued initial fill", true, false, "self"],
  ["queued initial fill with a later event", true, true, "self"],
  ["saved owner", true, false, "owner"],
  ["saved involving me", true, false, "involving-me"],
] as const)(
  "paints filtered sessions before group metadata during %s",
  async (_name, holdSecondSlot, invalidate, filter) => {
    const actorId = "synthetic-operator";
    const owner: GatewaySessionRow["owner"] = { actor: { type: "human", id: actorId } };
    const matchesFilter = (query: Record<string, unknown> | null | undefined) =>
      filter === "involving-me" ? query?.involvingMe === true : query?.ownerId === actorId;
    const primary = deferred<ReturnType<typeof sessionsResult>>();
    const filtered = deferred<ReturnType<typeof sessionsResult>>();
    const groups = deferred<{ names: string[]; groups: never[]; sectionOrder: string[] }>();
    const unrelatedBootstrap = deferred();
    const laterBootstrap = deferred();
    const order: string[] = [];
    const listQueries: Record<string, unknown>[] = [];
    const primaryResult = result([row("agent:main:primary", { label: "Canonical session" })]);
    const ownedResult = (label: string, timestamp = 1) =>
      result([row("agent:main:mine", { label, owner })], timestamp);
    const filteredResult = ownedResult("My session");
    const emptyGroups = { names: [], groups: [], sectionOrder: [] };
    const gateway = createGatewayHarness(
      createTestGatewayClient(async (method, raw) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.groups.list") {
          order.push("groups:start");
          return groups.promise;
        }
        if (method !== "sessions.list") {
          return {};
        }
        if (params?.includeOwnerSessionCounts) {
          return { ...primaryResult, totalCount: 1, ownerSessionCounts: [] };
        }
        listQueries.push({ ...params });
        if (matchesFilter(params)) {
          order.push("filtered:start");
          if (invalidate && listQueries.filter(matchesFilter).length > 1) {
            return ownedResult("Updated session", 2);
          }
          return filtered.promise;
        }
        return primary.promise;
      }),
    );
    gateway.publish({
      phase: "connecting",
      selfUser: { id: actorId },
      hello: gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "sessions.groups.list"]),
    });
    const connectionBootstrap = createConnectionBootstrapCoordinator();
    const stopBootstrap = gateway.gateway.subscribe((snapshot) =>
      connectionBootstrap.synchronize({
        client: snapshot.client,
        connected: snapshot.phase === "connected",
      }),
    );
    const sessions = createSessionCapability(
      gateway.gateway,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      { connectionBootstrap },
    );
    const context = {
      ...createContext(gateway.gateway, sessions, TWO_AGENTS),
      connectionBootstrap,
    };
    gateway.publish({ phase: "connected" });
    const heldBootstrap = holdSecondSlot
      ? connectionBootstrap.run("unrelated-bootstrap", async () => {
          await unrelatedBootstrap.promise;
        })
      : Promise.resolve();
    const provider = createApplicationContextProvider(context);
    const sidebar = await createSidebarElement();
    if (filter !== "self") {
      storeSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, actorId, {
        ownerId: filter === "owner" ? actorId : null,
        involvingMe: filter === "involving-me",
      });
    }
    provider.append(sidebar.hostElement);
    document.body.append(provider);
    await settleLitElement(sidebar);
    const heldLater = invalidate
      ? connectionBootstrap.run("later-bootstrap", async () => {
          order.push("later:start");
          await laterBootstrap.promise;
        })
      : Promise.resolve();
    try {
      sidebar.connected = true;
      await settleLitElement(sidebar);
      expect(listQueries).toHaveLength(holdSecondSlot ? 1 : 2);
      expect(listQueries[0]).toMatchObject({ ownerFirst: true, agentId: "main" });
      expect(order).not.toContain("groups:start");

      primary.resolve(primaryResult);
      await vi.waitFor(() => expect(order).toContain("filtered:start"));
      await vi.waitFor(() =>
        expect(sessions.state.result?.sessions[0]?.label).toBe("Canonical session"),
      );
      expect(listQueries).toHaveLength(2);
      expect(listQueries[1]?.agentId).toBe(filter === "involving-me" ? "main" : undefined);
      expect(matchesFilter(listQueries[1])).toBe(true);

      filtered.resolve(filteredResult);
      await vi.waitFor(() => expect(sidebar.textContent).toContain("My session"));
      await vi.waitFor(() => expect(order).toContain("groups:start"));
      groups.resolve(emptyGroups);
      if (invalidate) {
        await vi.waitFor(() => expect(order).toContain("later:start"));
        expect(sidebar.textContent).toContain("My session");
        vi.useFakeTimers();
        gateway.publishEvent("sessions.changed", {
          sessionKey: "agent:main:unlisted",
          key: "agent:main:unlisted",
          agentId: "main",
          reason: "create",
        });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(listQueries.filter(matchesFilter)).toHaveLength(1);
        laterBootstrap.resolve();
        await heldLater;
      }
      await connectionBootstrap.run("queue-drained", async () => {});
      await settleLitElement(sidebar);
      expect(listQueries.filter(matchesFilter)).toHaveLength(invalidate ? 2 : 1);
      expect(sidebar.textContent).toContain(invalidate ? "Updated session" : "My session");
      expect(sessions.state.result?.sessions[0]?.label).toBe("Canonical session");
    } finally {
      primary.resolve(primaryResult);
      filtered.resolve(filteredResult);
      groups.resolve(emptyGroups);
      unrelatedBootstrap.resolve();
      laterBootstrap.resolve();
      await heldBootstrap;
      await heldLater;
      provider.remove();
      sessions.dispose();
      stopBootstrap();
      connectionBootstrap.reset();
    }
  },
);
