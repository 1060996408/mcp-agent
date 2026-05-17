import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  CircuitBreakerMiddleware,
  BudgetMeter,
  OutputSanitizer,
  runHooks,
} from "../src/middleware.js";
import type { MiddlewareContext, Next } from "../src/middleware.js";
import { Agent } from "../src/agent.js";
import { AgentLoop } from "../src/loop.js";
import { MCPPool } from "../src/pool.js";
import { ToolRouter } from "../src/router.js";
import { OpenAIProvider } from "../src/llm-provider.js";
import type { LLMProvider, LLMResponse, LLMToolDef } from "../src/llm-provider.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

// ── Mock providers ──────────────────────────────────────────────────

class ToolCallProvider implements LLMProvider {
  private callCount = 0;
  constructor(private responses?: LLMResponse[]) {}

  async chat(messages: Message[], _tools?: LLMToolDef[]): Promise<LLMResponse> {
    if (this.responses) return this.responses[this.callCount++] ?? { content: "done", toolCalls: [] };
    this.callCount++;
    if (this.callCount === 1) return { content: "", toolCalls: [{ id: "tc_1", name: "echo", arguments: { text: "hi" } }] };
    return { content: "done", toolCalls: [] };
  }
  async streamChat(messages: Message[], tools?: LLMToolDef[]): Promise<LLMResponse> {
    return this.chat(messages, tools);
  }
}

// ── CircuitBreaker tests ────────────────────────────────────────────

describe("CircuitBreakerMiddleware", () => {
  it("should not trip below threshold", async () => {
    const cb = new CircuitBreakerMiddleware({ threshold: 3 });
    const ctx: MiddlewareContext = {
      type: "tool",
      toolCall: { id: "1", name: "test", arguments: {} },
      result: { content: "Error: timeout", isError: true },
      metadata: {},
    };
    await cb.afterToolCall!(ctx, async () => {});
    expect(ctx.metadata._circuitTripped).toBeUndefined();
    expect(cb.getStreak("test")?.count).toBe(1);
  });

  it("should trip at threshold", async () => {
    const cb = new CircuitBreakerMiddleware({ threshold: 2 });

    // First failure
    const ctx1: MiddlewareContext = {
      type: "tool",
      toolCall: { id: "1", name: "test", arguments: {} },
      result: { content: "Error: same", isError: true },
      metadata: {},
    };
    await cb.afterToolCall!(ctx1, async () => {});

    // Second failure with same signature
    const ctx2: MiddlewareContext = {
      type: "tool",
      toolCall: { id: "2", name: "test", arguments: {} },
      result: { content: "Error: same", isError: true },
      metadata: {},
    };
    await cb.afterToolCall!(ctx2, async () => {});

    expect(ctx2.metadata._circuitTripped).toBe(true);
    expect(ctx2.result?.content).toContain("Circuit breaker");
  });

  it("should reset on success", async () => {
    const cb = new CircuitBreakerMiddleware({ threshold: 3 });

    // Failure
    await cb.afterToolCall!({
      type: "tool", toolCall: { id: "1", name: "t", arguments: {} },
      result: { content: "err", isError: true }, metadata: {},
    }, async () => {});
    expect(cb.getStreak("t")?.count).toBe(1);

    // Success
    await cb.afterToolCall!({
      type: "tool", toolCall: { id: "2", name: "t", arguments: {} },
      result: { content: "ok", isError: false }, metadata: {},
    }, async () => {});
    expect(cb.getStreak("t")).toBeUndefined();
  });

  it("should reset on different error signature", async () => {
    const cb = new CircuitBreakerMiddleware({ threshold: 3 });

    await cb.afterToolCall!({
      type: "tool", toolCall: { id: "1", name: "t", arguments: {} },
      result: { content: "Error: timeout", isError: true }, metadata: {},
    }, async () => {});
    await cb.afterToolCall!({
      type: "tool", toolCall: { id: "2", name: "t", arguments: {} },
      result: { content: "Error: not found", isError: true }, metadata: {},
    }, async () => {});

    // Different signature resets to 1
    expect(cb.getStreak("t")?.count).toBe(1);
  });
});

// ── BudgetMeter tests ───────────────────────────────────────────────

describe("BudgetMeter", () => {
  it("should allow operations within budget", async () => {
    const budget = new BudgetMeter({ maxToolCalls: 5, wallClockMs: 10000 });
    budget.resetRun();

    const ctx: MiddlewareContext = {
      type: "tool",
      toolCall: { id: "1", name: "t", arguments: {} },
      metadata: {},
    };
    await budget.beforeToolCall!(ctx, async () => {});
    expect(ctx.metadata._budgetExceeded).toBeUndefined();
    expect(ctx.metadata._perToolMs).toBeUndefined(); // timeout stored differently
  });

  it("should block when tool call limit exceeded", async () => {
    const budget = new BudgetMeter({ maxToolCalls: 2 });
    budget.resetRun();

    // First two calls OK
    await budget.beforeToolCall!({ type: "tool", toolCall: { id: "1", name: "t", arguments: {} }, metadata: {} }, async () => {});
    await budget.beforeToolCall!({ type: "tool", toolCall: { id: "2", name: "t", arguments: {} }, metadata: {} }, async () => {});

    // Third call should be blocked
    const ctx: MiddlewareContext = { type: "tool", toolCall: { id: "3", name: "t", arguments: {} }, metadata: {} };
    await budget.beforeToolCall!(ctx, async () => {});
    expect(ctx.metadata._budgetExceeded).toBe(true);
    expect(ctx.error?.message).toContain("tool call limit");
  });

  it("should block when wall clock exceeded", async () => {
    const budget = new BudgetMeter({ wallClockMs: 1 });
    budget.resetRun();

    // Wait past the budget
    await new Promise((r) => setTimeout(r, 10));

    const ctx: MiddlewareContext = { type: "llm", messages: [], metadata: {} };
    await budget.beforeLLM!(ctx, async () => {});
    expect(ctx.metadata._budgetExceeded).toBe(true);
    expect(ctx.error?.message).toContain("wall clock");
  });

  it("should report stats", () => {
    const budget = new BudgetMeter();
    budget.resetRun();
    const stats = budget.stats();
    expect(stats.toolCalls).toBe(0);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ── OutputSanitizer tests ───────────────────────────────────────────

describe("OutputSanitizer", () => {
  it("should redact api_key patterns", () => {
    const s = new OutputSanitizer();
    expect(s.sanitize("api_key=sk-abc123secret")).toBe("[REDACTED]");
    expect(s.sanitize('apiKey: "my-secret-value"')).toBe("[REDACTED]");
  });

  it("should redact Bearer tokens", () => {
    const s = new OutputSanitizer();
    expect(s.sanitize("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxx")).toContain("[REDACTED]");
  });

  it("should redact GitHub tokens", () => {
    const s = new OutputSanitizer();
    expect(s.sanitize("token: ghp_abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  });

  it("should truncate long output", () => {
    const s = new OutputSanitizer({ maxOutputLength: 50 });
    const long = "a".repeat(100);
    const result = s.sanitize(long);
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("truncated");
  });

  it("should not modify clean short output", () => {
    const s = new OutputSanitizer();
    const clean = "Hello, this is a normal tool response.";
    expect(s.sanitize(clean)).toBe(clean);
  });

  it("should sanitize in afterToolCall hook", async () => {
    const s = new OutputSanitizer({ maxOutputLength: 20 });
    const ctx: MiddlewareContext = {
      type: "tool",
      toolCall: { id: "1", name: "t", arguments: {} },
      result: { content: "a".repeat(200), isError: false },
      metadata: {},
    };
    await s.afterToolCall!(ctx, async () => {});
    // Should be shorter than original (truncation message is ~50 chars)
    expect(ctx.result!.content.length).toBeLessThan(200);
    expect(ctx.result!.content).toContain("truncated");
  });

  it("should support custom patterns", () => {
    const s = new OutputSanitizer({ customPatterns: [/CUSTOM_SECRET_\d+/g] });
    expect(s.sanitize("value is CUSTOM_SECRET_12345 here")).toContain("[REDACTED]");
  });
});

// ── Safe history truncation ─────────────────────────────────────────

describe("Safe history truncation", { timeout: 60_000 }, () => {
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

  it("should preserve tool-call/tool-result pairs when truncating", async () => {
    const provider = new ToolCallProvider();
    // Use a very small maxHistory to trigger truncation
    const agent = new Agent(provider as any, { maxHistoryMessages: 6 });

    await agent.connectServers({ mock: { command: "npx", args: ["tsx", MOCK_SERVER] } });

    // Run enough times to exceed maxHistory
    await agent.run("msg1");
    await agent.run("msg2");
    await agent.run("msg3");

    const history = agent.getHistory();

    // Verify no orphaned tool results (every tool message must have a preceding assistant with tool_calls)
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role === "tool") {
        // Find the preceding assistant message with tool_calls
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          if (history[j].role === "assistant" && history[j].tool_calls) {
            const toolIds = history[j].tool_calls!.map((tc) => tc.id);
            if (toolIds.includes(msg.tool_call_id)) {
              found = true;
              break;
            }
          }
          // If we hit a user message without finding the assistant, it's orphaned
          if (history[j].role === "user") break;
        }
        expect(found).toBe(true);
      }
    }

    await agent.close();
  });
});

// ── Configurable maxToolRounds ──────────────────────────────────────

describe("Configurable maxToolRounds", { timeout: 60_000 }, () => {
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

  it("should respect custom maxToolRounds", async () => {
    // Provider that always returns tool calls (would loop forever without limit)
    let callCount = 0;
    const infiniteProvider: LLMProvider = {
      async chat(): Promise<LLMResponse> {
        callCount++;
        return { content: "", toolCalls: [{ id: `tc_${callCount}`, name: "echo", arguments: { text: `${callCount}` } }] };
      },
      async streamChat(m, t): Promise<LLMResponse> { return this.chat(m, t); },
    };

    const loop = new AgentLoop(infiniteProvider, router, [], 3);
    const result = await loop.run([{ role: "user", content: "test" }]);

    // Should stop after 3 rounds
    expect(result.toolCallsExecuted).toBe(3);
  });
});
