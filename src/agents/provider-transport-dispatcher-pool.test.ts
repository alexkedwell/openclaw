import { once } from "node:events";
import type { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import {
  closeProviderTransportDispatcherPool,
  fetchWithProviderHttpGuard,
} from "./provider-transport-dispatcher-pool.js";

afterEach(async () => {
  await closeProviderTransportDispatcherPool();
  vi.unstubAllEnvs();
});

it("keeps request credentials separate and closes reused sockets at host shutdown", async () => {
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  const sockets = new Set<Socket>();
  const closed: Promise<unknown>[] = [];
  await withServer(
    (request, response) => {
      if (!sockets.has(request.socket)) {
        sockets.add(request.socket);
        closed.push(once(request.socket, "close"));
      }
      request.resume();
      response.end(request.headers.authorization ?? "");
    },
    async (baseUrl) => {
      const request = async (credential: string) => {
        const result = await fetchWithProviderHttpGuard({
          url: baseUrl,
          policy: { allowPrivateNetwork: true },
          init: { headers: { Authorization: `Bearer ${credential}` } },
        });
        try {
          expect(await result.response.text()).toBe(`Bearer ${credential}`);
          return result.dispatcherReused;
        } finally {
          await result.release();
        }
      };

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await request(`synthetic-key-${attempt}`)).toBe(attempt > 0);
      }
      expect(sockets.size).toBeLessThan(5);

      await closeProviderTransportDispatcherPool();
      await Promise.all(closed);
      const previousConnections = sockets.size;
      expect(await request("synthetic-key-after-restart")).toBe(false);
      expect(sockets.size).toBe(previousConnections + 1);
    },
  );
});
