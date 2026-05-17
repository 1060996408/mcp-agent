import { describe, it, expect, vi } from "vitest";
import { ToolRouter } from "../src/router.js";
import type { MCPServerInstance } from "../src/types.js";

function makeMockInstance(name: string, tools: Array<{ name: string; description?: string }>): MCPServerInstance {
  return {
    name,
    client: {
      listTools: vi.fn().mockResolvedValue({ tools }),
      close: vi.fn(),
    } as any,
    transport: {} as any,
  };
}

// ── Tool filtering (allow/deny) ──────────────────────────────────

describe("Tool filtering", () => {
  it("should only expose allowed tools when allowTools is set", async () => {
    const router = new ToolRouter({ allowTools: ["read_*", "list_*"] });
    const fs = makeMockInstance("fs", [
      { name: "read_file" },
      { name: "write_file" },
      { name: "list_files" },
      { name: "delete_file" },
    ]);
    await router.buildIndex([fs]);

    const tools = router.getAll();
    expect(tools.map((t) => t.name)).toContain("read_file");
    expect(tools.map((t) => t.name)).toContain("list_files");
    expect(tools.map((t) => t.name)).not.toContain("write_file");
    expect(tools.map((t) => t.name)).not.toContain("delete_file");
  });

  it("should hide denied tools when denyTools is set", async () => {
    const router = new ToolRouter({ denyTools: ["delete_*", "drop_*"] });
    const db = makeMockInstance("db", [
      { name: "query" },
      { name: "delete_row" },
      { name: "drop_table" },
      { name: "insert_row" },
    ]);
    await router.buildIndex([db]);

    const tools = router.getAll();
    expect(tools.map((t) => t.name)).toContain("query");
    expect(tools.map((t) => t.name)).toContain("insert_row");
    expect(tools.map((t) => t.name)).not.toContain("delete_row");
    expect(tools.map((t) => t.name)).not.toContain("drop_table");
  });

  it("should apply allow then deny (deny takes precedence)", async () => {
    const router = new ToolRouter({
      allowTools: ["*"],
      denyTools: ["dangerous_*"],
    });
    const server = makeMockInstance("s", [
      { name: "safe_tool" },
      { name: "dangerous_tool" },
    ]);
    await router.buildIndex([server]);

    const tools = router.getAll();
    expect(tools.map((t) => t.name)).toContain("safe_tool");
    expect(tools.map((t) => t.name)).not.toContain("dangerous_tool");
  });

  it("should not filter when allowTools and denyTools are empty", async () => {
    const router = new ToolRouter();
    const server = makeMockInstance("s", [
      { name: "tool_a" },
      { name: "tool_b" },
    ]);
    await router.buildIndex([server]);

    expect(router.getAll()).toHaveLength(2);
  });

  it("should filter OpenAI tool definitions too", async () => {
    const router = new ToolRouter({ allowTools: ["read_*"] });
    const fs = makeMockInstance("fs", [
      { name: "read_file", description: "Read" },
      { name: "write_file", description: "Write" },
    ]);
    await router.buildIndex([fs]);

    const openaiTools = router.getOpenAITools();
    expect(openaiTools).toHaveLength(1);
    expect(openaiTools[0].function.name).toBe("read_file");
  });
});

// ── Tool aliases ─────────────────────────────────────────────────

describe("Tool aliases", () => {
  it("should resolve tool via alias", async () => {
    const router = new ToolRouter();
    const fs = makeMockInstance("filesystem", [{ name: "read_file" }]);
    await router.buildIndex([fs]);

    router.alias("read", "read_file");

    const resolved = router.resolve("read");
    expect(resolved).toBeDefined();
    expect(resolved!.tool.name).toBe("read_file");
    expect(resolved!.server.name).toBe("filesystem");
  });

  it("should still resolve original name after alias is set", async () => {
    const router = new ToolRouter();
    const fs = makeMockInstance("filesystem", [{ name: "read_file" }]);
    await router.buildIndex([fs]);

    router.alias("read", "read_file");

    const resolved = router.resolve("read_file");
    expect(resolved).toBeDefined();
    expect(resolved!.tool.name).toBe("read_file");
  });

  it("should return undefined for unregistered alias", async () => {
    const router = new ToolRouter();
    const fs = makeMockInstance("filesystem", [{ name: "read_file" }]);
    await router.buildIndex([fs]);

    const resolved = router.resolve("nonexistent_alias");
    expect(resolved).toBeUndefined();
  });

  it("should support multiple aliases", async () => {
    const router = new ToolRouter();
    const fs = makeMockInstance("fs", [
      { name: "read_file" },
      { name: "write_file" },
    ]);
    await router.buildIndex([fs]);

    router.alias("read", "read_file");
    router.alias("write", "write_file");

    expect(router.resolve("read")!.tool.name).toBe("read_file");
    expect(router.resolve("write")!.tool.name).toBe("write_file");
  });
});

// ── Glob pattern matching ────────────────────────────────────────

describe("Glob pattern matching in filters", () => {
  it("should match exact names", async () => {
    const router = new ToolRouter({ allowTools: ["read_file"] });
    const server = makeMockInstance("s", [{ name: "read_file" }, { name: "write_file" }]);
    await router.buildIndex([server]);

    expect(router.getAll()).toHaveLength(1);
  });

  it("should match * wildcard at end", async () => {
    const router = new ToolRouter({ allowTools: ["git_*"] });
    const server = makeMockInstance("s", [
      { name: "git_push" },
      { name: "git_pull" },
      { name: "npm_install" },
    ]);
    await router.buildIndex([server]);

    expect(router.getAll()).toHaveLength(2);
  });

  it("should match * wildcard at start", async () => {
    const router = new ToolRouter({ denyTools: ["*_dangerous"] });
    const server = makeMockInstance("s", [
      { name: "read_file" },
      { name: "delete_dangerous" },
    ]);
    await router.buildIndex([server]);

    expect(router.getAll()).toHaveLength(1);
    expect(router.getAll()[0].name).toBe("read_file");
  });

  it("should match * wildcard in middle", async () => {
    const router = new ToolRouter({ allowTools: ["mcp__*__read"] });
    const server = makeMockInstance("s", [
      { name: "mcp__fs__read" },
      { name: "mcp__fs__write" },
      { name: "mcp__gh__read" },
    ]);
    await router.buildIndex([server]);

    expect(router.getAll()).toHaveLength(2);
  });
});
