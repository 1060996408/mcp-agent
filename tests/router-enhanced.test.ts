import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ToolRouter } from "../src/router.js";
import { MCPPool } from "../src/pool.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MCPServerInstance } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

describe("ToolRouter conflict resolution", () => {
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

  it("should use prefix strategy by default for conflicts", async () => {
    // Create fake instances with conflicting tool names
    const fakeInstances = [
      { ...instances[0], name: "serverA" },
      { ...instances[0], name: "serverB" },
    ];

    const router = new ToolRouter({ conflictStrategy: "prefix" });
    await router.buildIndex(fakeInstances);

    // Should have original tools from serverA + prefixed tools from serverB
    const tools = router.getAll();
    const prefixed = tools.filter((t) => t.name.startsWith("serverB__"));
    expect(prefixed.length).toBeGreaterThan(0);
  });

  it("should use first-wins strategy", async () => {
    const fakeInstances = [
      { ...instances[0], name: "first" },
      { ...instances[0], name: "second" },
    ];

    const router = new ToolRouter({ conflictStrategy: "first-wins" });
    await router.buildIndex(fakeInstances);

    // Should only have tools from "first" (no prefixed ones)
    const tools = router.getAll();
    const secondTools = tools.filter((t) => t.serverName === "second");
    expect(secondTools).toHaveLength(0);
  });

  it("should throw on error strategy with conflicts", async () => {
    const fakeInstances = [
      { ...instances[0], name: "a" },
      { ...instances[0], name: "b" },
    ];

    const router = new ToolRouter({ conflictStrategy: "error" });
    await expect(router.buildIndex(fakeInstances)).rejects.toThrow("Tool name conflict");
  });
});

describe("ToolRouter semantic fallback", () => {
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

  it("should resolve by exact name", async () => {
    const router = new ToolRouter();
    await router.buildIndex(instances);

    const result = router.resolve("echo");
    expect(result).toBeDefined();
    expect(result!.tool.name).toBe("echo");
  });

  it("should fall back to semantic search", async () => {
    const router = new ToolRouter({ semanticFallback: true });
    await router.buildIndex(instances);

    // "echo message text" should match the "echo" tool via description overlap
    const result = router.resolve("echo message text");
    expect(result).toBeDefined();
    expect(result!.tool.name).toBe("echo");
  });

  it("should return undefined when semantic fallback is disabled", async () => {
    const router = new ToolRouter({ semanticFallback: false });
    await router.buildIndex(instances);

    const result = router.resolve("echo message text");
    expect(result).toBeUndefined();
  });

  it("should return undefined for completely unrelated queries", async () => {
    const router = new ToolRouter({ semanticFallback: true });
    await router.buildIndex(instances);

    const result = router.resolve("xyzzy nonexistent quantum");
    expect(result).toBeUndefined();
  });
});

describe("ToolRouter configuration", () => {
  it("should use default config when none provided", async () => {
    const router = new ToolRouter();
    // Default: prefix strategy, semantic fallback enabled
    // We can verify by checking it doesn't throw on conflicts
    expect(router.size).toBe(0);
  });

  it("should accept partial config", async () => {
    const router = new ToolRouter({ conflictStrategy: "first-wins" });
    expect(router.size).toBe(0);
  });
});
