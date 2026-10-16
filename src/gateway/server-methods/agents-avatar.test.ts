// Exercise request validation and the real ClawHub client at the RPC boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { agentAvatarGenerateHandler } from "./agents-avatar.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const preview = {
  name: "Garden keeper",
  description: "A green Blobster with a watering can.",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="30" fill="#008844"/></svg>',
};

const fetchMock = vi.fn<typeof fetch>();

async function generate(
  params: Record<string, unknown>,
  authority: Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority" | "signal"> = {},
) {
  const respond = vi.fn();
  await agentAvatarGenerateHandler({
    req: { type: "req", id: "avatar-preview", method: "agents.avatar.generate" },
    params,
    respond,
    context: {} as GatewayRequestContext,
    client: null,
    isWebchatConnect: () => false,
    ...authority,
  });
  return respond;
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_CLAWHUB_URL", "http://127.0.0.1:3211");
  vi.stubEnv("CLAWHUB_TOKEN", "synthetic-clawhub-token");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json(preview));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("agents.avatar.generate", () => {
  it.each(["revoked", "disconnected"] as const)(
    "checks retained device authority after credential lookup: %s",
    async (change) => {
      const context = {};
      const connection = new AbortController();
      const authority = captureGatewayDeviceRevocation(
        context,
        { deviceId: "creator-device", role: "operator" },
        () => true,
        connection.signal,
      );
      try {
        const pending = generate(
          { prompt: "A gardener" },
          { hasCurrentClientAuthority: authority.isCurrent },
        );
        if (change === "revoked") {
          invalidateGatewayDeviceRevocation(context, "creator-device", "operator");
          expect(await pending).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ message: expect.stringContaining("access changed") }),
          );
          expect(fetchMock).not.toHaveBeenCalled();
        } else {
          // An admitted request retains authority through ordinary socket loss.
          connection.abort();
          expect(await pending).toHaveBeenCalledWith(true, preview, undefined);
          expect(fetchMock).toHaveBeenCalledTimes(1);
        }
      } finally {
        authority.release();
      }
    },
  );

  it("posts only approved text to the local ClawHub with server-side authentication", async () => {
    const prompt = "Garden keeper\nOnly this text is approved for sharing.";
    expect(await generate({ prompt })).toHaveBeenCalledWith(true, preview, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toEqual(new URL("http://127.0.0.1:3211/api/v1/blobsters/generate"));
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ prompt }));
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-clawhub-token");
  });

  it.each([
    { label: "missing prompt", params: {} },
    { label: "empty prompt", params: { prompt: "" } },
    { label: "blank prompt", params: { prompt: " \n\t" } },
    { label: "oversized prompt", params: { prompt: "a".repeat(8_001) } },
    { label: "agent context", params: { prompt: "A gardener", agentId: "private-agent" } },
    { label: "SOUL context", params: { prompt: "A gardener", soul: "Unapproved context" } },
  ])("rejects $label before requesting generation", async ({ params }) => {
    expect(await generate(params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { body: JSON.stringify({ ...preview, svg: null }), message: "invalid avatar preview" },
    {
      body: JSON.stringify({ ...preview, svg: "x".repeat(128_001) }),
      message: "invalid avatar preview",
    },
    { body: "x".repeat(256 * 1024 + 1), message: "response exceeded" },
  ])(
    "rejects malformed or oversized responses without retrying: $message",
    async ({ body, message }) => {
      fetchMock.mockImplementation(async () => new Response(body));
      expect(await generate({ prompt: "A gardener" })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining(message) }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("surfaces ClawHub sign-in failure without replaying generation", async () => {
    fetchMock.mockImplementation(
      async () => new Response("Sign in to generate a Blobster.", { status: 401 }),
    );
    expect(await generate({ prompt: "A gardener" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Sign in to generate a Blobster."),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
