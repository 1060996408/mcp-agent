import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MCPPool } from "../src/pool.js";
import { ToolRouter } from "../src/router.js";
import { AgentLoop } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import type { StreamCallbacks } from "../src/llm.js";
import type { Message } from "../src/types.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

/**
 * Mock streaming LLM that returns tokens one by one.
 * Simulates SSE chunks without making real HTTP calls.
 */
class MockStreamLLM extends LLMClient {
  private responseText: string;
  private usage?: { prompt: number; completion: number };

  constructor(responseText: string, usage?: { prompt: number; completion: number }) {
    super({ baseUrl: "http://localhost:1", apiKey: "test", model: "mock" });
    this.responseText = responseText;
    this.usage = usage;
  }

  override async streamChat(
    _messages: Message[],
    _tools?: Parameters<LLMClient["streamChat"]>[1],
    callbacks?: StreamCallbacks,
  ): Promise<Awaited<ReturnType<LLMClient["streamChat"]>>> {
    // Simulate streaming token by token
    for (const char of this.responseText) {
      callbacks?.onToken?.(char);
      // Small delay to simulate real streaming
      await new Promise((r) => setTimeout(r, 1));
    }

    return { content: this.responseText, toolCalls: [], usage: this.usage };
  }
}

/**
 * Mock streaming LLM that returns tool calls.
 */
class MockStreamToolLLM extends LLMClient {
  private callCount = 0;

  constructor() {
    super({ baseUrl: "http://localhost:1", apiKey: "test", model: "mock" });
  }

  override async streamChat(
    _messages: Message[],
    _tools?: Parameters<LLMClient["streamChat"]>[1],
    callbacks?: StreamCallbacks,
  ): Promise<Awaited<ReturnType<LLMClient["streamChat"]>>> {
    this.callCount++;

    if (this.callCount === 1) {
      // First call: emit a tool call
      const toolCall = { id: "call_test123", name: "echo", arguments: { text: "stream test" } };
      callbacks?.onToolCall?.(toolCall);
      return { content: "", toolCalls: [toolCall] };
    }

    // Second call: final response
    const text = "Tool result received via streaming!";
    for (const char of text) {
      callbacks?.onToken?.(char);
      await new Promise((r) => setTimeout(r, 1));
    }
    return { content: text, toolCalls: [] };
  }
}

describe("Streaming support", () => {
  let pool: MCPPool;
  let router: ToolRouter;

  beforeAll(async () => {
    pool = new MCPPool();
    await pool.connect("mock", { command: "npx", args: ["tsx", MOCK_SERVER] });
    router = new ToolRouter();
    await router.buildIndex(pool.getAll());
  });

  afterAll(async () => {
    await pool.close();
  });

  it("should stream tokens via callback", async () => {
    const llm = new MockStreamLLM("Hello, streaming world!");
    const loop = new AgentLoop(llm, router);

    const tokens: string[] = [];
    const result = await loop.runStream(
      [
        { role: "system", content: "test" },
        { role: "user", content: "say hello" },
      ],
      { onToken: (t) => tokens.push(t) },
    );

    // Should have received all tokens
    expect(tokens.join("")).toBe("Hello, streaming world!");
    expect(result.messages).toHaveLength(3); // system + user + assistant
    expect(result.messages[2].content).toBe("Hello, streaming world!");
    expect(result.toolCallsExecuted).toBe(0);
  });

  it("should stream tool calls and execute them", async () => {
    const llm = new MockStreamToolLLM();
    const loop = new AgentLoop(llm, router);

    const toolCalls: string[] = [];
    const tokens: string[] = [];

    const result = await loop.runStream(
      [
        { role: "system", content: "test" },
        { role: "user", content: "echo something" },
      ],
      {
        onToken: (t) => tokens.push(t),
        onToolCall: (tc) => toolCalls.push(tc.name),
      },
    );

    // Should have executed the tool call
    expect(toolCalls).toEqual(["echo"]);
    expect(result.toolCallsExecuted).toBe(1);

    // Final response should include tool result flow
    // system + user + assistant(tool_call) + tool(result) + assistant(final)
    expect(result.messages).toHaveLength(5);
    expect(result.messages[2].tool_calls).toBeDefined();
    expect(result.messages[3].role).toBe("tool");
    expect(tokens.join("")).toBe("Tool result received via streaming!");
  });

  it("should handle empty stream", async () => {
    const llm = new MockStreamLLM("");
    const loop = new AgentLoop(llm, router);

    const tokens: string[] = [];
    const result = await loop.runStream(
      [
        { role: "system", content: "test" },
        { role: "user", content: "empty" },
      ],
      { onToken: (t) => tokens.push(t) },
    );

    expect(tokens).toHaveLength(0);
    expect(result.messages[2].content).toBe("");
  });

  it("should track tokensUsed when usage is provided", async () => {
    const llm = new MockStreamLLM("hello", { prompt: 100, completion: 50 });
    const loop = new AgentLoop(llm, router);

    const result = await loop.runStream([
      { role: "user", content: "test" },
    ]);

    expect(result.tokensUsed).toBe(150);
  });

  it("should accumulate tokens across multiple streaming rounds", async () => {
    const llm = new MockStreamToolLLM();
    // MockStreamToolLLM doesn't return usage; use a wrapper
    class UsageStreamToolLLM extends LLMClient {
      private callCount = 0;
      constructor() {
        super({ baseUrl: "http://localhost:1", apiKey: "test", model: "mock" });
      }
      override async streamChat(
        _messages: Message[],
        _tools?: Parameters<LLMClient["streamChat"]>[1],
        callbacks?: StreamCallbacks,
      ): Promise<Awaited<ReturnType<LLMClient["streamChat"]>>> {
        this.callCount++;
        if (this.callCount === 1) {
          const tc = { id: "call_1", name: "echo", arguments: { text: "hi" } };
          callbacks?.onToolCall?.(tc);
          return { content: "", toolCalls: [tc], usage: { prompt: 80, completion: 20 } };
        }
        return { content: "done", toolCalls: [], usage: { prompt: 90, completion: 30 } };
      }
    }

    const usageLlm = new UsageStreamToolLLM();
    const loop = new AgentLoop(usageLlm, router);
    const result = await loop.runStream([{ role: "user", content: "test" }]);

    // 80+20 + 90+30 = 220
    expect(result.tokensUsed).toBe(220);
    expect(result.toolCallsExecuted).toBe(1);
  });

  it("should report undefined tokensUsed when no usage returned", async () => {
    const llm = new MockStreamLLM("no usage here");
    const loop = new AgentLoop(llm, router);

    const result = await loop.runStream([{ role: "user", content: "test" }]);
    expect(result.tokensUsed).toBeUndefined();
  });
});
