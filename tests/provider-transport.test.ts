import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OpenAIProvider } from "../src/llm-provider.js";
import type { LLMProvider, LLMResponse, LLMToolDef, StreamCallbacks } from "../src/llm-provider.js";
import { Agent } from "../src/agent.js";
import { MCPPool } from "../src/pool.js";
import { ToolRouter } from "../src/router.js";
import { AgentLoop } from "../src/loop.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

// ── Mock LLM Provider (implements LLMProvider directly) ────────────

class MockProvider implements LLMProvider {
  private callCount = 0;

  async chat(messages: Message[], _tools?: LLMToolDef[]): Promise<LLMResponse> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        content: "",
        toolCalls: [{ id: "tc_1", name: "echo", arguments: { text: "hi" } }],
      };
    }
    return { content: "done", toolCalls: [] };
  }

  async streamChat(messages: Message[], tools?: LLMToolDef[], callbacks?: StreamCallbacks): Promise<LLMResponse> {
    return this.chat(messages, tools);
  }
}

// ── LLM Provider interface tests ────────────────────────────────────

describe("LLM Provider interface", { timeout: 60_000 }, () => {
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

  it("should work with a custom LLMProvider implementation", async () => {
    const provider = new MockProvider();
    const loop = new AgentLoop(provider, router);
    const result = await loop.run([{ role: "user", content: "test" }]);

    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    expect(result.toolCallsExecuted).toBe(1);
  });

  it("should accept LLMProvider in Agent constructor", async () => {
    const provider = new MockProvider();
    const agent = new Agent(provider as any);

    await agent.connectServers({
      mock: { command: "npx", args: ["tsx", MOCK_SERVER] },
    });

    const result = await agent.run("test message");
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    expect(agent.getLastResponse(result)).toBe("done");

    await agent.close();
  });

  it("should accept LLMConfig in Agent constructor (backward compat)", async () => {
    // This verifies the old constructor signature still works
    const agent = new Agent({
      baseUrl: "http://localhost:1",
      apiKey: "test",
      model: "mock",
    });

    await agent.connectServers({
      mock: { command: "npx", args: ["tsx", MOCK_SERVER] },
    });

    // Will use the MockProvider-like behavior through the config
    // Just verify it doesn't throw on construction
    expect(agent).toBeDefined();
    await agent.close();
  });
});

// ── Transport config tests ──────────────────────────────────────────

describe("Transport configuration", () => {
  it("should reject unknown transport type", async () => {
    const pool = new MCPPool();
    await expect(
      pool.connect("bad", { transport: "unknown" as any, url: "http://localhost" }),
    ).rejects.toThrow("Unknown transport type");
  });

  it("should reject stdio without command", async () => {
    const pool = new MCPPool();
    await expect(
      pool.connect("bad", { transport: "stdio" }),
    ).rejects.toThrow("stdio transport requires 'command'");
  });

  it("should reject sse without url", async () => {
    const pool = new MCPPool();
    await expect(
      pool.connect("bad", { transport: "sse" }),
    ).rejects.toThrow("sse transport requires 'url'");
  });

  it("should reject streamable-http without url", async () => {
    const pool = new MCPPool();
    await expect(
      pool.connect("bad", { transport: "streamable-http" }),
    ).rejects.toThrow("streamable-http transport requires 'url'");
  });

  it("should default to stdio when command is present", async () => {
    const pool = new MCPPool();
    // Should not throw transport creation error (will fail at actual connection but that's ok)
    // We just verify the transport type selection logic
    try {
      await pool.connect("test-stdio", { command: "nonexistent-command" });
    } catch (e) {
      // Expected to fail at spawn, not at transport type selection
      expect((e as Error).message).not.toContain("Unknown transport type");
    }
  });
});

// ── OpenAIProvider unit test ────────────────────────────────────────

describe("OpenAIProvider", () => {
  it("should be constructable with default config", () => {
    const provider = new OpenAIProvider();
    expect(provider).toBeDefined();
  });

  it("should be constructable with custom config", () => {
    const provider = new OpenAIProvider({
      baseUrl: "http://localhost:8080/v1",
      apiKey: "test-key",
      model: "gpt-4",
      maxTokens: 1024,
      temperature: 0.5,
    });
    expect(provider).toBeDefined();
  });
});
