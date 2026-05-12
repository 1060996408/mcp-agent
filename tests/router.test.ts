import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MCPPool } from "../src/pool.js";
import { ToolRouter } from "../src/router.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

describe("ToolRouter", () => {
  let pool: MCPPool;
  let router: ToolRouter;

  beforeAll(async () => {
    pool = new MCPPool();
    await pool.connect("mock", {
      command: "npx",
      args: ["tsx", MOCK_SERVER],
    });
    router = new ToolRouter();
    await router.buildIndex(pool.getAll());
  });

  afterAll(async () => {
    await pool.close();
  });

  it("should discover tools from connected servers", () => {
    expect(router.size).toBe(2);
    const names = router.getAll().map((t) => t.name).sort();
    expect(names).toEqual(["add", "echo"]);
  });

  it("should generate OpenAI-compatible tool definitions", () => {
    const tools = router.getOpenAITools();
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.function.name).toBeDefined();
      expect(t.function.parameters).toBeDefined();
    }
  });

  it("should resolve tool to correct server", () => {
    const resolved = router.resolve("echo");
    expect(resolved).toBeDefined();
    expect(resolved!.server.name).toBe("mock");
    expect(resolved!.tool.name).toBe("echo");
  });

  it("should return undefined for unknown tools", () => {
    expect(router.resolve("nonexistent")).toBeUndefined();
  });

  it("should call echo tool", async () => {
    const result = await router.callTool("echo", { text: "hello" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Echo: hello");
  });

  it("should call add tool", async () => {
    const result = await router.callTool("add", { a: 3, b: 7 });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("10");
  });

  it("should handle unknown tool calls gracefully", async () => {
    const result = await router.callTool("nonexistent", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });
});

describe("MCPPool", () => {
  it("should track connected servers", async () => {
    const pool = new MCPPool();
    expect(pool.names()).toEqual([]);

    await pool.connect("test", {
      command: "npx",
      args: ["tsx", MOCK_SERVER],
    });

    expect(pool.has("test")).toBe(true);
    expect(pool.names()).toEqual(["test"]);
    expect(pool.get("test")!.name).toBe("test");

    await pool.close();
    expect(pool.names()).toEqual([]);
  });

  it("should skip duplicate connections", async () => {
    const pool = new MCPPool();
    await pool.connect("dup", { command: "npx", args: ["tsx", MOCK_SERVER] });
    await pool.connect("dup", { command: "npx", args: ["tsx", MOCK_SERVER] });
    expect(pool.names()).toEqual(["dup"]);
    await pool.close();
  });
});
