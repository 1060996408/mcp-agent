import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { runHooks, LoggingMiddleware, RetryMiddleware, BudgetMeter } from "../src/middleware.js";
import type { Middleware, MiddlewareContext, Next } from "../src/middleware.js";
import { MCPPool } from "../src/pool.js";
import { ToolRouter } from "../src/router.js";
import { AgentLoop } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, ToolCall } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

// ── Unit tests for runHooks ─────────────────────────────────────────

describe("runHooks", () => {
  it("should call action directly when no middleware matches", async () => {
    const action = vi.fn();
    await runHooks([], "beforeLLM", { type: "llm", metadata: {} }, action);
    expect(action).toHaveBeenCalledOnce();
  });

  it("should execute middleware in order then action", async () => {
    const order: string[] = [];

    const mw1: Middleware = {
      beforeLLM: async (_ctx, next) => {
        order.push("mw1-before");
        await next();
        order.push("mw1-after");
      },
    };
    const mw2: Middleware = {
      beforeLLM: async (_ctx, next) => {
        order.push("mw2-before");
        await next();
        order.push("mw2-after");
      },
    };

    await runHooks([mw1, mw2], "beforeLLM", { type: "llm", metadata: {} }, async () => {
      order.push("action");
    });

    expect(order).toEqual(["mw1-before", "mw2-before", "action", "mw2-after", "mw1-after"]);
  });

  it("should support short-circuit (not calling next)", async () => {
    const action = vi.fn();
    const mw: Middleware = {
      beforeLLM: async (_ctx, _next) => {
        // Short-circuit: don't call next
      },
    };

    await runHooks([mw], "beforeLLM", { type: "llm", metadata: {} }, action);
    expect(action).not.toHaveBeenCalled();
  });

  it("should pass context through the chain", async () => {
    const mw1: Middleware = {
      beforeLLM: async (ctx, next) => {
        ctx.metadata.fromMw1 = "hello";
        await next();
      },
    };
    const mw2: Middleware = {
      beforeLLM: async (ctx, next) => {
        expect(ctx.metadata.fromMw1).toBe("hello");
        ctx.metadata.fromMw2 = "world";
        await next();
      },
    };

    const ctx: MiddlewareContext = { type: "llm", metadata: {} };
    await runHooks([mw1, mw2], "beforeLLM", ctx, async () => {
      expect(ctx.metadata.fromMw1).toBe("hello");
      expect(ctx.metadata.fromMw2).toBe("world");
    });
  });

  it("should skip middleware that don't implement the hook", async () => {
    const action = vi.fn();
    const mw: Middleware = {
      name: "tool-only",
      beforeToolCall: async (_ctx, next) => next(),
      // No beforeLLM
    };

    await runHooks([mw], "beforeLLM", { type: "llm", metadata: {} }, action);
    expect(action).toHaveBeenCalledOnce();
  });
});

// ── AgentLoop integration ───────────────────────────────────────────

class MockLLMClient extends LLMClient {
  private callCount = 0;
  shouldFail = false;

  constructor() {
    super({ baseUrl: "http://localhost:1", apiKey: "test", model: "mock" });
  }

  override async chat(
    messages: Message[],
    _tools?: Parameters<LLMClient["chat"]>[1],
  ): Promise<Awaited<ReturnType<LLMClient["chat"]>>> {
    this.callCount++;
    if (this.shouldFail) {
      throw new Error("LLM failure");
    }
    // On first call, return a tool call; on second, return final answer
    if (this.callCount === 1) {
      return {
        content: "",
        toolCalls: [{ id: "tc_1", name: "echo", arguments: { text: "hi" } }],
      };
    }
    return { content: "done", toolCalls: [] };
  }

  getCallCount() {
    return this.callCount;
  }

  reset() {
    this.callCount = 0;
    this.shouldFail = false;
  }
}

describe("AgentLoop middleware integration", { timeout: 60_000 }, () => {
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

  it("should work with no middleware (baseline)", async () => {
    const llm = new MockLLMClient();
    const loop = new AgentLoop(llm, router);
    const result = await loop.run([{ role: "user", content: "test" }]);

    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    expect(result.toolCallsExecuted).toBe(1);
  });

  it("should fire beforeLLM and afterLLM hooks", async () => {
    const llm = new MockLLMClient();
    const events: string[] = [];

    const mw: Middleware = {
      beforeLLM: async (_ctx, next) => {
        events.push("beforeLLM");
        await next();
      },
      afterLLM: async (_ctx, next) => {
        events.push("afterLLM");
        await next();
      },
    };

    const loop = new AgentLoop(llm, router, [mw]);
    await loop.run([{ role: "user", content: "test" }]);

    // beforeLLM fires twice (round 1: tool call, round 2: final), afterLLM also twice
    expect(events.filter((e) => e === "beforeLLM")).toHaveLength(2);
    expect(events.filter((e) => e === "afterLLM")).toHaveLength(2);
    // Order: before → after → before → after
    expect(events).toEqual(["beforeLLM", "afterLLM", "beforeLLM", "afterLLM"]);
  });

  it("should fire beforeToolCall and afterToolCall hooks", async () => {
    const llm = new MockLLMClient();
    const events: string[] = [];

    const mw: Middleware = {
      beforeToolCall: async (ctx, next) => {
        events.push(`before:${ctx.toolCall?.name}`);
        await next();
      },
      afterToolCall: async (ctx, next) => {
        events.push(`after:${ctx.toolCall?.name}`);
        await next();
      },
    };

    const loop = new AgentLoop(llm, router, [mw]);
    await loop.run([{ role: "user", content: "test" }]);

    expect(events).toEqual(["before:echo", "after:echo"]);
  });

  it("should allow middleware to modify metadata across hooks", async () => {
    const llm = new MockLLMClient();
    const captured: unknown[] = [];

    const mw: Middleware = {
      beforeLLM: async (ctx, next) => {
        ctx.metadata.startTime = 123;
        await next();
      },
      afterLLM: async (ctx, next) => {
        captured.push(ctx.metadata.startTime);
        await next();
      },
    };

    const loop = new AgentLoop(llm, router, [mw]);
    await loop.run([{ role: "user", content: "test" }]);

    expect(captured).toEqual([123, 123]);
  });

  it("should let beforeLLM middleware short-circuit the LLM call", async () => {
    const llm = new MockLLMClient();
    const mw: Middleware = {
      beforeLLM: async (ctx) => {
        ctx.error = new Error("blocked");
      },
    };

    const loop = new AgentLoop(llm, router, [mw]);

    await expect(loop.run([{ role: "user", content: "test" }])).rejects.toThrow("blocked");
    expect(llm.getCallCount()).toBe(0);
  });

  it("should preserve retry metadata across LLM attempts", async () => {
    const llm = new MockLLMClient();
    llm.shouldFail = true;
    const retry = new RetryMiddleware({ maxRetries: 2, baseDelayMs: 1 });
    const loop = new AgentLoop(llm, router, [retry]);

    await expect(loop.run([{ role: "user", content: "test" }])).rejects.toThrow("LLM failure");
    expect(llm.getCallCount()).toBe(3);
  });

  it("should return tool results modified by afterToolCall middleware", async () => {
    const llm = new MockLLMClient();
    const mw: Middleware = {
      afterToolCall: async (ctx, next) => {
        if (ctx.result) ctx.result.content = "sanitized";
        await next();
      },
    };

    const loop = new AgentLoop(llm, router, [mw]);
    const result = await loop.run([{ role: "user", content: "test" }]);

    expect(result.messages.some((m) => m.role === "tool" && m.content === "sanitized")).toBe(true);
  });
});

// ── Built-in middleware ─────────────────────────────────────────────

describe("LoggingMiddleware", () => {
  it("should be instantiable with default name", () => {
    const mw = new LoggingMiddleware();
    expect(mw.name).toBe("logging");
  });

  it("should not throw during hooks", async () => {
    const mw = new LoggingMiddleware();
    const ctx: MiddlewareContext = { type: "llm", messages: [], metadata: {} };

    await mw.beforeLLM!(ctx, async () => {});
    expect(ctx.metadata._llmStart).toBeDefined();

    ctx.result = { content: "ok", toolCalls: [] };
    await mw.afterLLM!(ctx, async () => {});
  });
});

describe("RetryMiddleware", () => {
  it("should be instantiable with defaults", () => {
    const mw = new RetryMiddleware();
    expect(mw.name).toBe("retry");
  });

  it("should set _shouldRetry on LLM error within retry limit", async () => {
    const mw = new RetryMiddleware({ maxRetries: 3, baseDelayMs: 10 });
    const ctx: MiddlewareContext = {
      type: "llm",
      metadata: {},
      error: new Error("fail"),
    };

    await mw.onError!(ctx, async () => {});
    expect(ctx.metadata._shouldRetry).toBe(true);
    expect(ctx.metadata._retryAttempt).toBe(1);
  });

  it("should not retry after max retries exhausted", async () => {
    const mw = new RetryMiddleware({ maxRetries: 2, baseDelayMs: 10 });
    const ctx: MiddlewareContext = {
      type: "llm",
      metadata: { _retryAttempt: 2 },
      error: new Error("fail"),
    };

    await mw.onError!(ctx, async () => {});
    expect(ctx.metadata._shouldRetry).toBeUndefined();
  });

  it("should not retry tool errors", async () => {
    const mw = new RetryMiddleware({ maxRetries: 3, baseDelayMs: 10 });
    const ctx: MiddlewareContext = {
      type: "tool",
      metadata: {},
      error: new Error("tool fail"),
    };

    await mw.onError!(ctx, async () => {});
    expect(ctx.metadata._shouldRetry).toBeUndefined();
  });
});

// ── BudgetMeter ─────────────────────────────────────────────────────

describe("BudgetMeter", () => {
  it("should instantiate with defaults", () => {
    const bm = new BudgetMeter();
    const s = bm.stats();
    expect(s.toolCalls).toBe(0);
    expect(s.tokens).toBe(0);
  });

  it("should block when maxTokens exceeded in afterLLM", async () => {
    const bm = new BudgetMeter({ maxTokens: 100 });
    const ctx: MiddlewareContext = {
      type: "llm",
      metadata: { _tokensUsed: 150 },
      result: { content: "ok", toolCalls: [] },
    };

    await bm.afterLLM!(ctx, async () => {});
    expect(ctx.error).toBeDefined();
    expect(ctx.error!.message).toContain("token limit");
    expect(ctx.metadata._budgetExceeded).toBe(true);
  });

  it("should allow afterLLM when under token limit", async () => {
    const bm = new BudgetMeter({ maxTokens: 200 });
    const ctx: MiddlewareContext = {
      type: "llm",
      metadata: { _tokensUsed: 50 },
      result: { content: "ok", toolCalls: [] },
    };

    let nextCalled = false;
    await bm.afterLLM!(ctx, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(ctx.error).toBeUndefined();
    expect(bm.stats().tokens).toBe(50);
  });

  it("should accumulate tokens across multiple afterLLM calls", async () => {
    const bm = new BudgetMeter({ maxTokens: 200 });

    const ctx1: MiddlewareContext = { type: "llm", metadata: { _tokensUsed: 80 }, result: { content: "a", toolCalls: [] } };
    await bm.afterLLM!(ctx1, async () => {});

    const ctx2: MiddlewareContext = { type: "llm", metadata: { _tokensUsed: 90 }, result: { content: "b", toolCalls: [] } };
    await bm.afterLLM!(ctx2, async () => {});

    expect(bm.stats().tokens).toBe(170);
    expect(ctx2.error).toBeUndefined();

    // Third call pushes over the limit
    const ctx3: MiddlewareContext = { type: "llm", metadata: { _tokensUsed: 50 }, result: { content: "c", toolCalls: [] } };
    await bm.afterLLM!(ctx3, async () => {});
    expect(ctx3.error).toBeDefined();
    expect(ctx3.error!.message).toContain("220 used");
  });

  it("should reset token count via resetRun()", async () => {
    const bm = new BudgetMeter({ maxTokens: 100 });
    const ctx1: MiddlewareContext = { type: "llm", metadata: { _tokensUsed: 80 }, result: { content: "a", toolCalls: [] } };
    await bm.afterLLM!(ctx1, async () => {});
    expect(bm.stats().tokens).toBe(80);

    bm.resetRun();
    expect(bm.stats().tokens).toBe(0);
    expect(bm.stats().toolCalls).toBe(0);
  });

  it("should enforce tool call limit", async () => {
    const bm = new BudgetMeter({ maxToolCalls: 2, wallClockMs: 60_000 });
    bm.resetRun();

    const ctx1: MiddlewareContext = { type: "tool", toolCall: { id: "1", name: "a", arguments: {} }, metadata: {} };
    await bm.beforeToolCall!(ctx1, async () => {});
    expect(ctx1.error).toBeUndefined();

    const ctx2: MiddlewareContext = { type: "tool", toolCall: { id: "2", name: "b", arguments: {} }, metadata: {} };
    await bm.beforeToolCall!(ctx2, async () => {});
    expect(ctx2.error).toBeUndefined();

    // Third call exceeds limit
    const ctx3: MiddlewareContext = { type: "tool", toolCall: { id: "3", name: "c", arguments: {} }, metadata: {} };
    await bm.beforeToolCall!(ctx3, async () => {});
    expect(ctx3.error).toBeDefined();
    expect(ctx3.error!.message).toContain("tool call limit");
  });

  it("should skip token accounting when no _tokensUsed in metadata", async () => {
    const bm = new BudgetMeter({ maxTokens: 100 });
    const ctx: MiddlewareContext = { type: "llm", metadata: {}, result: { content: "ok", toolCalls: [] } };

    let nextCalled = false;
    await bm.afterLLM!(ctx, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(bm.stats().tokens).toBe(0);
  });

  it("should return correct stats", async () => {
    const bm = new BudgetMeter({ maxToolCalls: 50, maxTokens: 1000 });
    bm.resetRun();

    // Simulate a beforeToolCall
    const toolCtx: MiddlewareContext = { type: "tool", toolCall: { id: "1", name: "echo", arguments: {} }, metadata: {} };
    await bm.beforeToolCall!(toolCtx, async () => {});

    // Simulate an afterLLM with tokens
    const llmCtx: MiddlewareContext = { type: "llm", metadata: { _tokensUsed: 42 }, result: { content: "x", toolCalls: [] } };
    await bm.afterLLM!(llmCtx, async () => {});

    const s = bm.stats();
    expect(s.toolCalls).toBe(1);
    expect(s.tokens).toBe(42);
    expect(s.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
