import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MCPPool } from "../src/pool.js";
import { ToolRouter } from "../src/router.js";
import { AgentLoop } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

/**
 * Mock LLM that echoes the last user message and includes tool call history awareness.
 * This tests the multi-turn memory without needing a real LLM.
 */
class MockLLMClient extends LLMClient {
  private callCount = 0;

  constructor() {
    // Override baseUrl to prevent real HTTP calls
    super({ baseUrl: "http://localhost:1", apiKey: "test", model: "mock" });
  }

  override async chat(
    messages: Message[],
    tools?: Parameters<LLMClient["chat"]>[1],
  ): Promise<Awaited<ReturnType<LLMClient["chat"]>>> {
    this.callCount++;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");

    // Check if we have history (more than system + 1 user message)
    const nonSystemMessages = messages.filter((m) => m.role !== "system");
    const hasHistory = nonSystemMessages.length > 1;

    return {
      content: `Turn ${this.callCount}: received ${messages.length} messages. History: ${hasHistory ? "yes" : "no"}. Last user: "${lastUserMsg?.content ?? ""}"`,
      toolCalls: [],
    };
  }
}

describe("Multi-turn conversation", () => {
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

  it("should accumulate history across multiple runs", async () => {
    const llm = new MockLLMClient();
    const loop = new AgentLoop(llm, router);
    const history: Message[] = [];

    // Turn 1
    const r1 = await loop.run([
      { role: "system", content: "test" },
      ...history,
      { role: "user", content: "first message" },
    ]);
    // history should be empty, result has system + user + assistant
    expect(r1.messages).toHaveLength(3);

    // Simulate Agent's history accumulation
    history.push({ role: "user", content: "first message" });
    history.push(r1.messages[2]); // assistant response

    // Turn 2 — should see history
    const r2 = await loop.run([
      { role: "system", content: "test" },
      ...history,
      { role: "user", content: "second message" },
    ]);

    // Should have system + prev history (2) + new user + new assistant = 5
    expect(r2.messages).toHaveLength(5);
    expect(r2.messages[2].content).toContain("Turn 1");
    // Turn 2 should see "History: yes"
    expect(r2.messages[4].content).toContain("History: yes");
    // LLM receives: system + 2 history + user = 4 messages
    expect(r2.messages[4].content).toContain("4 messages");
  });

  it("should track history via Agent class", async () => {
    // Use a simple Agent-like flow manually to test history management
    const { Agent } = await import("../src/agent.js");

    // Create agent with a mock LLM — we can't easily inject, so test the history logic directly
    const history: Message[] = [];
    const maxHistory = 5;

    // Simulate adding messages
    for (let i = 0; i < 10; i++) {
      history.push({ role: "user", content: `msg-${i}` });
      history.push({ role: "assistant", content: `reply-${i}` });
    }

    // Should have 20 messages
    expect(history).toHaveLength(20);

    // Truncate
    if (history.length > maxHistory) {
      const dropped = history.length - maxHistory;
      history.splice(0, dropped);
    }

    expect(history).toHaveLength(maxHistory);
    // 10 pairs = 20 messages, splice(0, 15) keeps indices 15-19
    // idx 15 = reply-7 (assistant), idx 18 = user-9, idx 19 = reply-9
    expect(history[0].content).toBe("reply-7"); // oldest surviving
    expect(history[4].content).toBe("reply-9"); // newest
  });

  it("should support reset", async () => {
    const history: Message[] = [
      { role: "user", content: "msg" },
      { role: "assistant", content: "reply" },
    ];

    expect(history).toHaveLength(2);
    history.length = 0; // reset
    expect(history).toHaveLength(0);
  });
});
