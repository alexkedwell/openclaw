// OpenAI-compatible HTTP tests cover chat completions, streaming, tool calls,
// session context, auth scopes, and provider error mapping.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createClientToolNameConflictError } from "../agents/agent-tool-definition-adapter.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { resolveEmbeddedRunTerminal } from "../agents/embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "../agents/embedded-agent-subscribe.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import { recordAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import {
  expectDeclaredHttpOwnerIdentity,
  expectHttpForeignSessionAuthority,
  expectSharedSecretHttpOwnerIdentity,
} from "./http-authority.test-support.js";
import {
  registerOpenAiHttpUploadTests,
  runOpenAiHttpImageInputCases,
} from "./http-input-media.test-support.js";
import {
  assistantSnapshotCases,
  streamingFailureCases,
  captureStreamingTerminals,
  emitResolvedStreamingFailure,
  incompatibleReplacementCases,
  compatibleReplacementCases,
  bufferedReplacementCases,
  emitIncompatibleAssistantReplacement,
  emitCompatibleAssistantReplacement,
  emitBufferedAssistantReplacement,
  emitEmbeddedLateCommentary,
  createOpenAiHttpTestClient,
  parseSseDataLines,
  readRawChatCompletionStream,
} from "./http-stream.test-support.js";
import { registerOpenAiHttpSamplingTests } from "./openai-http.sampling.test-support.js";
import { buildAssistantDeltaResult } from "./test-helpers.agent-results.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
  testState,
  withGatewayServer,
} from "./test-helpers.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let enabledServer: Awaited<ReturnType<typeof startGatewayServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
});

async function startSharedSecretServer(port: TestPortClaim, mode: "token" | "password") {
  return await startClaimedGateway(port, () =>
    startGatewayServer(port.port, {
      host: "127.0.0.1",
      auth:
        mode === "token"
          ? { mode: "token", token: "secret" }
          : { mode: "password", password: "secret" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
    }),
  );
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

function chatRequest(overrides: Record<string, unknown> = {}) {
  return { model: "openclaw", messages: [{ role: "user" as const, content: "hi" }], ...overrides };
}

function mockAgentOnce(payloads: Array<{ text: string }> = [{ text: "hello" }]) {
  agentCommandMock.mockClear();
  agentCommandMock.mockResolvedValueOnce({ payloads } as never);
}

function parseChatChunks(data: string[]) {
  return data
    .filter((line) => line !== "[DONE]")
    .map(
      (line) =>
        JSON.parse(line) as OpenAI.ChatCompletionChunk & {
          error?: { type?: string; message?: string };
        },
    );
}

function streamContent(chunks: OpenAI.ChatCompletionChunk[]) {
  return chunks
    .flatMap((chunk) => chunk.choices ?? [])
    .map((choice) => choice.delta?.content ?? "")
    .join("");
}

function createChatStream(content: string) {
  return createOpenAiHttpTestClient(enabledPort).chat.completions.create({
    model: "openclaw",
    messages: [{ role: "user", content }],
    stream: true,
  });
}

async function collectChatStream(stream: AsyncIterable<OpenAI.ChatCompletionChunk>) {
  let content = "";
  const finishReasons: Array<string | null> = [];
  for await (const chunk of stream) {
    for (const choice of chunk.choices) {
      content += choice.delta.content ?? "";
      finishReasons.push(choice.finish_reason);
    }
  }
  return { content, finishReasons };
}

async function expectChatError(
  res: Response,
  status: number,
  type: string,
  message: string | RegExp,
) {
  expect(res.status).toBe(status);
  const json = (await res.json()) as { error?: { type?: string; message?: string } };
  expect(json.error).toMatchObject({
    type,
    message: typeof message === "string" ? message : expect.stringMatching(message),
  });
}

function mockAgentRun(run: (runId: string) => unknown) {
  agentCommandMock.mockClear();
  agentCommandMock.mockImplementationOnce(((opts: unknown) => {
    const runId = (opts as { runId?: string }).runId;
    if (!runId) {
      throw new Error("expected a streaming chat-completion run ID");
    }
    return run(runId);
  }) as never);
}

function weatherCall() {
  return { id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' };
}

function toolResult(
  text: string | undefined,
  pendingToolCalls = [weatherCall()],
  agentMeta?: { usage: { input: number; output: number; total: number } },
) {
  return {
    payloads: text === undefined ? [] : [{ text }],
    meta: { stopReason: "tool_calls", pendingToolCalls, ...(agentMeta ? { agentMeta } : {}) },
  };
}

function functionTool(
  name: string,
  description: string,
  parameters: Record<string, unknown> = { type: "object", properties: {} },
  strict?: boolean,
): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: { name, description, parameters, ...(strict === undefined ? {} : { strict }) },
  };
}

function postChatCompletions(
  port: number,
  body: unknown = chatRequest(),
  headers?: Record<string, string>,
) {
  return postRawChatCompletions(port, JSON.stringify(body), headers);
}

async function postRawChatCompletions(
  port: number,
  body: string,
  headers?: Record<string, string>,
) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      ...headers,
    },
    body,
  });
}

async function drainStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  text: string,
) {
  let buffered = text;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return buffered + decoder.decode();
    }
    buffered += decoder.decode(value, { stream: true });
  }
}

type FirstAgentCommandOptions = Omit<AgentCommandOpts, "onAdmittedRunContext"> & {
  onAdmittedRunContext?: (context: object) => void | Promise<void>;
};

function firstAgentCommandOptions() {
  return agentCommandMock.mock.calls.at(0)?.[0] as FirstAgentCommandOptions | undefined;
}

describe("OpenAI-compatible HTTP API (e2e)", () => {
  beforeAll(async () => {
    const started = await startGatewayServerWithRetries({
      port: await getGatewayTestPort(),
      opts: {
        host: "127.0.0.1",
        auth: { mode: "none" },
        controlUiEnabled: false,
        openAiChatCompletionsEnabled: true,
      },
    });
    enabledPort = started.port;
    enabledServer = started.server;
  });

  afterAll(async () => {
    await enabledServer?.close({ reason: "openai http enabled suite done" });
  });

  registerOpenAiHttpUploadTests({
    getPort: () => enabledPort,
    postChatCompletions,
    firstAgentCommandOptions,
    agentCommandMock,
  });

  it.each([
    { stream: false, includeUsage: false },
    { stream: true, includeUsage: false },
    { stream: true, includeUsage: true },
  ])(
    "preserves the output-budget finish reason (stream=$stream, usage=$includeUsage)",
    async ({ stream, includeUsage }) => {
      const partialText = "Here is the first half of the answer";
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: "length",
        content: [{ type: "text", text: partialText }],
      });
      const resolved = await resolveEmbeddedRunTerminal(
        makeTerminalInput({
          attempt: makeEmbeddedRunnerAttempt({
            assistantTexts: [partialText],
            lastAssistant: assistant,
            currentAttemptAssistant: assistant,
            currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
          }),
          attemptAssistant: assistant,
          payloadsWithToolMedia: [{ text: partialText }],
        }),
      );
      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        throw new Error("expected a deliverable partial response");
      }
      expect(resolved.result.meta.stopReason).toBe("length");
      expect(resolved.result.meta.error).toBeUndefined();

      const continueAgent = createDeferred();
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        if (stream) {
          const runId = (opts as { runId: string }).runId;
          emitAgentEvent({ runId, stream: "assistant", data: { delta: partialText } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          await continueAgent.promise;
        }
        return recordAgentRunTerminalOutcome(resolved.result, "completed");
      }) as never);

      try {
        const response = await postChatCompletions(enabledPort, {
          stream,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          model: "openclaw",
          messages: [{ role: "user", content: "Explain the result." }],
        });
        expect(response.status).toBe(200);
        if (!stream) {
          const completion = (await response.json()) as OpenAI.ChatCompletion;
          expect(completion.choices[0]?.message.content).toContain(partialText);
          expect(completion.choices[0]?.finish_reason).toBe("length");
          return;
        }

        if (!response.body) {
          throw new Error("expected a streaming response body");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let wire = "";
        while (!wire.includes(partialText)) {
          const { done, value } = await reader.read();
          expect(done).toBe(false);
          wire += decoder.decode(value, { stream: true });
        }
        expect(wire).not.toContain("[DONE]");
        continueAgent.resolve();
        wire = await drainStream(reader, decoder, wire);
        const data = parseSseDataLines(wire);
        const chunks = parseChatChunks(data);
        const choices = chunks.flatMap((chunk) => chunk.choices);
        expect(choices.map((choice) => choice.delta.content ?? "").join("")).toContain(partialText);
        expect(choices.map((choice) => choice.finish_reason).filter(Boolean)).toEqual(["length"]);
        expect(chunks.filter((chunk) => chunk.usage)).toHaveLength(includeUsage ? 1 : 0);
        expect(data.filter((entry) => entry === "[DONE]")).toHaveLength(1);
        expect(data.at(-1)).toBe("[DONE]");
      } finally {
        continueAgent.resolve();
      }
    },
  );

  it.each(
    (
      [
        { name: "empty string", result: { role: "tool", tool_call_id: "call_1", content: "" } },
        { name: "whitespace", result: { role: "tool", tool_call_id: "call_1", content: " \n " } },
        { name: "empty array", result: { role: "tool", tool_call_id: "call_1", content: [] } },
        {
          name: "empty text part",
          result: { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "" }] },
        },
        { name: "legacy empty string", result: { role: "function", name: "lookup", content: "" } },
        { name: "legacy null", result: { role: "function", name: "lookup", content: null } },
      ] satisfies Array<{
        name: string;
        result: OpenAI.ChatCompletionToolMessageParam | OpenAI.ChatCompletionFunctionMessageParam;
      }>
    ).map(({ name, result }, index) => ({ name, result, stream: index === 0 })),
  )("continues a client tool result with $name (stream=$stream)", async ({ result, stream }) => {
    mockAgentOnce([{ text: "Lookup completed." }]);
    const client = createOpenAiHttpTestClient(enabledPort);
    const request = {
      model: "openclaw",
      messages: [
        { role: "user", content: "Check the account." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        result,
      ] satisfies OpenAI.ChatCompletionMessageParam[],
    };
    const response = stream
      ? await client.chat.completions.stream(request).finalChatCompletion()
      : await client.chat.completions.create(request);
    expect(response.choices[0]).toMatchObject({
      message: { content: "Lookup completed." },
      finish_reason: "stop",
    });
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const message = firstAgentCommandOptions()?.message;
    expect(message).toContain("tool_call id=call_1 name=lookup arguments={}");
    expect(message?.split(CURRENT_MESSAGE_MARKER)[1]).toBe(
      `\nTool:${result.role === "function" ? result.name : result.tool_call_id}: `,
    );
  });

  it.each([false, true])(
    "preserves each parallel client tool result (emptyFirst=%s)",
    async (emptyFirst) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "Both lookups completed." }],
      } as never);
      const results: OpenAI.ChatCompletionToolMessageParam[] = [
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "tool", tool_call_id: "call_2", content: "0" },
      ];
      const response = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
        model: "openclaw",
        messages: [
          { role: "user", content: "Compare the accounts." },
          {
            role: "assistant",
            content: null,
            tool_calls: ["call_1", "call_2"].map((id) => ({
              id,
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            })),
          },
          ...(emptyFirst ? results : results.toReversed()),
        ],
      });
      expect(response.choices[0]?.message.content).toBe("Both lookups completed.");
      const message = firstAgentCommandOptions()?.message;
      expect(message).toContain("Tool:call_1: ");
      expect(message).toContain("Tool:call_2: 0");
      expect(message?.split(CURRENT_MESSAGE_MARKER)[1]).toBe(
        emptyFirst ? "\nTool:call_2: 0" : "\nTool:call_1: ",
      );
    },
  );

  it.each([
    { role: "tool", tool_call_id: "call_1" },
    { role: "tool", tool_call_id: "call_1", content: 0 },
    { role: "tool", tool_call_id: "call_1", content: [null] },
    { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: 0 }] },
    { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "" }, {}] },
    { role: "tool", tool_call_id: " ", content: "" },
    { role: "function", name: "lookup" },
    { role: "function", name: "lookup", content: [] },
    { role: "function", content: null },
    { role: "user", content: "" },
  ])(
    "does not invent a client tool result for malformed or missing content: %j",
    async (message) => {
      agentCommandMock.mockClear();
      const response = await postChatCompletions(enabledPort, {
        model: "openclaw",
        messages: [message],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
      expect(agentCommandMock).not.toHaveBeenCalled();
    },
  );

  it("returns a typed selection error unless an ownerless fleet request selects an agent", async () => {
    try {
      testState.agentsConfig = {
        ownership: "explicit",
        entries: { main: {}, beta: {} },
      };
      resetConfigRuntimeState();
      agentCommandMock.mockClear();

      const missing = await postChatCompletions(enabledPort);
      expect(missing.status).toBe(400);
      const missingJson = (await missing.json()) as { error?: { message?: string; type?: string } };
      expect(missingJson.error?.type).toBe("invalid_request_error");
      expect(missingJson.error?.message).toContain("has no explicit owner");
      expect(agentCommandMock).not.toHaveBeenCalled();

      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
      const selected = await postChatCompletions(
        enabledPort,
        { model: "openclaw/default", messages: [{ role: "user", content: "hi" }] },
        { "x-openclaw-agent-id": "main" },
      );
      expect(selected.status).toBe(200);
      expect(firstAgentCommandOptions()?.sessionKey ?? "").toMatch(/^agent:main:/);
      await selected.text();
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it("handles request validation and routing", async () => {
    const port = enabledPort;
    const user = (content: unknown) => ({ role: "user", content });
    const getFirstAgentCall = () => firstAgentCommandOptions();
    const getFirstAgentMessage = () => getFirstAgentCall()?.message ?? "";
    const setAgents = (explicit = false) => {
      testState.agentsConfig = explicit
        ? { ownership: "explicit", entries: { main: {}, beta: {} } }
        : { entries: { main: {} } };
      resetConfigRuntimeState();
    };
    const dispatch = async (
      body: unknown = chatRequest(),
      headers?: Record<string, string>,
      text = "hello",
    ) => {
      mockAgentOnce([{ text }]);
      const response = await postChatCompletions(port, body, headers);
      expect(response.status).toBe(200);
      await response.text();
      return getFirstAgentCall();
    };
    const reject = async (
      body: unknown,
      message: string | RegExp,
      headers?: Record<string, string>,
      status = 400,
      type = "invalid_request_error",
    ) => {
      agentCommandMock.mockClear();
      await expectChatError(await postChatCompletions(port, body, headers), status, type, message);
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    };
    const expectInvalidRequestNoDispatch = (messages: unknown[]) =>
      reject(chatRequest({ messages }), "Invalid image_url content in `messages`.");
    const postSyncUserMessage = async (message: string) => {
      const res = await postChatCompletions(
        port,
        chatRequest({ stream: false, messages: [user(message)] }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as OpenAI.ChatCompletion;
    };
    const expectContext = (message: string, history: string[], current: string[]) => {
      for (const line of [HISTORY_CONTEXT_MARKER, ...history, CURRENT_MESSAGE_MARKER, ...current]) {
        expect(message).toContain(line);
      }
    };

    try {
      setAgents();
      const get = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "GET",
        headers: { authorization: "Bearer secret" },
      });
      expect(get.status).toBe(405);
      await get.text();

      mockAgentOnce();
      const withoutScopes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-openclaw-agent-id": "main" },
        body: JSON.stringify({ messages: [user("hi")] }),
      });
      expect(withoutScopes.status).toBe(200);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(getFirstAgentCall()).toMatchObject({ messageChannel: "webchat" });
      await withoutScopes.text();

      setAgents(true);
      for (const { body, headers } of [
        { body: chatRequest(), headers: { "x-openclaw-agent-id": "beta" } },
        { body: chatRequest({ model: "openclaw/beta" }), headers: undefined },
      ]) {
        expect(await dispatch(body, headers)).toMatchObject({
          sessionKey: expect.stringMatching(/^agent:beta:/),
        });
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
      }
      setAgents();
      expect(
        await dispatch(chatRequest({ model: "openclaw/default" }), {
          "x-openclaw-agent-id": "main",
        }),
      ).toMatchObject({ sessionKey: expect.stringMatching(/^agent:main:/) });
      expect(agentCommandMock).toHaveBeenCalledTimes(1);

      for (const { body, headers } of [
        { body: chatRequest(), headers: { "x-openclaw-agent-id": "missing-agent" } },
        { body: chatRequest({ model: "openclaw/missing-agent" }), headers: undefined },
      ]) {
        await reject(body, "Unknown agent 'missing-agent'.", headers);
      }
      await reject(
        chatRequest(),
        "`x-openclaw-session-key` cannot use reserved internal session namespaces.",
        {
          "x-openclaw-session-key": "agent:main:harness:codex:supervision:spoofed-native-thread",
        },
      );
      setAgents(true);
      expect(
        await dispatch(chatRequest(), {
          "x-openclaw-agent-id": "beta",
          "x-openclaw-session-key": "agent:beta:openai:custom",
        }),
      ).toMatchObject({ sessionKey: "agent:beta:openai:custom" });
      setAgents();
      await reject(
        chatRequest(),
        "`x-openclaw-session-key` cannot use reserved internal session namespaces.",
        {
          "x-openclaw-session-key": "agent:main:subagent:spoofed",
        },
      );
      expect(await dispatch(chatRequest({ user: "alice" }))).toMatchObject({
        sessionKey: expect.stringContaining("openai-user:alice"),
      });
      expect(
        await dispatch(chatRequest(), { "x-openclaw-message-channel": "custom-client-channel" }),
      ).toMatchObject({ messageChannel: "custom-client-channel" });
      const adminHeaders = { "x-openclaw-scopes": "operator.admin, operator.write" };
      expect(
        await dispatch(chatRequest(), { ...adminHeaders, "x-openclaw-model": "openai/gpt-5.4" }),
      ).toMatchObject({ model: "openai/gpt-5.4" });
      await writeGatewayConfig({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4" }, models: { "openai/gpt-5.4": {} } },
        },
      });
      expect(
        await dispatch(chatRequest(), { ...adminHeaders, "x-openclaw-model": "gpt-5.4" }),
      ).toMatchObject({ model: "gpt-5.4" });
      await writeGatewayConfig({});
      await reject(
        chatRequest({ model: "openai/" }),
        "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
      );
      await reject(
        chatRequest(),
        "missing scope: operator.admin",
        { "x-openclaw-model": "openai/gpt-5.4" },
        403,
        "forbidden",
      );
      await reject(chatRequest(), "Invalid `x-openclaw-model`.", {
        ...adminHeaders,
        "x-openclaw-model": "openai/",
      });
      expect(
        await dispatch(
          chatRequest({
            messages: [
              user([
                { type: "text", text: "hello" },
                { type: "input_text", text: "world" },
              ]),
            ],
          }),
        ),
      ).toMatchObject({ message: "hello\nworld" });

      await runOpenAiHttpImageInputCases({
        port,
        postChatCompletions,
        mockAgentOnce,
        getFirstAgentCall,
        getFirstAgentMessage,
        expectInvalidRequestNoDispatch,
      });
      await dispatch(
        chatRequest({ messages: [user("x".repeat(1_200_000))] }),
        undefined,
        "accepted",
      );
      await expectInvalidRequestNoDispatch([
        user([
          {
            type: "image_url",
            image_url: { url: "data:application/pdf;base64,QUJDRA==" },
          },
        ]),
      ]);
      await expectInvalidRequestNoDispatch([
        user(
          Array.from({ length: 9 }, () => ({
            type: "image_url",
            image_url: { url: "data:image/png;base64,QUJDRA==" },
          })),
        ),
      ]);

      const system = { role: "system", content: "You are a helpful assistant." };
      const weatherHistory = [
        user("What's the weather?"),
        { role: "assistant", content: "Checking the weather." },
      ];
      const weatherExpected = ["User: What's the weather?", "Assistant: Checking the weather."];
      for (const { messages, history, current } of [
        {
          messages: [
            system,
            user("Hello, who are you?"),
            { role: "assistant", content: "I am Claude." },
            user("What did I just ask you?"),
          ],
          history: ["User: Hello, who are you?", "Assistant: I am Claude."],
          current: ["User: What did I just ask you?"],
        },
        {
          messages: [system, ...weatherHistory, { role: "tool", content: "Sunny, 70F." }],
          history: weatherExpected,
          current: ["Tool: Sunny, 70F."],
        },
        {
          messages: [
            ...weatherHistory,
            {
              role: "tool",
              tool_call_id: "call_1",
              content: [{ type: "text", text: "Sunny, 70F." }],
            },
          ],
          history: weatherExpected,
          current: ["Tool:call_1: Sunny, 70F."],
        },
        {
          messages: [
            user("What's the weather?"),
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Taipei"}' },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_1",
              content: [{ type: "text", text: "Sunny, 70F." }],
            },
          ],
          history: [
            "User: What's the weather?",
            'Assistant: tool_call id=call_1 name=get_weather arguments={"city":"Taipei"}',
          ],
          current: ["Tool:call_1: Sunny, 70F."],
        },
      ]) {
        await dispatch(chatRequest({ messages }), undefined, "ok");
        expectContext(getFirstAgentMessage(), history, current);
      }
      await dispatch(chatRequest({ messages: [system, user("Hello")] }));
      const singleMessage = getFirstAgentMessage();
      expect(singleMessage).not.toContain(HISTORY_CONTEXT_MARKER);
      expect(singleMessage).not.toContain(CURRENT_MESSAGE_MARKER);
      expect(singleMessage).toBe("Hello");
      expect(
        await dispatch(
          chatRequest({
            messages: [{ role: "developer", content: system.content }, user("Hello")],
          }),
        ),
      ).toMatchObject({ extraSystemPrompt: system.content });
      const imageFollowup = await dispatch(
        chatRequest({
          messages: [
            user([
              { type: "text", text: "look at this" },
              { type: "image_url", image_url: { url: "https://example.com/image.png" } },
            ]),
            { role: "assistant", content: "Checking the image." },
            { role: "tool", content: "Vision tool says it is blue." },
          ],
        }),
        undefined,
        "tool follow-up ok",
      );
      expect(imageFollowup?.images).toBeUndefined();
      expectContext(
        getFirstAgentMessage(),
        ["User: look at this", "Assistant: Checking the image."],
        ["Tool: Vision tool says it is blue."],
      );
      expect(getFirstAgentMessage()).not.toContain("User sent image(s) with no text.");

      for (const mode of ["none", "auto"] as const) {
        const firstCall = await dispatch(
          chatRequest({
            tool_choice: mode,
            tools: [
              functionTool(
                "get_time",
                "Get current time",
                undefined,
                mode === "auto" ? true : undefined,
              ),
            ],
            messages: [user("time?")],
          }),
          undefined,
          `tool choice ${mode}`,
        );
        if (mode === "none") {
          expect(firstCall?.clientTools).toBeUndefined();
        } else {
          expect(firstCall?.clientTools).toHaveLength(1);
          expect(firstCall?.clientTools?.[0]).toMatchObject({
            type: "function",
            function: { name: "get_time", strict: true },
          });
          expect(firstCall).not.toHaveProperty("toolsAllow");
        }
      }
      const weatherTool = functionTool("get_weather", "Get current weather", {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      });
      for (const pinned of [true, false]) {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce(
          toolResult(pinned ? "tool choice function" : "tool choice required") as never,
        );
        const res = await postChatCompletions(
          port,
          chatRequest({
            tool_choice: pinned
              ? { type: "function", function: { name: "get_weather" } }
              : "required",
            tools: pinned
              ? [functionTool("get_time", "Get current time"), weatherTool]
              : [weatherTool],
            messages: [user("weather?")],
          }),
        );
        expect(res.status).toBe(200);
        const firstCall = getFirstAgentCall();
        expect(firstCall?.clientTools).toHaveLength(1);
        expect(firstCall?.clientTools?.[0]).toMatchObject({ function: { name: "get_weather" } });
        expect(firstCall?.extraSystemPrompt ?? "").toContain(
          pinned
            ? "You must call the get_weather tool"
            : "You must call one of the available tools",
        );
        expect(((await res.json()) as OpenAI.ChatCompletion).choices?.[0]?.finish_reason).toBe(
          "tool_calls",
        );
      }

      for (const pinned of [false, true]) {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce(
          (pinned
            ? toolResult("Calling a different tool.", [
                { id: "call_1", name: "get_time", arguments: "{}" },
              ])
            : { payloads: [{ text: "plain text despite required" }] }) as never,
        );
        const tools = [functionTool("get_weather", "Get current weather")];
        if (pinned) {
          tools.push(functionTool("get_time", "Get current time"));
        }
        const res = await postChatCompletions(
          port,
          chatRequest({
            tool_choice: pinned
              ? { type: "function", function: { name: "get_weather" } }
              : "required",
            tools,
            messages: [user("weather?")],
          }),
        );
        await expectChatError(
          res,
          502,
          "api_error",
          pinned
            ? /tool_choice required a get_weather tool call/
            : /tool_choice=required was not satisfied/,
        );
      }

      for (const { body, message } of [
        { body: { tool_choice: "required" }, message: /no tools were provided/ },
        {
          body: {
            tool_choice: { type: "function", function: { name: "missing_tool" } },
            tools: [functionTool("get_time", "Get current time")],
          },
          message: /unknown tool/,
        },
        {
          body: {
            tool_choice: {
              type: "allowed_tools",
              tools: [{ type: "function", function: { name: "x" } }],
            },
            tools: [functionTool("x", "x")],
          },
          message: /allowed_tools/,
        },
        {
          body: {
            tools: [
              {
                type: "function",
                name: "invalid_flat_shape",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
          message: /tool\.function is required/,
        },
      ]) {
        agentCommandMock.mockClear();
        const res = await postChatCompletions(
          port,
          chatRequest({
            ...body,
            messages: [{ role: "user", content: "weather?" }],
          }),
        );
        await expectChatError(res, 400, "invalid_request_error", message);
        expect(agentCommandMock).toHaveBeenCalledTimes(0);
      }

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockRejectedValueOnce(createClientToolNameConflictError(["exec"]));
        const res = await postChatCompletions(port, {
          stream: false,
          model: "openclaw",
          tools: [functionTool("exec", "conflicts with a built-in tool")],
          messages: [{ role: "user", content: "run command" }],
        });
        await expectChatError(res, 400, "invalid_request_error", "invalid tool configuration");
      }

      for (const withText of [true, false]) {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce(
          toolResult(
            withText ? "Let me check that." : undefined,
            withText
              ? [weatherCall(), { id: "call_2", name: "get_time", arguments: "{}" }]
              : [weatherCall()],
            withText ? { usage: { input: 10, output: 5, total: 15 } } : undefined,
          ) as never,
        );
        const tools = [
          functionTool("get_weather", "Get weather", {
            type: "object",
            properties: { city: { type: "string" } },
          }),
        ];
        if (withText) {
          tools.push(functionTool("get_time", "Get time"));
        }
        const res = await postChatCompletions(
          port,
          chatRequest({
            stream: false,
            tool_choice: "auto",
            tools,
            messages: [user("weather?")],
          }),
        );
        expect(res.status).toBe(200);
        const choice = ((await res.json()) as OpenAI.ChatCompletion).choices?.[0];
        expect(choice).toMatchObject({
          finish_reason: "tool_calls",
          message: { content: withText ? "Let me check that." : "" },
        });
        if (withText) {
          expect(choice?.message?.role).toBe("assistant");
          expect(choice?.message?.tool_calls).toEqual([
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Taipei"}' },
            },
            { id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } },
          ]);
          expect(choice?.message?.tool_calls?.some((call) => Object.hasOwn(call, "index"))).toBe(
            false,
          );
        } else {
          expect(choice?.message?.tool_calls).toHaveLength(1);
        }
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const json = await postSyncUserMessage("hi");
        expect(json.object).toBe("chat.completion");
        expect(Array.isArray(json.choices)).toBe(true);
        const msg = json.choices[0]?.message;
        expect(msg?.role).toBe("assistant");
        expect(msg?.content).toBe("hello");
      }

      {
        mockAgentRun(async (runId) => {
          const { session, emit } = createStubSessionHarness();
          subscribeEmbeddedAgentSession({ session, runId });
          emit({ type: "message_start", message: { role: "assistant" } });
          for (const delta of ["<", "final>Title\n", "Line one\nLine two</", "final>"]) {
            emitAssistantTextDelta({ emit, delta });
          }
          return { payloads: [{ text: "Title\nLine one\nLine two" }] };
        });

        const splitFinalRes = await postChatCompletions(port, chatRequest({ stream: true }));
        expect(splitFinalRes.status).toBe(200);
        const splitFinalText = await splitFinalRes.text();
        const splitFinalData = parseSseDataLines(splitFinalText);
        const splitFinalChunks = parseChatChunks(splitFinalData);
        const splitFinalContent = streamContent(splitFinalChunks);
        expect(splitFinalContent).toBe("Title\nLine one\nLine two");
        expect(splitFinalContent).not.toContain("<");
        expect(splitFinalContent).not.toContain("final>");
      }

      for (const { agentMeta, expected } of [
        {
          agentMeta: { usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 } },
          expected: {
            prompt_tokens: 30,
            completion_tokens: 5,
            total_tokens: 35,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        },
        {
          agentMeta: { lastCallUsage: { input: 80, output: 20, total: 100 } },
          expected: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
        },
        {
          agentMeta: {
            usage: {
              input: Number.POSITIVE_INFINITY,
              output: Number.NaN,
              cacheRead: 2,
              cacheWrite: Number.POSITIVE_INFINITY,
              total: Number.NaN,
            },
          },
          expected: {
            prompt_tokens: 2,
            completion_tokens: 0,
            total_tokens: 2,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        },
        {
          agentMeta: {
            usage: {
              input: Number.POSITIVE_INFINITY,
              output: Number.NaN,
              total: 123,
            },
          },
          expected: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 123 },
        },
      ]) {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({
          payloads: [{ text: "usage" }],
          meta: { agentMeta },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual(expected);
      }

      {
        mockAgentOnce([{ text: "" }]);
        const json = await postSyncUserMessage("hi");
        expect(json.choices[0]?.message.content).toBe("No response from OpenClaw.");
      }

      {
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [{ role: "system", content: "yo" }],
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
      }
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it("validates and forwards max_completion_tokens and max_tokens into streamParams", async () => {
    const port = enabledPort;
    const getRecordedAgentMaxTokens = () => firstAgentCommandOptions()?.streamParams?.maxTokens;

    const validCases: Array<[Record<string, unknown>, number | undefined]> = [
      [{ max_completion_tokens: 256 }, 256],
      [{ max_tokens: 128 }, 128],
      [{ max_completion_tokens: 64, max_tokens: 999 }, 64],
      [{ max_completion_tokens: null, max_tokens: 32 }, 32],
      [{ max_completion_tokens: 16, max_tokens: null }, 16],
      [{ max_completion_tokens: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER],
      [{}, undefined],
    ];
    for (const [body, expected] of validCases) {
      mockAgentOnce();
      const res = await postChatCompletions(port, chatRequest(body));
      const label = JSON.stringify(body);
      expect(res.status).toBe(200);
      expect(agentCommandMock, label).toHaveBeenCalledTimes(1);
      expect(getRecordedAgentMaxTokens(), label).toBe(expected);
      await res.text();
    }

    mockAgentOnce();
    const client = createOpenAiHttpTestClient(port);
    await client.chat.completions.create({
      model: "openclaw",
      max_completion_tokens: null,
      max_tokens: null,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(agentCommandMock, "SDK null fields").toHaveBeenCalledTimes(1);
    expect(getRecordedAgentMaxTokens(), "SDK null fields").toBeUndefined();
  });

  it("rejects malformed token caps before agent dispatch", async () => {
    const port = enabledPort;
    const expectRejected = async (
      body: Record<string, unknown> | string,
      field: string,
      label: string,
    ) => {
      agentCommandMock.mockClear();
      const res = await (typeof body === "string"
        ? postRawChatCompletions(port, body)
        : postChatCompletions(port, chatRequest(body)));
      expect(res.status, label).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error).toMatchObject({
        type: "invalid_request_error",
        message: expect.stringContaining(field),
      });
      expect(agentCommandMock, label).toHaveBeenCalledTimes(0);
    };
    for (const field of ["max_completion_tokens", "max_tokens"] as const) {
      for (const value of ["32", {}, [32], 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expectRejected({ [field]: value }, field, `${field}: ${JSON.stringify(value)}`);
      }
      await expectRejected(
        `{"model":"openclaw","messages":[{"role":"user","content":"hi"}],"${field}":1e309}`,
        field,
        `${field}: non-finite raw number`,
      );
    }
    await expectRejected(
      { max_completion_tokens: "64", max_tokens: 32 },
      "max_completion_tokens",
      "malformed current field with valid legacy field",
    );
    await expectRejected(
      { max_completion_tokens: 64, max_tokens: "32" },
      "max_tokens",
      "malformed legacy field with valid current field",
    );
  });

  registerOpenAiHttpSamplingTests({
    getPort: () => enabledPort,
    postChatCompletions,
    postRawChatCompletions,
    firstAgentCommandOptions,
    agentCommandMock,
  });

  it("forwards inbound stop into streamParams", async () => {
    for (const { stop, expected } of [
      { stop: "\n\n", expected: ["\n\n"] },
      { stop: ["User:", "Assistant:"], expected: ["User:", "Assistant:"] },
      { stop: undefined, expected: undefined },
    ]) {
      mockAgentOnce();
      const res = await postChatCompletions(
        enabledPort,
        chatRequest(stop === undefined ? {} : { stop }),
      );
      expect(res.status).toBe(200);
      const params = firstAgentCommandOptions()?.streamParams;
      if (expected) {
        expect(params).toMatchObject({ stop: expected });
      } else {
        expect(params).toBeUndefined();
      }
      await res.text();
    }
    for (const stop of [["a", "b", "c", "d", "e"], [""], [123], {}]) {
      agentCommandMock.mockClear();
      await expectChatError(
        await postChatCompletions(enabledPort, chatRequest({ stop })),
        400,
        "invalid_request_error",
        /stop/,
      );
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }
  });

  it.each([
    {
      name: "resolved terminal failure",
      meta: {
        error: { kind: "incomplete_turn", message: "raw provider detail should stay private" },
      },
      outcome: "failed",
      status: 500,
    },
    { name: "error stop", meta: { stopReason: "error" }, outcome: "failed", status: 500 },
    {
      name: "run-budget timeout without error metadata",
      meta: { aborted: false, timeoutPhase: "provider", providerStarted: true },
      outcome: "failed",
      status: 500,
    },
    { name: "completed run with an error payload", meta: {}, outcome: "completed", status: 200 },
  ] as const)("uses the recorded outcome for $name", async ({ meta, outcome, status }) => {
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce(
      recordAgentRunTerminalOutcome(
        { payloads: [{ text: "Command may have changed state", isError: true }], meta },
        outcome,
      ) as never,
    );

    const res = await postChatCompletions(enabledPort);
    expect(res.status).toBe(status);
    const body = await res.text();
    if (status === 500) {
      expect(JSON.parse(body)).toEqual({ error: { message: "internal error", type: "api_error" } });
      expect(body).not.toContain("raw provider detail should stay private");
    }
  });

  it.each(streamingFailureCases)(
    "rejects resolved streaming agent failures from $label",
    async ({ meta, expectedPhase, producerTerminal }) => {
      let runId: string | undefined;
      const { terminals, unsubscribe } = captureStreamingTerminals(() => runId);
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (options: unknown) => {
        runId = (options as { runId?: string }).runId;
        if (!runId) {
          throw new Error("expected a streaming chat-completion run ID");
        }
        return emitResolvedStreamingFailure(runId, { meta, producerTerminal });
      }) as never);

      try {
        const stream = await createChatStream("hi");
        const finishReasons: Array<string | null> = [];
        const content: string[] = [];
        await expect(async () => {
          for await (const chunk of stream) {
            finishReasons.push(...chunk.choices.map((choice) => choice.finish_reason));
            content.push(...chunk.choices.map((choice) => choice.delta.content ?? ""));
          }
        }).rejects.toMatchObject({
          error: { message: "internal error", type: "api_error" },
        });
        expect(finishReasons).not.toContain("stop");
        expect(content.join("")).toBe("partial answer");
        expect(terminals).toEqual([
          {
            phase: producerTerminal ? expectedPhase : "error",
            status: producerTerminal && meta.timeoutPhase ? "timeout" : "error",
          },
        ]);
      } finally {
        unsubscribe();
      }
    },
  );

  it("forwards response_format into streamParams", async () => {
    for (const { format, text } of [
      { format: { type: "json_object" }, text: "{}" },
      {
        format: { type: "json_schema", json_schema: { name: "test", schema: { type: "object" } } },
        text: "{}",
      },
      { format: { type: "text" }, text: "hello" },
      { format: undefined, text: "hello" },
    ]) {
      mockAgentOnce([{ text }]);
      const res = await postChatCompletions(
        enabledPort,
        chatRequest(format ? { response_format: format } : {}),
      );
      expect(res.status).toBe(200);
      const params = firstAgentCommandOptions()?.streamParams;
      if (format) {
        expect(params).toMatchObject({ responseFormat: { type: format.type } });
      } else {
        expect(params).toBeUndefined();
      }
      await res.text();
    }
    agentCommandMock.mockClear();
    const res = await postChatCompletions(
      enabledPort,
      chatRequest({ response_format: { type: "xml" } }),
    );
    await expectChatError(res, 400, "invalid_request_error", /response_format/);
    expect(agentCommandMock).toHaveBeenCalledTimes(0);
  });

  it.each([
    {
      name: "a split custom XML opener",
      deltas: ["<", "xiaohai-banli>milk tea</", "xiaohai-banli>"],
      expected: "<xiaohai-banli>milk tea</xiaohai-banli>",
    },
    {
      name: "literal script-like content",
      deltas: ["<", "script>alert('literal')</", "script>"],
      expected: "<script>alert('literal')</script>",
    },
  ])("preserves $name through the official OpenAI SDK SSE stream", async ({ deltas, expected }) => {
    mockAgentRun(async (runId) => {
      const { session, emit } = createStubSessionHarness();
      subscribeEmbeddedAgentSession({ session, runId });
      emit({ type: "message_start", message: { role: "assistant" } });
      for (const delta of deltas) {
        emitAssistantTextDelta({ emit, delta });
      }
      return { payloads: [{ text: expected }] };
    });

    const stream = await createChatStream("Preserve the literal output.");
    const { content, finishReasons } = await collectChatStream(stream);

    expect(content).toBe(expected);
    expect(finishReasons.at(-1)).toBe("stop");
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  });

  it.each(
    assistantSnapshotCases({
      name: "buffered leading content in cumulative assistant snapshots",
      events: [
        {
          text: "<xiaohai-banli>milk tea</xiaohai-banli>",
          delta: "xiaohai-banli>milk tea</xiaohai-banli>",
        },
      ],
      expected: "<xiaohai-banli>milk tea</xiaohai-banli>",
    }),
  )(
    "preserves $name in official SDK assistant streams",
    async ({ events, expected, resultTexts }) => {
      mockAgentRun(async (runId) => {
        for (const data of events) {
          emitAgentEvent({ runId, stream: "assistant", data });
        }
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        return { payloads: (resultTexts ?? [expected]).map((text) => ({ text })) };
      });

      const stream = await createChatStream("Preserve the full snapshot.");
      const { content, finishReasons } = await collectChatStream(stream);

      expect(content).toBe(expected);
      expect(finishReasons.at(-1)).toBe("stop");
    },
  );

  it.each([false, true])(
    "flushes same-turn assistant microtasks before the SSE done frame (held tools=%s)",
    async (heldTools) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(((opts: unknown) => {
        const runId = (opts as AgentCommandOpts | undefined)?.runId ?? "";
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: { delta: "start ", ...(heldTools ? { itemId: "answer-1" } : {}) },
        });
        const result = Promise.resolve({
          payloads: heldTools ? [] : [{ text: "start finish" }],
          ...(heldTools
            ? {
                meta: {
                  stopReason: "tool_calls",
                  pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
                },
              }
            : {}),
        });
        void result.then(() => {
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          void Promise.resolve().then(() => {
            emitAgentEvent({
              runId,
              stream: "assistant",
              data: heldTools
                ? {
                    itemId: "answer-2",
                    text: "start finish",
                    delta: "",
                    replace: true,
                    replaceable: true,
                  }
                : { delta: "finish" },
            });
          });
        });
        return result;
      }) as never);

      const res = await postChatCompletions(enabledPort, {
        stream: true,
        model: "openclaw",
        messages: [{ role: "user", content: "Finish the streamed response." }],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const data = parseSseDataLines(await res.text());
      expect(data.at(-1)).toBe("[DONE]");
      const chunks = parseChatChunks(data);
      const content = streamContent(chunks);
      expect(content).toBe("start finish");
      const finishChoice = chunks.flatMap((chunk) => chunk.choices ?? []).at(-1);
      expect(finishChoice?.finish_reason).toBe(heldTools ? "tool_calls" : "stop");
      if (heldTools) {
        const choices = chunks.flatMap((chunk) => chunk.choices ?? []);
        const textIndex = choices.findLastIndex(
          (choice) => typeof choice.delta?.content === "string",
        );
        const toolIndex = choices.findIndex((choice) => Array.isArray(choice.delta?.tool_calls));
        expect(toolIndex).toBeGreaterThan(textIndex);
      }
    },
  );

  it.each([
    { name: "resolved", reject: false, consumer: "SDK" },
    { name: "rejected", reject: true, consumer: "SDK" },
    { name: "rejected", reject: true, consumer: "raw HTTP" },
  ])(
    "preserves streaming failure when an error lifecycle precedes a $name run ($consumer)",
    async ({ reject, consumer }) => {
      const idleRootCount = getActiveGatewayRootWorkCount();
      mockAgentRun(async (runId) => {
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "partial answer" } });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error", error: "All model fallback candidates failed" },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error", error: "A later lifecycle event must not replace the failure" },
        });
        if (reject) {
          throw new Error("private upstream failure");
        }
        return {
          payloads: [{ text: "partial answer" }],
          meta: { agentMeta: { usage: { input: 11, output: 7, total: 18 } } },
        };
      });

      const request = {
        model: "openclaw",
        messages: [{ role: "user" as const, content: "Report the provider failure." }],
        stream: true as const,
      };
      const stream =
        consumer === "SDK"
          ? await createOpenAiHttpTestClient(enabledPort).chat.completions.create(request)
          : await postChatCompletions(enabledPort, request);
      const choices: OpenAI.ChatCompletionChunk["choices"] = [];
      const expectedError = { message: "All model fallback candidates failed", type: "api_error" };

      if (stream instanceof Response) {
        choices.push(...(await readRawChatCompletionStream(stream, expectedError)));
      } else {
        await expect(async () => {
          for await (const chunk of stream) {
            choices.push(...chunk.choices);
          }
        }).rejects.toMatchObject(expectedError);
      }

      expect(
        choices.flatMap((choice) =>
          typeof choice.delta.content === "string" ? [choice.delta.content] : [],
        ),
      ).toEqual(["partial answer"]);
      expect(choices.every((choice) => choice.finish_reason === null)).toBe(true);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
    },
  );

  it("keeps embedded late commentary append-only while the final answer streams", async () => {
    agentCommandMock.mockImplementationOnce(emitEmbeddedLateCommentary);
    const stream = await createChatStream("Inspect the workspace and summarize it.");
    const { content, finishReasons } = await collectChatStream(stream);
    expect(content).toBe("I will inspect the workspace.\n\nThe check is complete.");
    expect(finishReasons.at(-1)).toBe("stop");
  });

  it.each(
    incompatibleReplacementCases.toSpliced(6, 0, {
      name: "rewritten then explicitly restored",
      replacementText: "final answer",
      recoveryText: "draft answer",
    }),
  )("fails an official SDK stream when streamed text is $name", async (scenario) => {
    const { previousText = "draft answer" } = scenario;
    mockAgentRun(async (runId) => {
      return emitIncompatibleAssistantReplacement(runId, scenario, "");
    });

    const stream = await createChatStream("Reject an incompatible replacement snapshot.");
    const deliveredContent: string[] = [];
    const finishReasons: Array<string | null> = [];
    await expect(async () => {
      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if (typeof choice.delta.content === "string") {
            deliveredContent.push(choice.delta.content);
          }
          finishReasons.push(choice.finish_reason);
        }
      }
    }).rejects.toMatchObject({
      message: "Assistant output cannot be represented as an append-only response stream.",
      type: "api_error",
    });
    expect(deliveredContent).toEqual([previousText]);
    expect(finishReasons).not.toContain("stop");
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  });

  it.each(compatibleReplacementCases)(
    "keeps official SDK text consistent for $name",
    async (scenario) => {
      const { resultText, replacementText = "final answer" } = scenario;
      mockAgentRun(async (runId) => {
        return emitCompatibleAssistantReplacement(runId, scenario);
      });

      const stream = await createChatStream("Preserve an append-compatible replacement.");
      const { content: deliveredContent, finishReasons } = await collectChatStream(stream);
      expect(deliveredContent).toBe(resultText ?? replacementText);
      expect(finishReasons.at(-1)).toBe("stop");
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    [
      {
        name: "the corrected final payload",
        provisional: "Working...",
        replacement: "Done.",
        payloads: [{ text: "Done." }],
        expected: "Done.",
      },
      {
        name: "all finalized payloads",
        provisional: "First.Second.",
        payloads: [{ text: "First." }, { text: "Second." }],
        expected: "First.\n\nSecond.",
      },
      {
        name: "streamed commentary when the final payload is empty",
        provisional: "Working...",
        payloads: [],
        expected: "Working...",
      },
      {
        name: "an explicit empty final payload",
        provisional: "Working...",
        payloads: [{ text: "" }],
        expected: "",
      },
      {
        name: "the finalized held replacement",
        provisional: "Working...",
        replacement: "Done.",
        replaceable: true,
        payloads: [{ text: "Final tool prose." }],
        expected: "Final tool prose.",
      },
    ].flatMap((scenario, index) =>
      (index === 0 ? (["required", "pinned"] as const) : (["required"] as const)).map((mode) => ({
        scenario,
        mode,
      })),
    ),
  )("uses $scenario.name for $mode tool-stream terminal commentary", async ({ scenario, mode }) => {
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId: string }).runId;
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: scenario.provisional, delta: scenario.provisional },
      });
      if (scenario.replacement) {
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: {
            text: scenario.replacement,
            delta: "",
            replace: true,
            phase: "final_answer",
            ...(scenario.replaceable ? { itemId: "held-item", replaceable: true } : {}),
          },
        });
      }
      return {
        payloads: scenario.payloads,
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' }],
        },
      };
    }) as never);

    const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
      model: "openclaw",
      messages: [{ role: "user", content: "Check the weather." }],
      stream: true,
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
      tool_choice:
        mode === "required" ? "required" : { type: "function", function: { name: "get_weather" } },
    });
    let content = "";
    const finishReasons: string[] = [];
    for await (const chunk of stream) {
      for (const choice of chunk.choices) {
        content += choice.delta.content ?? "";
        if (choice.finish_reason) {
          finishReasons.push(choice.finish_reason);
        }
      }
    }
    expect(content).toBe(scenario.expected);
    expect(finishReasons).toEqual(["tool_calls"]);
  });

  it.each([
    [false, false, "hello", false],
    [false, true, "hello", false],
    [true, false, "internal error", true],
    [true, true, "Agent run failed", true],
  ] as const)(
    "separates streamed content from terminal finish (fail=%s, providerTerminal=%s)",
    async (fail, providerTerminal, expected, protocolError) => {
      const idleRootCount = getActiveGatewayRootWorkCount();
      const terminalAdmission = createDeferred<{ active: number }>();
      const continueAgent = createDeferred();
      const lifecycleTerminals: string[] = [];
      let activeRunId: string | undefined;
      const unsubscribe = onAgentEvent((event) => {
        const phase = event.data?.phase;
        if (event.runId !== activeRunId || event.stream !== "lifecycle") {
          return;
        }
        if (phase !== "end" && phase !== "error") {
          return;
        }
        lifecycleTerminals.push(phase);
        // Agent settlement schedules the terminal in a later microtask. The
        // request must remain admitted until Node finishes the actual stream.
        const active = getActiveGatewayRootWorkCount();
        terminalAdmission.resolve({ active });
      });
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        activeRunId = (opts as { runId?: string }).runId;
        if (!activeRunId) {
          throw new Error("expected a streaming chat-completion run ID");
        }
        await continueAgent.promise;
        if (fail) {
          if (providerTerminal) {
            emitAgentEvent({ runId: activeRunId, stream: "lifecycle", data: { phase: "error" } });
          }
          throw new Error("private upstream failure");
        }
        const result = buildAssistantDeltaResult({
          opts,
          emit: emitAgentEvent,
          deltas: ["he", "llo"],
          text: expected,
        });
        if (providerTerminal) {
          emitAgentEvent({ runId: activeRunId, stream: "lifecycle", data: { phase: "end" } });
        }
        return result;
      }) as never);

      try {
        const request = {
          model: "openclaw",
          messages: [{ role: "user" as const, content: "Return a complete streamed response." }],
          stream: true as const,
        };
        const stream =
          await createOpenAiHttpTestClient(enabledPort).chat.completions.create(request);
        await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        continueAgent.resolve();

        const choices: Array<{
          delta: { content?: string | null };
          finish_reason: string | null;
        }> = [];
        const expectedError = { message: expected, type: "api_error" };
        const consumeStream = async () => {
          for await (const chunk of stream) {
            choices.push(...chunk.choices);
          }
        };
        if (protocolError) {
          await expect(consumeStream()).rejects.toMatchObject(expectedError);
        } else {
          await consumeStream();
        }

        const admission = await terminalAdmission.promise;
        expect(admission.active).toBe(idleRootCount + 1);
        expect(lifecycleTerminals).toEqual([fail ? "error" : "end"]);

        const contentChoices = choices.filter((choice) => typeof choice.delta.content === "string");
        expect(contentChoices.map((choice) => choice.delta.content).join("")).toBe(
          protocolError ? "" : expected,
        );
        expect(contentChoices.every((choice) => choice.finish_reason === null)).toBe(true);

        const terminalChoices = choices.filter((choice) => choice.finish_reason === "stop");
        expect(terminalChoices).toHaveLength(protocolError ? 0 : 1);
        if (!protocolError) {
          expect(terminalChoices[0]?.delta).toEqual({});
          expect(choices.at(-1)).toEqual(terminalChoices[0]);
        }
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
      } finally {
        continueAgent.resolve();
        unsubscribe();
      }
    },
  );

  it("rejects string stream mode before dispatching an agent", async () => {
    agentCommandMock.mockClear();
    const response = await postChatCompletions(enabledPort, chatRequest({ stream: "false" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error", message: expect.stringContaining("stream") },
    });
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("keeps one created timestamp across every streamed completion chunk", async () => {
    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    try {
      mockAgentRun(async (runId) => {
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "commentary" } });
        return {
          payloads: [{ text: "commentary" }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              { id: "call_1", name: "lookup", arguments: JSON.stringify({ q: "x".repeat(300) }) },
            ],
            agentMeta: { usage: { input: 4, output: 1, total: 5 } },
          },
        };
      });

      const response = await postChatCompletions(
        enabledPort,
        chatRequest({ stream: true, stream_options: { include_usage: true } }),
      );
      expect(response.status).toBe(200);
      const chunks = parseSseDataLines(await response.text())
        .filter((data) => data !== "[DONE]")
        .map((data) => JSON.parse(data) as { created?: number });

      expect(chunks.length).toBeGreaterThanOrEqual(6);
      expect(chunks.every((chunk) => typeof chunk.created === "number")).toBe(true);
      expect(new Set(chunks.map((chunk) => chunk.created))).toEqual(new Set([chunks[0]?.created]));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("streams SSE chunks when stream=true", async () => {
    const request = async (body: Record<string, unknown> = {}) => {
      const response = await postChatCompletions(
        enabledPort,
        chatRequest({ stream: true, ...body }),
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      const data = parseSseDataLines(text);
      const chunks = parseChatChunks(data);
      return {
        response,
        text,
        data,
        chunks,
        choices: chunks.flatMap((chunk) => chunk.choices ?? []),
      };
    };
    const mockDeltas = (deltas: string[], text = deltas.join("")) => {
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) =>
        buildAssistantDeltaResult({ opts, emit: emitAgentEvent, deltas, text })) as never);
    };
    const expectToolFinish = (choices: OpenAI.ChatCompletionChunk["choices"]) =>
      expect(choices.some((choice) => choice.finish_reason === "tool_calls")).toBe(true);

    for (const deltas of [
      ["he", "llo"],
      ["hi", "hi"],
    ]) {
      mockDeltas([...deltas]);
      const { response, data, chunks, choices } = await request();
      expect(streamContent(chunks)).toBe(expected);
      if (deltas[0] === "he") {
        expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
        expect(data.at(-1)).toBe("[DONE]");
        expect(chunks.map((chunk) => chunk.object)).toContain("chat.completion.chunk");
        expect(
          choices
            .filter((choice) => typeof choice.delta?.content === "string")
            .every((choice) => choice.finish_reason === null),
        ).toBe(true);
        const stops = choices.filter((choice) => choice.finish_reason === "stop");
        expect(stops).toHaveLength(1);
        expect(stops[0]?.delta).toEqual({});
        expect(chunks.filter((chunk) => "usage" in chunk)).toHaveLength(0);
      }
    }
    for (const { payloads, expected } of [
      { payloads: [{ text: "hello" }], expected: "hello" },
      { payloads: [{ text: "" }, {}], expected: "No response from OpenClaw." },
      {
        payloads: [{ text: "First." }, {}, { text: "" }, { text: "Second." }],
        expected: "First.\n\nSecond.",
      },
    ]) {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads } as never);
      const { text, chunks } = await request();
      expect(text).toContain("[DONE]");
      expect(streamContent(chunks)).toBe(expected);
    }
    mockDeltas(["plain text despite required"]);
    const required = await request({
      tool_choice: "required",
      tools: [functionTool("get_weather", "Get weather")],
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(required.text).toContain("[DONE]");
    expect(required.text).toContain("tool_choice=required was not satisfied");
    expect(required.text).not.toContain("plain text despite required");

    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce(toolResult("Let me check that.") as never);
    const tool = await request();
    const toolChunks = tool.chunks.filter((chunk) =>
      Array.isArray(chunk.choices?.[0]?.delta?.tool_calls),
    );
    expect(toolChunks.length).toBeGreaterThan(0);
    const calls = toolChunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);
    expect(
      calls.some(
        (call) =>
          call.id === "call_1" && call.type === "function" && call.function?.name === "get_weather",
      ),
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.index === 0)
        .map((call) => call.function?.arguments ?? "")
        .join(""),
    ).toBe('{"city":"Taipei"}');
    expectToolFinish(tool.choices);

    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce(
      toolResult("Let me check that.", [weatherCall()], {
        usage: { input: 12, output: 3, total: 15 },
      }) as never,
    );
    const usage = await request({ stream_options: { include_usage: true } });
    const usageChunk = usage.chunks.find((chunk) => "usage" in chunk);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    });
    expect(usage.data.at(-1)).toBe("[DONE]");

    const lateResult = createDeferred<ReturnType<typeof toolResult>>();
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce(((opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "Let me check that." } });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      return lateResult.promise;
    }) as never);
    const late = await postChatCompletions(enabledPort, chatRequest({ stream: true }));
    expect(late.status).toBe(200);
    if (!late.body) {
      throw new Error("expected streaming response body");
    }
    const reader = late.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("Let me check that.")) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("stream ended before early assistant delta");
      }
      text += decoder.decode(next.value, { stream: true });
    }
    expect(text).not.toContain("[DONE]");
    lateResult.resolve(toolResult("Let me check that."));
    text = await drainStream(reader, decoder, text);
    const lateChunks = parseChatChunks(parseSseDataLines(text));
    expectToolFinish(lateChunks.flatMap((chunk) => chunk.choices ?? []));
    expect(lateChunks.some((chunk) => Array.isArray(chunk.choices?.[0]?.delta?.tool_calls))).toBe(
      true,
    );

    for (const conflict of [true, false]) {
      agentCommandMock.mockClear();
      agentCommandMock.mockRejectedValueOnce(
        conflict ? createClientToolNameConflictError(["exec"]) : new Error("boom"),
      );
      const failure = await request(
        conflict
          ? {
              tools: [functionTool("exec", "conflicts with a built-in tool")],
              messages: [{ role: "user", content: "run command" }],
            }
          : {},
      );
      expect(failure.data.at(-1)).toBe("[DONE]");
      if (conflict) {
        expect(
          failure.chunks.some(
            (chunk) =>
              typeof chunk.error === "object" &&
              chunk.error.type === "invalid_request_error" &&
              chunk.error.message === "invalid tool configuration",
          ),
        ).toBe(true);
      } else {
        expect(failure.chunks.filter((chunk) => "error" in chunk)).toEqual([
          { error: { message: "internal error", type: "api_error" } },
        ]);
        expect(failure.choices.some((choice) => Boolean(choice.delta?.content))).toBe(false);
        expect(failure.text).not.toContain("boom");
      }
      expect(failure.choices.some((choice) => choice.finish_reason === "stop")).toBe(false);
    }
  });

  it.each([
    { name: "empty arguments", expectedArguments: "" },
    ...[{ astral: "😀", boundary: 255 }].map(({ astral, boundary }) => ({
      name: `${astral} at UTF-16 boundary ${boundary}`,
      expectedArguments: JSON.stringify({
        value: `${"a".repeat(boundary - '{"value":"'.length)}${astral}tail`,
      }),
    })),
  ])("keeps streamed tool-call arguments well-formed ($name)", async ({ expectedArguments }) => {
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce(
      toolResult("Calling the tool.", [
        {
          id: "call_1",
          name: "read_value",
          arguments: expectedArguments,
        },
      ]) as never,
    );

    const res = await postChatCompletions(enabledPort, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "read the value" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const data = parseSseDataLines(await res.text());
    expect(data.at(-1)).toBe("[DONE]");

    const chunks = parseChatChunks(data);
    const choices = chunks.flatMap((chunk) => chunk.choices ?? []);
    const argumentDeltas = choices
      .flatMap((choice) => choice.delta?.tool_calls ?? [])
      .map((toolCall) => toolCall.function?.arguments)
      .filter((argumentsDelta): argumentsDelta is string => typeof argumentsDelta === "string");

    expect(argumentDeltas.length).toBeGreaterThan(1);
    for (const argumentsDelta of argumentDeltas) {
      expect(new TextDecoder().decode(new TextEncoder().encode(argumentsDelta))).toBe(
        argumentsDelta,
      );
    }
    expect(argumentDeltas.join("")).toBe(expectedArguments);
    expect(choices.some((choice) => choice.finish_reason === "tool_calls")).toBe(true);
  });

  it(
    "sends an initial SSE chunk before a streaming agent run settles",
    { timeout: 15_000 },
    async () => {
      const port = enabledPort;
      let serverAbortSignal: AbortSignal | undefined;

      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(
        (opts: unknown) =>
          new Promise<undefined>((resolve) => {
            const signal = (opts as AgentCommandOpts | undefined)?.abortSignal;
            serverAbortSignal = signal;
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );

      let settled = false;
      const firstChunk = new Promise<string>((resolve, reject) => {
        const clientReq = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer secret",
            },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"] ?? "").toContain("text/event-stream");
            res.setEncoding("utf8");
            res.once("data", (chunk) => {
              settled = true;
              resolve(String(chunk));
              clientReq.destroy();
            });
          },
        );
        clientReq.on("error", (err) => {
          if (!settled) {
            reject(err);
          }
        });
        clientReq.setTimeout(2_000, () => {
          if (!settled) {
            settled = true;
            clientReq.destroy(new Error("timed out waiting for first SSE chunk"));
          }
        });
        clientReq.end(
          JSON.stringify({
            stream: true,
            ...chatRequest(),
          }),
        );
      });

      await expect(firstChunk).resolves.toContain('"role":"assistant"');
      await vi.waitFor(() => {
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(
        () => {
          expect(serverAbortSignal?.aborted).toBe(true);
        },
        { timeout: 5_000, interval: 50 },
      );
    },
  );

  it("keeps streamed agent work admitted after the HTTP handler returns", async () => {
    const idleRootCount = getActiveGatewayRootWorkCount();
    const continueAgent = createDeferred();
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async () => {
      await continueAgent.promise;
      const queued = await enqueueCommandInLane("openai-http-admission-probe", async () => true);
      return { payloads: [{ text: queued ? "answer queued" : "unreachable" }] };
    }) as never);

    const res = await postChatCompletions(enabledPort, chatRequest({ stream: true }));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    continueAgent.resolve();

    const streamed = parseSseDataLines(await res.text()).join("\n");
    expect(streamed).toContain("answer queued");
    expect(streamed).not.toContain("Error: internal error");
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
  });

  it.each(bufferedReplacementCases)(
    "buffers replaceable assistant events through $name",
    async ({ replacement, finalText, expected }) => {
      mockAgentRun(async (runId) => {
        return emitBufferedAssistantReplacement(runId, { replacement, finalText });
      });

      const stream = await createChatStream("hi");

      const { content, finishReasons } = await collectChatStream(stream);
      expect(content).toBe(expected);
      expect(finishReasons.at(-1)).toBe("stop");
    },
  );

  it.each([
    {
      name: "aggregate-only total",
      usage: { total: 123 },
      delayed: false,
      expected: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 123 },
    },
    {
      name: "usage arriving after lifecycle end",
      usage: { input: 7, output: 3, total: 10 },
      delayed: true,
      expected: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    },
  ])("keeps $name in the final stream usage chunk", async ({ usage, delayed, expected }) => {
    mockAgentRun(async (runId) => {
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
      const result = { payloads: [{ text: "hello" }], meta: { agentMeta: { usage } } };
      if (delayed) {
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        return new Promise((resolve) => {
          setTimeout(() => resolve(result), 100);
        });
      }
      return result;
    });
    const res = await postChatCompletions(
      enabledPort,
      chatRequest({ stream: true, stream_options: { include_usage: true } }),
    );
    expect(res.status).toBe(200);
    const data = parseSseDataLines(await res.text());
    expect(data.at(-1)).toBe("[DONE]");
    expect(parseChatChunks(data).find((chunk) => "usage" in chunk)?.usage).toEqual(expected);
  });

  it("preserves declared owner identity for streaming and non-streaming private callers", async () => {
    await expectDeclaredHttpOwnerIdentity({
      post: (stream, headers) => postChatCompletions(enabledPort, chatRequest({ stream }), headers),
      consume: (response) => response.text(),
      senderIsOwner: () => firstAgentCommandOptions()?.senderIsOwner,
    });
  });

  it.each([
    { name: "streaming", stream: true, includeUsage: false },
    { name: "usage-enabled streaming", stream: true, includeUsage: true },
    { name: "non-streaming", stream: false, includeUsage: false },
  ])(
    "aborts and retains cleanup admission when $name client disconnects",
    { timeout: 15_000 },
    async ({ stream, includeUsage }) => {
      const port = enabledPort;
      const idleRootCount = getActiveGatewayRootWorkCount();
      const agentAborted = createDeferred();
      const finishAgentCleanup = createDeferred();
      const cleanupAdmissionClosed = createDeferred<boolean>();
      let serverAbortSignal: AbortSignal | undefined;

      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(async (opts: unknown) => {
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        serverAbortSignal = signal;
        if (includeUsage) {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        }
        if (signal?.aborted) {
          agentAborted.resolve();
        } else {
          signal?.addEventListener("abort", () => agentAborted.resolve(), { once: true });
        }
        await agentAborted.promise;
        cleanupAdmissionClosed.resolve(isGatewaySubordinateWorkAdmissionClosed());
        await finishAgentCleanup.promise;
        return undefined;
      });

      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
      });
      clientReq.on("error", () => {});
      clientReq.end(
        JSON.stringify({
          ...(stream ? { stream: true } : {}),
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          ...chatRequest(),
        }),
      );

      await vi.waitFor(() => {
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
      });

      try {
        clientReq.destroy();

        await vi.waitFor(() => expect(serverAbortSignal?.aborted).toBe(true), {
          timeout: 5_000,
          interval: 50,
        });
        expect(await cleanupAdmissionClosed.promise).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount + 1);
      } finally {
        finishAgentCleanup.resolve();
      }

      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount), {
        timeout: 5_000,
        interval: 50,
      });
    },
  );

  // Keep this last: it verifies shutdown of the shared server.
  it("binds the Gateway lifecycle resolver to chat-completion runs", async () => {
    let resolveGatewayContext: ReturnType<typeof getGatewayContextResolver>;
    try {
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(async (opts: unknown) => {
        const admittedRunContext = {};
        const onAdmittedRunContext = (opts as FirstAgentCommandOptions).onAdmittedRunContext;
        expect(onAdmittedRunContext).toBeTypeOf("function");
        await onAdmittedRunContext?.(admittedRunContext);
        resolveGatewayContext = getGatewayContextResolver(admittedRunContext);
        return { payloads: [{ text: "hello" }] } as never;
      });

      const res = await postChatCompletions(enabledPort);

      expect(res.status).toBe(200);
      await res.text();
      const context = resolveGatewayContext?.();
      expect(context?.resolveGatewayContext).toBe(resolveGatewayContext);
    } finally {
      await enabledServer.close({ reason: "chat-completion resolver lifecycle test done" });
    }
    expect(resolveGatewayContext?.()).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

// These configurations own their Gateway after the shared server has closed.
describe("OpenAI-compatible HTTP API (e2e) with independent Gateways", () => {
  it("returns 429 for repeated failed auth when gateway.auth.rateLimit is configured", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
    };
    await withGatewayServer(
      async ({ port }) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer wrong",
        };
        const body = {
          ...chatRequest(),
        };

        const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(first.status).toBe(401);

        const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(second.status).toBe(429);
        expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
      },
      {
        serverOptions: {
          host: "127.0.0.1",
          controlUiEnabled: false,
          openAiChatCompletionsEnabled: true,
        },
      },
    );
  });

  it.each(["trusted-proxy", "token"] as const)(
    "preserves %s authority when mutating another operator session",
    async (authMethod) => {
      await expectHttpForeignSessionAuthority({
        authMethod,
        ownerEmail: "session-owner@example.test",
        sessionKey: "agent:main:foreign-openai-http",
        sessionId: "foreign-openai-http",
        closeReason: "openai operator role session sharing test done",
        startServer: async (port, auth) => {
          return await startGatewayServer(port, {
            host: "127.0.0.1",
            auth,
            controlUiEnabled: false,
            openAiChatCompletionsEnabled: true,
          });
        },
        writeGatewayConfig,
        post: (port, headers) =>
          postChatCompletions(
            port,
            { model: "openclaw", messages: [{ role: "user", content: "mutate foreign session" }] },
            headers,
          ),
      });
    },
  );

  it("preserves verified trusted-proxy owner identity for both response modes", async () => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined },
      async () => {
        let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
        const previousGatewayAuth = testState.gatewayAuth;
        const trustedProxyAuth = {
          mode: "trusted-proxy" as const,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
          },
        };
        testState.gatewayAuth = trustedProxyAuth;
        try {
          await writeGatewayConfig({
            gateway: {
              auth: trustedProxyAuth,
              trustedProxies: ["127.0.0.1"],
            },
          });
          resetConfigRuntimeState();
          const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
          const port = portClaim.port;
          server = await startClaimedGateway(portClaim, () =>
            startGatewayServer(port, {
              host: "127.0.0.1",
              auth: trustedProxyAuth,
              controlUiEnabled: false,
              openAiChatCompletionsEnabled: true,
            }),
          );

          const incognitoSessionKey = "agent:main:dashboard:incognito-openai-http";
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: incognitoSessionKey },
            {
              sessionId: "session-incognito-openai-http",
              updatedAt: 1,
              incognito: true,
              visibility: "shared",
            },
          );

          const trustedProxyHeaders = {
            "x-forwarded-for": "198.51.100.42",
            "x-forwarded-proto": "https",
            "x-forwarded-user": "operator@example.com",
          };
          for (const stream of [false, true]) {
            for (const { scopes, senderIsOwner } of [
              { scopes: "operator.write", senderIsOwner: false },
              { scopes: "operator.admin, operator.write", senderIsOwner: true },
            ]) {
              mockAgentOnce();
              const res = await postChatCompletions(port, chatRequest({ stream }), {
                ...trustedProxyHeaders,
                "x-openclaw-scopes": scopes,
                "x-openclaw-sender-is-owner": "true",
              });
              expect(res.status).toBe(200);
              await res.text();
              expect(agentCommandMock).toHaveBeenCalledTimes(1);
              expect(firstAgentCommandOptions()?.senderIsOwner).toBe(senderIsOwner);
            }
          }
          const adminScopes = "operator.admin, operator.write";
          for (const { headers, status, authenticated = true } of [
            ...[incognitoSessionKey, "dashboard:incognito-openai-http"].map((key) => ({
              headers: { "x-openclaw-scopes": "operator.write", "x-openclaw-session-key": key },
              status: 403,
            })),
            {
              headers: {
                "x-openclaw-scopes": adminScopes,
                "x-openclaw-session-key": "dashboard:incognito-openai-http",
              },
              status: 200,
            },
            {
              headers: { "x-openclaw-scopes": adminScopes, "x-openclaw-sender-is-owner": "true" },
              status: 401,
              authenticated: false,
            },
          ]) {
            agentCommandMock.mockClear();
            if (status === 200) {
              agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
            }
            const requestHeaders: Record<string, string> = { ...trustedProxyHeaders, ...headers };
            if (!authenticated) {
              delete requestHeaders["x-forwarded-user"];
            }
            const res = await postChatCompletions(port, chatRequest(), requestHeaders);
            expect(res.status).toBe(status);
            await res.text();
            expect(agentCommandMock).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
          }
        } finally {
          await server?.close({ reason: "openai trusted-proxy auth owner test done" });
          testState.gatewayAuth = previousGatewayAuth;
          await writeGatewayConfig({});
          resetConfigRuntimeState();
        }
      },
    );
  });

  it.each(["token", "password"] as const)(
    "preserves owner identity for streaming and non-streaming %s-authenticated callers",
    async (mode) => {
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const port = portClaim.port;
      const server = await startSharedSecretServer(portClaim, mode);
      try {
        await expectSharedSecretHttpOwnerIdentity({
          post: (stream, headers) =>
            postChatCompletions(port, chatRequest(stream === undefined ? {} : { stream }), headers),
          consume: (response) => response.text(),
          senderIsOwner: () => firstAgentCommandOptions()?.senderIsOwner,
        });
      } finally {
        await server.close({ reason: `openai ${mode} auth owner test done` });
      }
    },
  );
});
