import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { expect, test } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
} from "../../../../extensions/qa-lab/api.js";
import type { SessionsListResult } from "../../../../src/gateway/session-utils.types.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaPreparedRepoCliCommand } from "../../../helpers/qa-prepared-repo-cli.js";

type JsonObject = Record<string, unknown>;
const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CHAT_ID = -1001234;
const FILE_NAME = "qa-empty-response-side-effect.txt";
const FILE_CONTENT = "side effect completed once\n";
const RECOVERY_INSTRUCTION =
  "Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step:";

async function readRequest(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function succeed(res: ServerResponse, result: unknown = true) {
  writeJson(res, 200, { ok: true, result });
}

test("delivers a recovered artifact once while preserving its inter-session transcript", async ({
  signal,
  onTestFailed,
  onTestFinished,
}) => {
  const started = performance.now();
  let phase = "test-enter";
  let reported = false;
  let providerRequests = 0;
  let updateDelivered = false;
  const sends: JsonObject[] = [];
  const documents: Array<{ chatId: string; name: string; content: string }> = [];
  const pendingPolls = new Set<ServerResponse>();
  const writeCalls: JsonObject[] = [];
  const toolCalls: JsonObject[] = [];
  const completedWrites: JsonObject[] = [];
  const finalizers: JsonObject[] = [];
  const markerResponses: boolean[] = [];
  let overloads = 0;
  const marker = `QA-RECOVERED-ARTIFACT-${randomUUID()}`;
  // Raw stderr remains visible under the E2E configuration silent mode.
  const emitPhase = (event: "enter" | "failure") => {
    process.stderr.write(
      `[qa-phase] ${JSON.stringify({
        event,
        phase,
        elapsedMs: Math.round(performance.now() - started),
        providerRequests,
        updateDelivered,
        sends: sends.length,
        documents: documents.length,
        writes: writeCalls.length,
        finalizers: finalizers.length,
        overloads,
      })}\n`,
    );
  };
  const enterPhase = (next: string) => {
    phase = next;
    emitPhase("enter");
  };
  const report = () => {
    if (reported) {
      return;
    }
    reported = true;
    emitPhase("failure");
  };
  signal.addEventListener("abort", report, { once: true });
  onTestFailed(report);
  onTestFinished(() => signal.removeEventListener("abort", report));
  emitPhase("enter");
  enterPhase("mock-start");
  const mock = await startQaMockOpenAiServer();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const raw = await readRequest(req);
    if (pathname.startsWith("/v1/")) {
      const body = raw.length ? (JSON.parse(raw.toString()) as JsonObject) : {};
      const input = (body.input ?? []) as JsonObject[];
      const modelRequest = pathname === "/v1/responses";
      if (modelRequest) {
        providerRequests += 1;
      }
      // A finalizer carries historical tool output too. Its current instruction
      // must take precedence over the original failed continuation.
      const finalizer =
        modelRequest &&
        JSON.stringify(input.findLast((item) => item.role === "user")?.content)?.includes(
          RECOVERY_INSTRUCTION,
        );
      const completedWrite = input.find(
        (item) =>
          (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
          writeCalls.some((call) => call.call_id === item.call_id),
      );
      if (finalizer) {
        finalizers.push(body);
      } else if (modelRequest && completedWrite) {
        completedWrites.push(completedWrite);
        overloads += 1;
        writeOpenAiResponsesSse(res, [
          {
            type: "response.failed",
            response: {
              id: "qa-overload",
              object: "response",
              status: "failed",
              output: [],
              error: {
                code: "server_is_overloaded",
                message: "QA capacity failure after completed write",
              },
            },
          },
        ]);
        return;
      }
      const upstream = await fetch(`${mock.baseUrl}${pathname}`, {
        method: req.method,
        ...(raw.length ? { body: raw.toString() } : {}),
        headers: {
          "content-type": "application/json",
          ...(typeof req.headers.session_id === "string"
            ? { session_id: req.headers.session_id }
            : {}),
          ...(typeof req.headers["x-session-affinity"] === "string"
            ? { "x-session-affinity": req.headers["x-session-affinity"] }
            : {}),
        },
      });
      const payload = await upstream.text();
      if (modelRequest) {
        const events = payload
          .split("\n")
          .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
          .map((line) => JSON.parse(line.slice(6)) as JsonObject);
        for (const event of events) {
          const item = event.item as JsonObject | undefined;
          if (
            event.type === "response.output_item.done" &&
            item &&
            (item.type === "function_call" || item.type === "custom_tool_call")
          ) {
            toolCalls.push(item);
            if (JSON.stringify(item).includes(FILE_NAME)) {
              writeCalls.push(item);
            }
          }
        }
        if (
          events.some(
            (event) =>
              event.type === "response.output_text.done" && String(event.text).includes(marker),
          )
        ) {
          markerResponses.push(finalizer);
        }
      }
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(payload);
      return;
    }

    const [, token = "", method = ""] = pathname.match(/^\/bot([^/]+)\/([^/]+)$/) ?? [];
    if (token !== BOT_TOKEN) {
      writeJson(res, 401, { ok: false });
      return;
    }
    if (method === "sendDocument") {
      const form = await new Response(new Uint8Array(raw), {
        headers: { "content-type": String(req.headers["content-type"]) },
      }).formData();
      // grammY names the upload separately and sends its attachment reference in document.
      const reference = form.get("document");
      if (typeof reference !== "string" || !reference.startsWith("attach://")) {
        throw new Error("Telegram document did not reference a multipart upload");
      }
      const document = form.get(reference.slice("attach://".length));
      expect(document).toBeInstanceOf(File);
      const file = document as File;
      const chatId = form.get("chat_id");
      if (typeof chatId !== "string") {
        throw new Error("Telegram document delivery requires a string chat_id");
      }
      documents.push({
        chatId,
        name: file.name,
        content: await file.text(),
      });
      succeed(res, {
        message_id: 20_000 + documents.length,
        date: 1_754_000_000,
        chat: { id: CHAT_ID, type: "supergroup" },
        document: { file_id: "qa-file", file_unique_id: "qa-file", file_name: file.name },
      });
      return;
    }
    const body = raw.length ? (JSON.parse(raw.toString()) as JsonObject) : {};
    if (method === "getMe") {
      succeed(res, { id: 424242, is_bot: true, first_name: "QA", username: "qa_artifact_bot" });
    } else if (method === "getUpdates") {
      if (!updateDelivered) {
        updateDelivered = true;
        succeed(res, [
          {
            update_id: 1,
            message: {
              message_id: 456,
              date: 1_754_000_000,
              chat: { id: CHAT_ID, type: "supergroup", title: "QA" },
              from: { id: 777, is_bot: false, first_name: "QA" },
              text: "Reply with exactly `TELEGRAM-ROUTE-READY`.",
            },
          },
        ]);
      } else {
        pendingPolls.add(res);
        req.on("close", () => pendingPolls.delete(res));
      }
    } else if (method === "sendMessage") {
      sends.push(body);
      succeed(res, {
        message_id: 10_000 + sends.length,
        date: 1_754_000_000,
        chat: { id: CHAT_ID, type: "supergroup" },
        text: body.text,
      });
    } else {
      succeed(res);
    }
  };

  try {
    enterPhase("http-start");
    await withServer(
      (req, res) => {
        void handleRequest(req, res).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          writeJson(res, 500, {
            ok: false,
            error_code: 500,
            description: sliceUtf16Safe(
              redactSensitiveText(message.replaceAll(BOT_TOKEN, "<bot-token>"), { mode: "tools" }),
              0,
              2_048,
            ),
          });
        });
      },
      async (apiRoot) => {
        enterPhase("temp-dir-start");
        return await withTempDir("openclaw-recovered-artifact-", async (workspace) => {
          // Exercise terminal recovery after one failed provider attempt, without
          // changing default retry behavior or replaying the completed write.
          await mkdir(path.join(workspace, ".openclaw"), { recursive: true });
          await writeFile(
            path.join(workspace, ".openclaw", "settings.json"),
            JSON.stringify({ retry: { provider: { maxRetries: 0 } } }),
          );
          const owner = createQaGatewayChild();
          await runQaGatewayFixture(
            async () => {
              const repoRoot = path.resolve(import.meta.dirname, "../../../..");
              enterPhase("gateway-start");
              const gateway = await owner.start({
                onListening: () => enterPhase("gateway-listening"),
                repoRoot,
                command: createQaPreparedRepoCliCommand(repoRoot),
                forcedRuntime: "codex",
                providerMode: "mock-openai",
                providerBaseUrl: `${apiRoot}/v1`,
                mockSessionObserverUrl: mock.sessionObserverUrl,
                transportBaseUrl: apiRoot,
                transport: {
                  requiredPluginIds: ["telegram"],
                  createGatewayConfig: () => ({
                    channels: {
                      telegram: {
                        enabled: true,
                        defaultAccount: "proof",
                        accounts: {
                          proof: {
                            enabled: true,
                            botToken: BOT_TOKEN,
                            apiRoot,
                            groupPolicy: "open",
                            groups: {
                              [String(CHAT_ID)]: { groupPolicy: "open", requireMention: false },
                            },
                            streaming: { mode: "off" },
                            commands: { native: false },
                          },
                        },
                      },
                    },
                  }),
                },
                controlUiEnabled: false,
                runtimeEnvPatch: {
                  OPENCLAW_SKIP_CHANNELS: undefined,
                  OPENCLAW_SKIP_PROVIDERS: undefined,
                  OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
                  TELEGRAM_BOT_TOKEN: undefined,
                },
                mutateConfig: (cfg) => {
                  cfg.agents!.defaults!.workspace = workspace;
                  cfg.bindings = [
                    ...(cfg.bindings ?? []),
                    { agentId: "qa", match: { channel: "telegram", accountId: "proof" } },
                  ];
                  return cfg;
                },
              });
              enterPhase("gateway-ready");
              enterPhase("route-seed");
              const sessions = async () =>
                (await gateway.call("sessions.list", {
                  agentId: "qa",
                  limit: 100,
                })) as SessionsListResult;
              await expect
                .poll(
                  () =>
                    sends.some(
                      (send) =>
                        String(send.chat_id) === String(CHAT_ID) &&
                        send.text === "TELEGRAM-ROUTE-READY",
                    ),
                  { timeout: 30_000 },
                )
                .toBe(true);
              const matchingSessions = (await sessions()).sessions.filter(
                (row) =>
                  row.lastChannel === "telegram" &&
                  row.lastTo === `telegram:${CHAT_ID}` &&
                  row.lastAccountId === "proof",
              );
              expect(matchingSessions).toHaveLength(1);
              const session = matchingSessions[0];
              expect(session?.key).toBeTypeOf("string");
              const sessionKey = session!.key;
              await expect
                .poll(
                  async () =>
                    (await sessions()).sessions.find((row) => row.key === sessionKey)?.hasActiveRun,
                  { timeout: 30_000 },
                )
                .toBe(false);
              expect(documents).toHaveLength(0);
              enterPhase("turn");
              const turnLogMark = gateway.markLogs();
              const receipt = (await gateway.call("chat.send", {
                sessionKey,
                message: `Empty response after write recovery QA check: write ${FILE_NAME}, then reply with exact marker: \`${marker}\nMEDIA:./${FILE_NAME}\`.`,
                deliver: false,
                idempotencyKey: randomUUID(),
                systemInputProvenance: {
                  kind: "inter_session",
                  sourceTool: "sessions_send",
                  sourceSessionKey: "agent:qa:artifact-requester",
                },
              })) as { runId: string };
              expect(receipt.runId).toBeTypeOf("string");
              const waited = await gateway.call(
                "agent.wait",
                { runId: receipt.runId, timeoutMs: 30_000 },
                { timeoutMs: 35_000 },
              );
              if (isRecord(waited) && waited.status !== "ok") {
                const terminal = isRecord(waited.terminalReceipt) ? waited.terminalReceipt : {};
                const delivery = isRecord(waited.terminalDelivery) ? waited.terminalDelivery : {};
                const reply = isRecord(waited.terminalReply) ? waited.terminalReply : {};
                const sanitize = (text: string) =>
                  redactSensitiveText(
                    text
                      .replaceAll(BOT_TOKEN, "<bot-token>")
                      .replaceAll(gateway.token, "<gateway-token>")
                      .replaceAll(workspace, "<workspace>")
                      .replaceAll(gateway.tempRoot, "<gateway-temp>")
                      .replaceAll(repoRoot, "<repo>"),
                    { mode: "tools" },
                  );
                // Capture producer-owned terminal facts before fixture cleanup replaces the phase.
                // A finalizer request proves admission only; marker responses prove generated output.
                process.stderr.write(
                  `[qa-turn-failure] ${sanitize(
                    JSON.stringify({
                      phase,
                      status: waited.status,
                      error:
                        typeof waited.error === "string"
                          ? sliceUtf16Safe(sanitize(waited.error), 0, 2_048)
                          : undefined,
                      stopReason: waited.stopReason,
                      timeoutPhase: waited.timeoutPhase,
                      providerStarted: waited.providerStarted,
                      terminalReceipt: {
                        present: isRecord(waited.terminalReceipt),
                        terminalDisposition: terminal.terminalDisposition,
                        sourceReplyDelivered: terminal.sourceReplyDelivered,
                        rerouted: terminal.rerouted,
                      },
                      terminalDelivery: {
                        status: delivery.status,
                        resultCount: delivery.resultCount,
                      },
                      terminalReply: { disposition: reply.disposition },
                      markerResponses: markerResponses.slice(-20),
                      completedWrites: completedWrites.length,
                      finalizerRequests: finalizers.length,
                      documents: documents.length,
                    }),
                  )}\n[qa-turn-logs] ${JSON.stringify(
                    sliceUtf16Safe(sanitize(gateway.readLogsSince(turnLogMark)), -8_192),
                  )}\n`,
                );
              }
              expect(waited).toMatchObject({ status: "ok" });
              await expect.poll(() => documents.length, { timeout: 30_000 }).toBe(1);
              enterPhase("delivery-observed");
              const history = (await gateway.call("chat.history", { sessionKey, limit: 30 })) as {
                messages: Array<{ role: string; content: unknown }>;
              };
              expect(
                history.messages.filter(
                  (message) =>
                    message.role === "assistant" &&
                    JSON.stringify(message.content).includes(marker),
                ),
              ).toHaveLength(1);
              await expect
                .poll(
                  async () =>
                    (await sessions()).sessions.find((row) => row.key === sessionKey)?.hasActiveRun,
                  { timeout: 30_000 },
                )
                .toBe(false);
              expect(await readFile(path.join(workspace, FILE_NAME), "utf8")).toBe(FILE_CONTENT);
              enterPhase("cleanup");
              // Freeze delivery evidence only after the admitted run settles and its
              // Gateway exits; the provider and Telegram endpoint remain available.
              await stopQaGatewayFixture(owner);
              expect(toolCalls).toHaveLength(1);
              expect(writeCalls).toHaveLength(1);
              expect(completedWrites).toHaveLength(1);
              expect(completedWrites[0]?.call_id).toBe(writeCalls[0]?.call_id);
              expect(overloads).toBe(1);
              expect(finalizers).toHaveLength(1);
              expect(finalizers[0]?.tools ?? []).toEqual([]);
              expect(JSON.stringify(finalizers[0]?.input)).toContain(
                "Tools are unavailable in this step: it is a text-only pass",
              );
              expect(markerResponses).toEqual([true]);
              expect(documents).toEqual([
                { chatId: String(CHAT_ID), name: FILE_NAME, content: FILE_CONTENT },
              ]);
            },
            () => {
              enterPhase("cleanup");
              return stopQaGatewayFixture(owner);
            },
            () => {
              for (const poll of pendingPolls) {
                poll.destroy();
              }
            },
          );
        });
      },
    );
  } finally {
    await mock.stop();
  }
}, 120_000);
