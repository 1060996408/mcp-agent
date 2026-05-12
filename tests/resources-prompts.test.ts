import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MCPPool } from "../src/pool.js";
import { ResourceManager } from "../src/resources.js";
import { PromptManager } from "../src/prompts.js";
import { Context } from "../src/context.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MCPServerInstance } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

describe("ResourceManager", () => {
  let pool: MCPPool;
  let instances: MCPServerInstance[];

  beforeAll(async () => {
    pool = new MCPPool();
    await pool.connect("mock", { command: "npx", args: ["tsx", MOCK_SERVER] });
    instances = pool.getAll();
  });

  afterAll(async () => {
    await pool.close();
  });

  it("should build resource index without errors", async () => {
    const rm = new ResourceManager();
    await rm.buildIndex(instances);
    // Mock server may or may not have resources — should not throw
    expect(rm.size).toBeGreaterThanOrEqual(0);
  });

  it("should list resources", async () => {
    const rm = new ResourceManager();
    await rm.buildIndex(instances);
    const list = rm.list();
    expect(Array.isArray(list)).toBe(true);
    // Each resource should have uri and name
    for (const r of list) {
      expect(r.uri).toBeDefined();
      expect(r.name).toBeDefined();
    }
  });

  it("should return null for unknown resource URI", async () => {
    const rm = new ResourceManager();
    await rm.buildIndex(instances);
    const result = await rm.read("nonexistent://resource");
    expect(result).toBeNull();
  });
});

describe("PromptManager", () => {
  let pool: MCPPool;
  let instances: MCPServerInstance[];

  beforeAll(async () => {
    pool = new MCPPool();
    await pool.connect("mock", { command: "npx", args: ["tsx", MOCK_SERVER] });
    instances = pool.getAll();
  });

  afterAll(async () => {
    await pool.close();
  });

  it("should build prompt index without errors", async () => {
    const pm = new PromptManager();
    await pm.buildIndex(instances);
    expect(pm.size).toBeGreaterThanOrEqual(0);
  });

  it("should list prompts", async () => {
    const pm = new PromptManager();
    await pm.buildIndex(instances);
    const list = pm.list();
    expect(Array.isArray(list)).toBe(true);
    for (const p of list) {
      expect(p.name).toBeDefined();
    }
  });

  it("should return null for unknown prompt", async () => {
    const pm = new PromptManager();
    await pm.buildIndex(instances);
    const result = await pm.get("nonexistent-prompt");
    expect(result).toBeNull();
  });
});

describe("Context with prompts and resources", () => {
  it("should include prompts in system prompt", () => {
    const ctx = new Context();
    ctx.setPrompts([
      { name: "summarize", description: "Summarize a document", arguments: [{ name: "text", required: true }] },
      { name: "translate", description: "Translate text" },
    ]);

    const prompt = ctx.buildSystemPrompt("Base prompt");
    expect(prompt).toContain("Available Prompt Templates");
    expect(prompt).toContain("**summarize**");
    expect(prompt).toContain("Summarize a document");
    expect(prompt).toContain("text*");
    expect(prompt).toContain("**translate**");
  });

  it("should include resources in system prompt", () => {
    const ctx = new Context();
    ctx.setResources([
      { uri: "file:///test.txt", name: "test.txt", description: "A test file", mimeType: "text/plain" },
    ]);

    const prompt = ctx.buildSystemPrompt("Base");
    expect(prompt).toContain("Available Resources");
    expect(prompt).toContain("**test.txt**");
    expect(prompt).toContain("file:///test.txt");
    expect(prompt).toContain("text/plain");
  });

  it("should handle empty prompts and resources gracefully", () => {
    const ctx = new Context();
    ctx.setPrompts([]);
    ctx.setResources([]);

    const prompt = ctx.buildSystemPrompt("Base");
    expect(prompt).not.toContain("Available Prompt Templates");
    expect(prompt).not.toContain("Available Resources");
    expect(prompt).toContain("Base");
  });
});
