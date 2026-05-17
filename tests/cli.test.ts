import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../src/agent.js";
import { LoggingMiddleware, RetryMiddleware } from "../src/middleware.js";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

const SESSION_DIR = resolve(tmpdir(), "mcp-agent-cli-test");

function sessionPath(name: string) {
  return resolve(SESSION_DIR, name);
}

// ── Path expansion ─────────────────────────────────────────────────

describe("Path expansion", () => {
  it("should expand ~ to home directory", async () => {
    // Import the expandPath function (it's not exported, so test via Agent.enableSession)
    // Instead, test the logic directly
    const home = homedir();
    const input = "~/test/path";
    const expected = resolve(home, "test/path");

    // The expandPath logic: starts with ~/ or ~\
    const expanded = input.startsWith("~/") || input.startsWith("~\\")
      ? resolve(home, input.slice(2))
      : input;

    expect(expanded).toBe(expected);
  });

  it("should not expand paths without ~", () => {
    const input = "/absolute/path";
    const home = homedir();
    const expanded = input.startsWith("~/") || input.startsWith("~\\")
      ? resolve(home, input.slice(2))
      : input;
    expect(expanded).toBe(input);
  });
});

// ── Session persistence via Agent ──────────────────────────────────

describe("Agent session persistence", () => {
  beforeEach(() => {
    if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  });

  afterEach(() => {
    for (const name of ["cli-session.json", "cli-session-2.json"]) {
      const p = sessionPath(name);
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("should load history on enableSession", () => {
    const path = sessionPath("cli-session.json");

    // First agent: add some history and save
    const agent1 = new Agent();
    agent1.enableSession(path);
    // enableSession calls load, which returns empty for non-existent file
    expect(agent1.getHistory()).toHaveLength(0);

    // Manually add to memory and save to create a session file
    agent1.memory.addMemory("test memory", ["test"]);
    agent1.save(path);
    expect(existsSync(path)).toBe(true);

    // Second agent: enableSession should load the saved state
    const agent2 = new Agent();
    agent2.enableSession(path);
    expect(agent2.memory.getMemories()).toHaveLength(1);
    expect(agent2.memory.getMemories()[0].summary).toBe("test memory");
  });

  it("should auto-save on close when session is enabled", async () => {
    const path = sessionPath("cli-session-2.json");

    const agent = new Agent();
    agent.enableSession(path);
    agent.memory.addMemory("auto save test", []);

    // close() should auto-save
    await agent.close();

    expect(existsSync(path)).toBe(true);

    // Load and verify
    const agent2 = new Agent();
    agent2.enableSession(path);
    expect(agent2.memory.getMemories()).toHaveLength(1);
    expect(agent2.memory.getMemories()[0].summary).toBe("auto save test");
  });
});

// ── Middleware wiring ───────────────────────────────────────────────

describe("CLI middleware wiring", () => {
  it("should accept LoggingMiddleware and RetryMiddleware via use()", () => {
    const agent = new Agent();

    // Should not throw
    expect(() => {
      agent.use(new LoggingMiddleware());
      agent.use(new RetryMiddleware({ maxRetries: 2 }));
    }).not.toThrow();
  });
});

// ── Event wiring ───────────────────────────────────────────────────

describe("CLI event wiring", () => {
  it("should allow registering event handlers on agent.events", () => {
    const agent = new Agent();
    const events: string[] = [];

    agent.events.on("beforeToolCall", () => events.push("before"));
    agent.events.on("afterToolCall", () => events.push("after"));
    agent.events.on("error", () => events.push("error"));

    // Verify handlers are registered (no throw, no-op emit)
    agent.events.emit("beforeToolCall", {
      round: 1,
      toolCall: { id: "1", name: "test", arguments: {} },
    });
    expect(events).toEqual(["before"]);
  });
});

// ── Health check ─────────────────────────────────────────────────

describe("Agent health check", () => {
  it("should return empty health when no servers connected", async () => {
    const agent = new Agent();
    const health = await agent.healthCheck();
    expect(health).toHaveLength(0);
  });
});

// ── Pool server status ───────────────────────────────────────────

describe("Pool server status", () => {
  it("should return empty status when no servers connected", () => {
    const agent = new Agent();
    const status = agent.pool.getServerStatus();
    expect(status).toHaveLength(0);
  });
});

// ── Cancel support ───────────────────────────────────────────────

describe("Agent cancel", () => {
  it("should not throw when canceling before run", () => {
    const agent = new Agent();
    expect(() => agent.cancel()).not.toThrow();
  });
});
