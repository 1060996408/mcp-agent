import { describe, it, expect } from "vitest";
import {
  validateConfig,
  validateServerConfig,
  MCPServerConfigSchema,
  LLMConfigSchema,
  ConversationConfigSchema,
} from "../src/validation.js";

// ── MCPServerConfig validation ─────────────────────────────────────

describe("MCPServerConfigSchema", () => {
  it("should accept valid stdio config", () => {
    const result = MCPServerConfigSchema.safeParse({
      command: "node",
      args: ["server.js"],
    });
    expect(result.success).toBe(true);
  });

  it("should accept stdio config with all optional fields", () => {
    const result = MCPServerConfigSchema.safeParse({
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { FOO: "bar" },
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid sse config", () => {
    const result = MCPServerConfigSchema.safeParse({
      transport: "sse",
      url: "http://localhost:3000/sse",
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid streamable-http config", () => {
    const result = MCPServerConfigSchema.safeParse({
      transport: "streamable-http",
      url: "http://localhost:3000/mcp",
    });
    expect(result.success).toBe(true);
  });

  it("should reject sse without url", () => {
    const result = MCPServerConfigSchema.safeParse({
      transport: "sse",
    });
    expect(result.success).toBe(false);
  });

  it("should reject streamable-http without url", () => {
    const result = MCPServerConfigSchema.safeParse({
      transport: "streamable-http",
      command: "node",
    });
    expect(result.success).toBe(false);
  });

  it("should reject stdio without command or url", () => {
    const result = MCPServerConfigSchema.safeParse({
      args: ["server.js"],
    });
    expect(result.success).toBe(false);
  });

  it("should reject invalid transport type", () => {
    const result = MCPServerConfigSchema.safeParse({
      transport: "websocket",
      url: "ws://localhost:3000",
    });
    expect(result.success).toBe(false);
  });

  it("should reject invalid url format", () => {
    const result = MCPServerConfigSchema.safeParse({
      transport: "sse",
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

// ── LLMConfig validation ───────────────────────────────────────────

describe("LLMConfigSchema", () => {
  it("should accept valid config", () => {
    const result = LLMConfigSchema.safeParse({
      baseUrl: "http://localhost:8080/v1",
      apiKey: "sk-123",
      model: "gpt-4",
      maxTokens: 4096,
      temperature: 0.7,
    });
    expect(result.success).toBe(true);
  });

  it("should accept minimal config (only baseUrl)", () => {
    const result = LLMConfigSchema.safeParse({
      baseUrl: "http://localhost:8080/v1",
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid baseUrl", () => {
    const result = LLMConfigSchema.safeParse({
      baseUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("should reject negative maxTokens", () => {
    const result = LLMConfigSchema.safeParse({
      baseUrl: "http://localhost:8080/v1",
      maxTokens: -1,
    });
    expect(result.success).toBe(false);
  });

  it("should reject temperature > 2", () => {
    const result = LLMConfigSchema.safeParse({
      baseUrl: "http://localhost:8080/v1",
      temperature: 3,
    });
    expect(result.success).toBe(false);
  });
});

// ── ConversationConfig validation ──────────────────────────────────

describe("ConversationConfigSchema", () => {
  it("should accept valid config", () => {
    const result = ConversationConfigSchema.safeParse({
      maxHistoryMessages: 100,
      maxToolRounds: 20,
    });
    expect(result.success).toBe(true);
  });

  it("should accept empty config", () => {
    const result = ConversationConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should reject zero maxHistoryMessages", () => {
    const result = ConversationConfigSchema.safeParse({
      maxHistoryMessages: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ── validateConfig (full config) ───────────────────────────────────

describe("validateConfig", () => {
  it("should accept valid full config", () => {
    const config = {
      servers: {
        filesystem: { command: "node", args: ["server.js"] },
      },
      llm: { baseUrl: "http://localhost:8080/v1" },
      router: { conflictStrategy: "prefix" as const },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("should accept config with only servers", () => {
    const config = {
      servers: {
        fs: { command: "node", args: ["fs.js"] },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("should reject config with no servers", () => {
    const config = { servers: {} };
    expect(() => validateConfig(config)).toThrow(/at least one server/i);
  });

  it("should reject config with invalid server", () => {
    const config = {
      servers: {
        bad: { transport: "sse" }, // sse without url
      },
    };
    expect(() => validateConfig(config)).toThrow();
  });

  it("should provide clear error messages with field paths", () => {
    const config = {
      servers: {
        test: { command: "node" },
      },
      llm: { baseUrl: "not-a-url" },
    };
    expect(() => validateConfig(config)).toThrow(/baseUrl/);
  });
});

// ── validateServerConfig ───────────────────────────────────────────

describe("validateServerConfig", () => {
  it("should return validated config", () => {
    const result = validateServerConfig("test", { command: "node", args: ["x.js"] });
    expect(result.command).toBe("node");
  });

  it("should throw with server name in error", () => {
    expect(() => validateServerConfig("my-server", { transport: "sse" }))
      .toThrow(/my-server/);
  });
});
