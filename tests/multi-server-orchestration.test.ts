import { describe, it, expect, vi } from "vitest";
import { MCPPool } from "../src/pool.js";
import type { ServerHealth } from "../src/pool.js";
import { ToolRouter } from "../src/router.js";
import type { AggregatedTool, MCPServerInstance } from "../src/types.js";

// ── ToolRouter server-scoped queries ─────────────────────────────

describe("ToolRouter server-scoped queries", () => {
  function makeRouterWithTools(): ToolRouter {
    const router = new ToolRouter();

    // Manually populate the internal maps by mocking buildIndex
    // We'll use registerLocalTool for simplicity, but also test getToolsByServer
    // by directly manipulating through buildIndex with mock instances
    return router;
  }

  function makeMockInstance(name: string, tools: Array<{ name: string; description?: string }>): MCPServerInstance {
    return {
      name,
      client: {
        listTools: vi.fn().mockResolvedValue({ tools }),
        callTool: vi.fn(),
        listResources: vi.fn().mockResolvedValue({ resources: [] }),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
        close: vi.fn(),
      } as any,
      transport: {} as any,
    };
  }

  it("should return tools from a specific server", async () => {
    const router = new ToolRouter();
    const fs = makeMockInstance("filesystem", [
      { name: "read_file", description: "Read a file" },
      { name: "write_file", description: "Write a file" },
    ]);
    const gh = makeMockInstance("github", [
      { name: "list_prs", description: "List pull requests" },
    ]);

    await router.buildIndex([fs, gh]);

    const fsTools = router.getToolsByServer("filesystem");
    expect(fsTools).toHaveLength(2);
    expect(fsTools.map((t) => t.name)).toContain("read_file");
    expect(fsTools.map((t) => t.name)).toContain("write_file");

    const ghTools = router.getToolsByServer("github");
    expect(ghTools).toHaveLength(1);
    expect(ghTools[0].name).toBe("list_prs");
  });

  it("should return empty array for unknown server", async () => {
    const router = new ToolRouter();
    const fs = makeMockInstance("filesystem", [{ name: "read_file" }]);
    await router.buildIndex([fs]);

    const tools = router.getToolsByServer("nonexistent");
    expect(tools).toHaveLength(0);
  });

  it("should return server name for a tool", async () => {
    const router = new ToolRouter();
    const fs = makeMockInstance("filesystem", [{ name: "read_file" }]);
    const gh = makeMockInstance("github", [{ name: "list_prs" }]);
    await router.buildIndex([fs, gh]);

    expect(router.getServerForTool("read_file")).toBe("filesystem");
    expect(router.getServerForTool("list_prs")).toBe("github");
    expect(router.getServerForTool("nonexistent")).toBeUndefined();
  });

  it("should return all server names", async () => {
    const router = new ToolRouter();
    const fs = makeMockInstance("filesystem", [{ name: "read_file" }]);
    const gh = makeMockInstance("github", [{ name: "list_prs" }]);
    await router.buildIndex([fs, gh]);

    const names = router.getServerNames();
    expect(names).toContain("filesystem");
    expect(names).toContain("github");
    expect(names).toHaveLength(2);
  });

  it("should include local tools in getToolsByServer", async () => {
    const router = new ToolRouter();
    router.registerLocalTool("my_tool", "A local tool", { type: "object", properties: {} }, async () => ({ content: "ok", isError: false }));

    const tools = router.getToolsByServer("__local__");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("my_tool");
  });
});

// ── MCPPool health check ─────────────────────────────────────────

describe("MCPPool health check", () => {
  it("should return empty array when no servers connected", async () => {
    const pool = new MCPPool();
    const health = await pool.healthCheck();
    expect(health).toHaveLength(0);
  });

  it("should return healthy status for responsive server", async () => {
    const pool = new MCPPool();
    // Manually add an instance to the pool's internal map
    const mockInstance: MCPServerInstance = {
      name: "test-server",
      client: {
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: "t1" }] }),
        close: vi.fn(),
      } as any,
      transport: {} as any,
    };

    // Use the pool's internal map via a workaround
    (pool as any).instances.set("test-server", mockInstance);

    const health = await pool.healthCheck();
    expect(health).toHaveLength(1);
    expect(health[0].name).toBe("test-server");
    expect(health[0].healthy).toBe(true);
    expect(health[0].toolCount).toBe(1);
    expect(health[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should return unhealthy status when server fails", async () => {
    const pool = new MCPPool();
    const mockInstance: MCPServerInstance = {
      name: "bad-server",
      client: {
        listTools: vi.fn().mockRejectedValue(new Error("connection lost")),
        close: vi.fn(),
      } as any,
      transport: {} as any,
    };

    (pool as any).instances.set("bad-server", mockInstance);

    const health = await pool.healthCheck();
    expect(health).toHaveLength(1);
    expect(health[0].name).toBe("bad-server");
    expect(health[0].healthy).toBe(false);
    expect(health[0].error).toBe("connection lost");
  });

  it("should check multiple servers in parallel", async () => {
    const pool = new MCPPool();

    for (const name of ["a", "b", "c"]) {
      (pool as any).instances.set(name, {
        name,
        client: { listTools: vi.fn().mockResolvedValue({ tools: [] }) } as any,
        transport: {} as any,
      });
    }

    const health = await pool.healthCheck();
    expect(health).toHaveLength(3);
    expect(health.every((h) => h.healthy)).toBe(true);
  });
});

// ── MCPPool server status ────────────────────────────────────────

describe("MCPPool getServerStatus", () => {
  it("should return empty when no servers connected", () => {
    const pool = new MCPPool();
    const status = pool.getServerStatus();
    expect(status).toHaveLength(0);
  });

  it("should return transport type for connected servers", () => {
    const pool = new MCPPool();

    // Store configs
    (pool as any).configs.set("stdio-server", { command: "node", args: ["server.js"] });
    (pool as any).configs.set("http-server", { transport: "streamable-http", url: "http://localhost:3000" });

    // Add mock instances
    for (const name of ["stdio-server", "http-server"]) {
      (pool as any).instances.set(name, {
        name,
        client: {} as any,
        transport: {} as any,
      });
    }

    const status = pool.getServerStatus();
    expect(status).toHaveLength(2);

    const stdio = status.find((s) => s.name === "stdio-server");
    expect(stdio?.transport).toBe("stdio");
    expect(stdio?.connected).toBe(true);

    const http = status.find((s) => s.name === "http-server");
    expect(http?.transport).toBe("streamable-http");
    expect(http?.connected).toBe(true);
  });
});
