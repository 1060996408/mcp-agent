import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryManager } from "../src/memory.js";
import { existsSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Message } from "../src/types.js";

function tmpPath(name: string) {
  return resolve(tmpdir(), "mcp-agent-test", name);
}

describe("MemoryManager", () => {
  let mm: MemoryManager;

  beforeEach(() => {
    mm = new MemoryManager();
    const dir = tmpPath("");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test files
    for (const name of ["save-test.json", "load-test.json", "roundtrip-test.json"]) {
      const p = tmpPath(name);
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("should add and retrieve memories", () => {
    mm.addMemory("User prefers TypeScript", ["preference"]);
    mm.addMemory("Project uses Vitest", ["tooling"]);

    const memories = mm.getMemories();
    expect(memories).toHaveLength(2);
    expect(memories[0].summary).toBe("User prefers TypeScript");
    expect(memories[0].tags).toEqual(["preference"]);
    expect(memories[1].summary).toBe("Project uses Vitest");
  });

  it("should auto-increment IDs", () => {
    mm.addMemory("first", []);
    mm.addMemory("second", []);
    mm.addMemory("third", []);

    const memories = mm.getMemories();
    expect(memories[0].id).toBe("1");
    expect(memories[1].id).toBe("2");
    expect(memories[2].id).toBe("3");
  });

  it("should search by tag", () => {
    mm.addMemory("TS preference", ["preference"]);
    mm.addMemory("Vitest setup", ["tooling"]);
    mm.addMemory("ESLint config", ["tooling", "config"]);

    const tooling = mm.searchByTag("tooling");
    expect(tooling).toHaveLength(2);
    expect(tooling[0].summary).toBe("Vitest setup");
    expect(tooling[1].summary).toBe("ESLint config");

    const config = mm.searchByTag("config");
    expect(config).toHaveLength(1);
    expect(config[0].summary).toBe("ESLint config");
  });

  it("should format memories for system prompt", () => {
    mm.addMemory("Prefers dark mode", ["preference"]);
    mm.addMemory("Uses pnpm", ["tooling"]);

    const formatted = mm.formatMemories();
    expect(formatted).toContain("## Long-term Memory");
    expect(formatted).toContain("- (1) Prefers dark mode [preference]");
    expect(formatted).toContain("- (2) Uses pnpm [tooling]");
  });

  it("should return empty string when no memories", () => {
    expect(mm.formatMemories()).toBe("");
  });

  it("should save and load conversation state", () => {
    const path = tmpPath("save-test.json");
    const history: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    mm.addMemory("Test memory", ["test"]);
    mm.save(path, history);

    expect(existsSync(path)).toBe(true);

    const mm2 = new MemoryManager();
    const loaded = mm2.load(path);

    expect(loaded).toHaveLength(2);
    expect(loaded[0].content).toBe("hello");
    expect(loaded[1].content).toBe("hi there");
    expect(mm2.getMemories()).toHaveLength(1);
    expect(mm2.getMemories()[0].summary).toBe("Test memory");
  });

  it("should handle loading non-existent file", () => {
    const loaded = mm.load(tmpPath("does-not-exist.json"));
    expect(loaded).toEqual([]);
  });

  it("should clear all memories", () => {
    mm.addMemory("one", []);
    mm.addMemory("two", []);
    expect(mm.getMemories()).toHaveLength(2);

    mm.clear();
    expect(mm.getMemories()).toHaveLength(0);
    expect(mm.formatMemories()).toBe("");
  });

  it("should preserve memories across save/load cycles", () => {
    const path = tmpPath("roundtrip-test.json");

    // First session: add memories and save
    mm.addMemory("Session 1 fact", ["s1"]);
    mm.save(path, []);

    // Second session: load, add more, save
    const mm2 = new MemoryManager();
    mm2.load(path);
    mm2.addMemory("Session 2 fact", ["s2"]);
    mm2.save(path, []);

    // Third session: load, verify both memories
    const mm3 = new MemoryManager();
    mm3.load(path);
    const memories = mm3.getMemories();
    expect(memories).toHaveLength(2);
    expect(memories[0].summary).toBe("Session 1 fact");
    expect(memories[1].summary).toBe("Session 2 fact");
  });

  it("should include timestamps in saved state", () => {
    const path = tmpPath("save-test.json");
    mm.addMemory("test", []);
    mm.save(path, []);

    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.metadata).toBeDefined();
    expect(raw.metadata.savedAt).toBeDefined();
    expect(raw.metadata.turns).toBe(0);
  });
});
