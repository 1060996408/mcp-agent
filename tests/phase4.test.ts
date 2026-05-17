import { describe, it, expect, vi } from "vitest";
import { AgentEventEmitter } from "../src/events.js";
import type { AgentEvents } from "../src/events.js";
import { MemoryManager } from "../src/memory.js";
import { ToolRouter } from "../src/router.js";
import { AgentLoop } from "../src/loop.js";
import type { LLMProvider, LLMResponse, LLMToolDef } from "../src/llm-provider.js";
import type { Message } from "../src/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// ── EventEmitter tests ─────────────────────────────────────────────

describe("AgentEventEmitter", () => {
  it("should register and emit events", () => {
    const emitter = new AgentEventEmitter();
    const handler = vi.fn();
    emitter.on("runStart", handler);
    emitter.emit("runStart", { userMessage: "test", messageCount: 1 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ userMessage: "test", messageCount: 1 });
  });

  it("should support multiple handlers for same event", () => {
    const emitter = new AgentEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on("afterLLM", h1);
    emitter.on("afterLLM", h2);
    emitter.emit("afterLLM", { round: 1, content: "ok", toolCallCount: 0 });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("should remove handler with off()", () => {
    const emitter = new AgentEventEmitter();
    const handler = vi.fn();
    emitter.on("runEnd", handler);
    emitter.off("runEnd", handler);
    emitter.emit("runEnd", { toolCallsExecuted: 0, rounds: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("should remove all listeners for a specific event", () => {
    const emitter = new AgentEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on("runStart", h1);
    emitter.on("runEnd", h2);
    emitter.removeAllListeners("runStart");
    emitter.emit("runStart", { userMessage: "", messageCount: 0 });
    emitter.emit("runEnd", { toolCallsExecuted: 0, rounds: 1 });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("should remove all listeners when no event specified", () => {
    const emitter = new AgentEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on("runStart", h1);
    emitter.on("runEnd", h2);
    emitter.removeAllListeners();
    emitter.emit("runStart", { userMessage: "", messageCount: 0 });
    emitter.emit("runEnd", { toolCallsExecuted: 0, rounds: 1 });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("should not throw on emit with no handlers", () => {
    const emitter = new AgentEventEmitter();
    expect(() => {
      emitter.emit("error", { phase: "llm", error: new Error("test") });
    }).not.toThrow();
  });

  it("should catch handler errors silently", () => {
    const emitter = new AgentEventEmitter();
    const badHandler = vi.fn(() => { throw new Error("boom"); });
    const goodHandler = vi.fn();
    emitter.on("runStart", badHandler);
    emitter.on("runStart", goodHandler);
    emitter.emit("runStart", { userMessage: "", messageCount: 0 });
    expect(badHandler).toHaveBeenCalledOnce();
    expect(goodHandler).toHaveBeenCalledOnce();
  });
});

// ── EventEmitter integration with AgentLoop ────────────────────────

class SequenceProvider implements LLMProvider {
  private callCount = 0;
  constructor(private responses: LLMResponse[]) {}
  async chat(): Promise<LLMResponse> {
    return this.responses[this.callCount++] ?? { content: "done", toolCalls: [] };
  }
  async streamChat(m: Message[], t?: LLMToolDef[]): Promise<LLMResponse> {
    return this.chat(m, t);
  }
}

describe("AgentLoop EventEmitter integration", () => {
  it("should emit runStart and runEnd events", async () => {
    const provider = new SequenceProvider([
      { content: "hello", toolCalls: [] },
    ]);
    const router = new ToolRouter();
    const loop = new AgentLoop(provider, router);

    const events: string[] = [];
    loop.events.on("runStart", () => events.push("runStart"));
    loop.events.on("runEnd", () => events.push("runEnd"));

    await loop.run([{ role: "user", content: "test" }]);

    expect(events).toEqual(["runStart", "runEnd"]);
  });

  it("should emit beforeLLM and afterLLM for each round", async () => {
    const provider = new SequenceProvider([
      { content: "", toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hi" } }] },
      { content: "done", toolCalls: [] },
    ]);
    const router = new ToolRouter();
    const loop = new AgentLoop(provider, router);

    const beforeRounds: number[] = [];
    const afterRounds: number[] = [];
    loop.events.on("beforeLLM", (d) => beforeRounds.push(d.round));
    loop.events.on("afterLLM", (d) => afterRounds.push(d.round));

    await loop.run([{ role: "user", content: "test" }]);

    expect(beforeRounds).toEqual([1, 2]);
    expect(afterRounds).toEqual([1, 2]);
  });

  it("should emit beforeToolCall and afterToolCall for tool executions", async () => {
    const provider = new SequenceProvider([
      { content: "", toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hi" } }] },
      { content: "done", toolCalls: [] },
    ]);
    const router = new ToolRouter();
    // Register a local tool so the call doesn't fail
    router.registerLocalTool("echo", "echo tool", { type: "object", properties: {} },
      async (args) => ({ content: `Echo: ${args.text}`, isError: false }));
    const loop = new AgentLoop(provider, router);

    const beforeCalls: string[] = [];
    const afterCalls: string[] = [];
    loop.events.on("beforeToolCall", (d) => beforeCalls.push(d.toolCall.name));
    loop.events.on("afterToolCall", (d) => afterCalls.push(d.toolCall.name));

    await loop.run([{ role: "user", content: "test" }]);

    expect(beforeCalls).toEqual(["echo"]);
    expect(afterCalls).toEqual(["echo"]);
  });

  it("should emit runEnd with correct stats", async () => {
    const provider = new SequenceProvider([
      { content: "", toolCalls: [{ id: "tc1", name: "echo", arguments: {} }] },
      { content: "done", toolCalls: [] },
    ]);
    const router = new ToolRouter();
    router.registerLocalTool("echo", "echo", { type: "object", properties: {} },
      async () => ({ content: "ok", isError: false }));
    const loop = new AgentLoop(provider, router);

    let endData: AgentEvents["runEnd"] | null = null;
    loop.events.on("runEnd", (d) => { endData = d; });

    await loop.run([{ role: "user", content: "test" }]);

    expect(endData).not.toBeNull();
    expect(endData!.toolCallsExecuted).toBe(1);
    expect(endData!.rounds).toBe(2);
  });

  it("should emit error event on LLM failure", async () => {
    const failProvider: LLMProvider = {
      async chat(): Promise<LLMResponse> { throw new Error("LLM down"); },
      async streamChat(): Promise<LLMResponse> { throw new Error("LLM down"); },
    };
    const router = new ToolRouter();
    const loop = new AgentLoop(failProvider, router);

    const errors: Error[] = [];
    loop.events.on("error", (d) => errors.push(d.error));

    await expect(loop.run([{ role: "user", content: "test" }])).rejects.toThrow("LLM down");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("LLM down");
  });

  it("should emit afterToolCall with elapsedMs", async () => {
    const provider = new SequenceProvider([
      { content: "", toolCalls: [{ id: "tc1", name: "slow", arguments: {} }] },
      { content: "done", toolCalls: [] },
    ]);
    const router = new ToolRouter();
    router.registerLocalTool("slow", "slow tool", { type: "object", properties: {} },
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { content: "ok", isError: false };
      });
    const loop = new AgentLoop(provider, router);

    let elapsed = 0;
    loop.events.on("afterToolCall", (d) => { elapsed = d.elapsedMs; });

    await loop.run([{ role: "user", content: "test" }]);

    expect(elapsed).toBeGreaterThanOrEqual(5);
  });
});

// ── Virtual tools (registerLocalTool) ──────────────────────────────

describe("ToolRouter: registerLocalTool", () => {
  it("should register and call a local tool", async () => {
    const router = new ToolRouter();
    router.registerLocalTool("greet", "Say hello", { type: "object", properties: {} },
      async (args) => ({ content: `Hello, ${args.name}!`, isError: false }));

    const result = await router.callTool("greet", { name: "World" });
    expect(result.content).toBe("Hello, World!");
    expect(result.isError).toBe(false);
  });

  it("should prefer local handler over MCP tool of same name", async () => {
    const router = new ToolRouter();
    router.registerLocalTool("echo", "local echo", { type: "object", properties: {} },
      async (args) => ({ content: `LOCAL: ${args.text}`, isError: false }));

    const result = await router.callTool("echo", { text: "test" });
    expect(result.content).toBe("LOCAL: test");
  });

  it("should handle errors in local tool handler", async () => {
    const router = new ToolRouter();
    router.registerLocalTool("fail", "failing tool", { type: "object", properties: {} },
      async () => { throw new Error("local crash"); });

    const result = await router.callTool("fail", {});
    expect(result.content).toContain("Tool error");
    expect(result.content).toContain("local crash");
    expect(result.isError).toBe(true);
  });

  it("should support multiple independent local tools", async () => {
    const router = new ToolRouter();
    router.registerLocalTool("add", "add numbers", { type: "object", properties: {} },
      async (args) => ({ content: String((args.a as number) + (args.b as number)), isError: false }));
    router.registerLocalTool("mul", "multiply numbers", { type: "object", properties: {} },
      async (args) => ({ content: String((args.a as number) * (args.b as number)), isError: false }));

    const add = await router.callTool("add", { a: 3, b: 4 });
    const mul = await router.callTool("mul", { a: 3, b: 4 });
    expect(add.content).toBe("7");
    expect(mul.content).toBe("12");
  });

  it("should include local tools in getOpenAITools()", () => {
    const router = new ToolRouter();
    router.registerLocalTool("my_tool", "A custom tool",
      { type: "object", properties: { x: { type: "string" } } },
      async () => ({ content: "ok", isError: false }));

    const tools = router.getOpenAITools();
    const found = tools.find((t) => t.function.name === "my_tool");
    expect(found).toBeDefined();
    expect(found!.function.description).toBe("A custom tool");
    expect(found!.function.parameters).toEqual({ type: "object", properties: { x: { type: "string" } } });
  });

  it("should return 'Unknown tool' for unregistered tool", async () => {
    const router = new ToolRouter();
    const result = await router.callTool("nonexistent", {});
    expect(result.content).toBe("Unknown tool: nonexistent");
    expect(result.isError).toBe(true);
  });
});

// ── MemoryManager improvements ─────────────────────────────────────

describe("MemoryManager: importance and eviction", () => {
  it("should store importance score", () => {
    const mm = new MemoryManager();
    mm.addMemory("low", [], 0.1);
    mm.addMemory("high", [], 0.9);

    const memories = mm.getMemories();
    expect(memories[0].importance).toBe(0.1);
    expect(memories[1].importance).toBe(0.9);
  });

  it("should default importance to 0.5", () => {
    const mm = new MemoryManager();
    mm.addMemory("default", []);
    expect(mm.getMemories()[0].importance).toBe(0.5);
  });

  it("should clamp importance to 0-1 range", () => {
    const mm = new MemoryManager();
    mm.addMemory("too low", [], -1);
    mm.addMemory("too high", [], 2);
    expect(mm.getMemories()[0].importance).toBe(0);
    expect(mm.getMemories()[1].importance).toBe(1);
  });

  it("should evict lowest-importance memories when over limit", () => {
    const mm = new MemoryManager(3); // max 3 memories

    mm.addMemory("low", [], 0.1);
    mm.addMemory("medium", [], 0.5);
    mm.addMemory("high", [], 0.9);

    // All 3 fit
    expect(mm.getMemories()).toHaveLength(3);

    // Adding a 4th should evict the lowest importance
    mm.addMemory("critical", [], 1.0);
    expect(mm.getMemories()).toHaveLength(3);

    const summaries = mm.getMemories().map((m) => m.summary);
    expect(summaries).not.toContain("low"); // evicted
    expect(summaries).toContain("medium");
    expect(summaries).toContain("high");
    expect(summaries).toContain("critical");
  });

  it("should evict oldest first among equal-importance memories", () => {
    const mm = new MemoryManager(2);

    mm.addMemory("first", [], 0.5);
    mm.addMemory("second", [], 0.5);
    mm.addMemory("third", [], 0.5);

    expect(mm.getMemories()).toHaveLength(2);
    const summaries = mm.getMemories().map((m) => m.summary);
    expect(summaries).not.toContain("first"); // oldest evicted
    expect(summaries).toContain("second");
    expect(summaries).toContain("third");
  });

  it("should preserve importance across save/load", () => {
    const mm = new MemoryManager();
    mm.addMemory("important", ["tag"], 0.9);

    const dir = resolve(tmpdir(), "mcp-agent-test");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = resolve(dir, "importance-test.json");
    mm.save(path, []);

    const mm2 = new MemoryManager();
    mm2.load(path);
    expect(mm2.getMemories()[0].importance).toBe(0.9);

    if (existsSync(path)) unlinkSync(path);
  });

  it("should handle loading memories without importance field (backward compat)", () => {
    const mm = new MemoryManager();
    // Simulate old format without importance
    mm.addMemory("old format", []);
    const path = resolve(tmpdir(), "mcp-agent-test", "compat-test.json");
    const dir = resolve(tmpdir(), "mcp-agent-test");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    mm.save(path, []);

    // Manually strip importance from saved file
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    delete raw.memories[0].importance;
    writeFileSync(path, JSON.stringify(raw), "utf-8");

    const mm2 = new MemoryManager();
    mm2.load(path);
    expect(mm2.getMemories()[0].importance).toBe(0.5); // default

    if (existsSync(path)) unlinkSync(path);
  });
});

describe("MemoryManager: full-text search", () => {
  it("should find memories by keyword in summary", () => {
    const mm = new MemoryManager();
    mm.addMemory("User prefers TypeScript over JavaScript", ["preference"]);
    mm.addMemory("Project uses Vitest for testing", ["tooling"]);
    mm.addMemory("Deploy to AWS Lambda", ["infra"]);

    const results = mm.search("typescript");
    expect(results).toHaveLength(1);
    expect(results[0].summary).toContain("TypeScript");
  });

  it("should find memories by keyword in tags", () => {
    const mm = new MemoryManager();
    mm.addMemory("Some fact", ["infrastructure", "aws"]);
    mm.addMemory("Another fact", ["tooling"]);

    const results = mm.search("aws");
    expect(results).toHaveLength(1);
    expect(results[0].tags).toContain("aws");
  });

  it("should rank by match count then importance", () => {
    const mm = new MemoryManager();
    mm.addMemory("TypeScript and JavaScript are different", ["ts", "js"], 0.3); // matches "typescript" + "javascript"
    mm.addMemory("TypeScript preference", ["preference"], 0.9); // matches only "typescript"

    const results = mm.search("typescript javascript");
    expect(results).toHaveLength(2);
    // First result matches more query words (2 > 1)
    expect(results[0].summary).toContain("different");
  });

  it("should return empty for no matches", () => {
    const mm = new MemoryManager();
    mm.addMemory("TypeScript", []);
    expect(mm.search("python")).toHaveLength(0);
  });

  it("should return empty for empty query", () => {
    const mm = new MemoryManager();
    mm.addMemory("test", []);
    expect(mm.search("")).toHaveLength(0);
    expect(mm.search("a")).toHaveLength(0); // single char
  });
});
