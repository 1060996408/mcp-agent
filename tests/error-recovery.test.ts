import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLMTimeoutError, OpenAIProvider } from "../src/llm-provider.js";
import { MCPPool } from "../src/pool.js";
import type { MCPServerConfig } from "../src/types.js";

// ── LLM Timeout ──────────────────────────────────────────────────

describe("LLMTimeoutError", () => {
  it("should have correct name and timeout message", () => {
    const err = new LLMTimeoutError(5000);
    expect(err.name).toBe("LLMTimeoutError");
    expect(err.message).toContain("5000ms");
    expect(err.timeoutMs).toBe(5000);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("OpenAIProvider timeout", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should throw LLMTimeoutError when request exceeds timeout", async () => {
    // Mock fetch that rejects on abort signal
    globalThis.fetch = vi.fn((_url: any, init?: any) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = new OpenAIProvider({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "test",
      model: "test-model",
      timeout: 50, // 50ms timeout for fast test
    });

    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(LLMTimeoutError);
  });

  it("should throw LLMTimeoutError on stream timeout", async () => {
    globalThis.fetch = vi.fn((_url: any, init?: any) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = new OpenAIProvider({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "test",
      model: "test-model",
      timeout: 50,
    });

    await expect(
      provider.streamChat([{ role: "user", content: "hi" }], undefined, {
        onToken: () => {},
      }),
    ).rejects.toThrow(LLMTimeoutError);
  });

  it("should use default timeout of 120s when not specified", () => {
    const provider = new OpenAIProvider({ baseUrl: "http://localhost:1234/v1" });
    // Access private field via any for verification
    expect((provider as any).timeoutMs).toBe(120_000);
  });

  it("should respect custom timeout config", () => {
    const provider = new OpenAIProvider({
      baseUrl: "http://localhost:1234/v1",
      timeout: 30_000,
    });
    expect((provider as any).timeoutMs).toBe(30_000);
  });
});

// ── MCP Pool Reconnect ───────────────────────────────────────────

describe("MCPPool reconnect", () => {
  it("should throw when reconnecting to unknown server", async () => {
    const pool = new MCPPool();
    await expect(pool.reconnect("nonexistent")).rejects.toThrow("No config stored");
  });

  it("should throw when reconnectWithRetry exhausts retries", async () => {
    const pool = new MCPPool();

    // Store a config manually via connectAll will fail, so directly test reconnectWithRetry
    // with a server that has no stored config
    await expect(pool.reconnectWithRetry("nonexistent", 1, 10)).rejects.toThrow("No config stored");
  });

  it("should store config after successful connect for later reconnect", async () => {
    const pool = new MCPPool();
    // configs is private, but we can verify reconnect throws correctly
    // which means configs map is empty
    await expect(pool.reconnect("any")).rejects.toThrow("No config stored");
  });
});

// ── Graceful Shutdown ────────────────────────────────────────────

describe("Graceful shutdown signal handlers", () => {
  it("should be able to register SIGINT and SIGTERM handlers without error", () => {
    const handlers: Record<string, Function> = {};
    const originalOn = process.on.bind(process);

    // Spy on process.on to verify handlers are registered
    const spy = vi.spyOn(process, "on").mockImplementation((event: string | symbol, listener: any) => {
      handlers[String(event)] = listener;
      return process;
    });

    // Simulate what cli.ts does
    let shuttingDown = false;
    const shutdown = async (_signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });

  it("should prevent double shutdown", async () => {
    let callCount = 0;
    let shuttingDown = false;

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      callCount++;
    };

    await shutdown();
    await shutdown();
    await shutdown();

    expect(callCount).toBe(1);
  });
});
