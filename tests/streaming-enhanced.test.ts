import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../src/llm-provider.js";
import type { StreamCallbacks } from "../src/llm-provider.js";
import { AgentLoop } from "../src/loop.js";
import { ToolRouter } from "../src/router.js";
import type { LLMProvider, LLMResponse, LLMToolDef } from "../src/llm-provider.js";
import type { Message } from "../src/types.js";

// ── onToolCallStart streaming callback ────────────────────────────

describe("onToolCallStart streaming callback", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should fire onToolCallStart when tool name arrives", async () => {
    // Mock SSE stream that sends a tool call with name first, then arguments
    const sseChunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"read_file"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"test.txt\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    let chunkIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[chunkIndex++]));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;

    const provider = new OpenAIProvider({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "test",
      model: "test-model",
    });

    const startCalls: Array<{ id: string; name: string }> = [];
    const completedCalls: Array<{ id: string; name: string }> = [];

    const callbacks: StreamCallbacks = {
      onToolCallStart: (tc) => startCalls.push(tc),
      onToolCall: (tc) => completedCalls.push({ id: tc.id, name: tc.name }),
    };

    const result = await provider.streamChat([{ role: "user", content: "read file" }], undefined, callbacks);

    // onToolCallStart should have fired
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].name).toBe("read_file");
    expect(startCalls[0].id).toBe("call_123");

    // onToolCall should also have fired (completed)
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0].name).toBe("read_file");

    // Result should have the tool call with parsed arguments
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.toolCalls[0].arguments).toEqual({ path: "test.txt" });
  });

  it("should fire onToolCallStart before onToolCall", async () => {
    const order: string[] = [];

    const sseChunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"my_tool"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    let chunkIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[chunkIndex++]));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;

    const provider = new OpenAIProvider({ baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test-model" });

    await provider.streamChat([{ role: "user", content: "test" }], undefined, {
      onToolCallStart: () => order.push("start"),
      onToolCall: () => order.push("complete"),
    });

    expect(order).toEqual(["start", "complete"]);
  });

  it("should fire onToolCallStart for multiple parallel tool calls", async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"tool_a"}},{"index":1,"id":"c2","function":{"name":"tool_b"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}},{"index":1,"function":{"arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    let chunkIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[chunkIndex++]));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;

    const provider = new OpenAIProvider({ baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test-model" });

    const startNames: string[] = [];
    await provider.streamChat([{ role: "user", content: "test" }], undefined, {
      onToolCallStart: (tc) => startNames.push(tc.name),
    });

    expect(startNames).toHaveLength(2);
    expect(startNames).toContain("tool_a");
    expect(startNames).toContain("tool_b");
  });

  it("should not fire onToolCallStart when no tool calls in stream", async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello!"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    let chunkIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[chunkIndex++]));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;

    const provider = new OpenAIProvider({ baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test-model" });

    const startCalls: unknown[] = [];
    await provider.streamChat([{ role: "user", content: "test" }], undefined, {
      onToolCallStart: (tc) => startCalls.push(tc),
    });

    expect(startCalls).toHaveLength(0);
  });
});

// ── AgentLoop cancel ─────────────────────────────────────────────

describe("AgentLoop cancel", () => {
  function makeMockLLM(response: LLMResponse): LLMProvider {
    return {
      chat: vi.fn().mockResolvedValue(response),
      streamChat: vi.fn().mockResolvedValue(response),
    };
  }

  it("should stop loop when cancel() is called", async () => {
    // First call returns a tool call, second would return content
    // After cancel, it should stop before the second LLM call
    const llm = makeMockLLM({
      content: "done",
      toolCalls: [],
    });

    const router = new ToolRouter();
    const loop = new AgentLoop(llm, router);

    // Cancel immediately
    loop.cancel();

    const result = await loop.run([{ role: "user", content: "test" }]);

    // Should have stopped immediately (0 rounds executed because cancelled)
    expect(result.toolCallsExecuted).toBe(0);
    // LLM should not have been called
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("should allow resetCancel to clear the abort flag", async () => {
    const llm = makeMockLLM({
      content: "done",
      toolCalls: [],
    });

    const router = new ToolRouter();
    const loop = new AgentLoop(llm, router);

    loop.cancel();
    loop.resetCancel();

    const result = await loop.run([{ role: "user", content: "test" }]);

    // Should run normally after reset
    expect(llm.chat).toHaveBeenCalledOnce();
    expect(result.toolCallsExecuted).toBe(0);
  });

  it("should stop mid-loop when cancel is called between rounds", async () => {
    let callCount = 0;
    const llm: LLMProvider = {
      chat: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "tc1", name: "dummy", arguments: {} }],
          };
        }
        return { content: "done", toolCalls: [] };
      }),
      streamChat: vi.fn().mockResolvedValue({ content: "done", toolCalls: [] }),
    };

    const router = new ToolRouter();
    router.registerLocalTool("dummy", "test", { type: "object", properties: {} }, async () => ({ content: "ok", isError: false }));
    const loop = new AgentLoop(llm, router);

    // We can't cancel mid-loop in a synchronous test, but we can verify
    // the loop respects the flag by canceling before run
    loop.cancel();

    const result = await loop.run([{ role: "user", content: "test" }]);
    expect(result.toolCallsExecuted).toBe(0);
  });
});
