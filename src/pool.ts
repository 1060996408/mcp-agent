import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "./logger.js";
import type { MCPServerConfig, MCPServerInstance } from "./types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Health status for a single server */
export interface ServerHealth {
  name: string;
  connected: boolean;
  healthy: boolean;
  toolCount?: number;
  error?: string;
  latencyMs?: number;
}

function createTransport(config: MCPServerConfig): Transport {
  const transportType = config.transport ?? (config.command ? "stdio" : undefined);

  switch (transportType) {
    case "stdio": {
      if (!config.command) throw new Error("stdio transport requires 'command'");
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
        cwd: config.cwd,
      });
    }
    case "sse": {
      if (!config.url) throw new Error("sse transport requires 'url'");
      return new SSEClientTransport(new URL(config.url));
    }
    case "streamable-http": {
      if (!config.url) throw new Error("streamable-http transport requires 'url'");
      return new StreamableHTTPClientTransport(new URL(config.url));
    }
    default:
      throw new Error(`Unknown transport type: "${transportType}". Use "stdio", "sse", or "streamable-http".`);
  }
}

/**
 * Manages connections to multiple MCP servers.
 * Each server gets its own Client + Transport pair.
 */
export class MCPPool {
  private instances = new Map<string, MCPServerInstance>();
  private configs = new Map<string, MCPServerConfig>();

  /** Connect to a single MCP server */
  async connect(name: string, config: MCPServerConfig): Promise<MCPServerInstance> {
    if (this.instances.has(name)) {
      logger.warn(`Server '${name}' already connected, skipping`);
      return this.instances.get(name)!;
    }

    this.configs.set(name, config);
    logger.info(`Connecting to MCP server '${name}'...`);

    const transport = createTransport(config);

    const client = new Client(
      { name: "mcp-agent", version: "0.1.0" },
      { capabilities: {} },
    );

    await client.connect(transport);

    const instructions = client.getInstructions?.() ?? undefined;

    const instance: MCPServerInstance = { name, client, transport, instructions };
    this.instances.set(name, instance);

    logger.info(`Connected to '${name}'`);
    return instance;
  }

  /** Connect to multiple servers from config */
  async connectAll(servers: Record<string, MCPServerConfig>): Promise<void> {
    const entries = Object.entries(servers);
    logger.info(`Connecting to ${entries.length} MCP server(s)...`);

    // Connect in parallel
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connect(name, config)),
    );

    let ok = 0;
    let fail = 0;
    for (const r of results) {
      if (r.status === "fulfilled") ok++;
      else {
        fail++;
        logger.error("Connection failed:", r.reason);
      }
    }
    logger.info(`Connected: ${ok}/${entries.length} servers${fail > 0 ? ` (${fail} failed)` : ""}`);
  }

  /** Get a connected server by name */
  get(name: string): MCPServerInstance | undefined {
    return this.instances.get(name);
  }

  /** Get all connected servers */
  getAll(): MCPServerInstance[] {
    return Array.from(this.instances.values());
  }

  /** List connected server names */
  names(): string[] {
    return Array.from(this.instances.keys());
  }

  /** Check if a server is connected */
  has(name: string): boolean {
    return this.instances.has(name);
  }

  /** Reconnect to a server (close existing, then connect fresh) */
  async reconnect(name: string): Promise<MCPServerInstance> {
    const config = this.configs.get(name);
    if (!config) throw new Error(`No config stored for server '${name}', cannot reconnect`);

    // Close existing connection if any
    const existing = this.instances.get(name);
    if (existing) {
      try {
        await existing.client.close();
      } catch { /* ignore close errors */ }
      this.instances.delete(name);
    }

    logger.info(`Reconnecting to '${name}'...`);
    return this.connect(name, config);
  }

  /** Reconnect to a server with retry (exponential backoff) */
  async reconnectWithRetry(name: string, maxRetries = 3, baseDelayMs = 1000): Promise<MCPServerInstance> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.reconnect(name);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < maxRetries) {
          const delay = baseDelayMs * 2 ** attempt;
          logger.warn(`Reconnect attempt ${attempt + 1} failed for '${name}', retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError!;
  }

  /** Health-check all connected servers (tries listing tools) */
  async healthCheck(): Promise<ServerHealth[]> {
    const results = await Promise.allSettled(
      Array.from(this.instances.entries()).map(async ([name, inst]): Promise<ServerHealth> => {
        const start = Date.now();
        try {
          const { tools } = await inst.client.listTools();
          return { name, connected: true, healthy: true, toolCount: tools.length, latencyMs: Date.now() - start };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { name, connected: true, healthy: false, error: msg, latencyMs: Date.now() - start };
        }
      }),
    );

    return results.map((r) => {
      if (r.status === "fulfilled") return r.value;
      return { name: "unknown", connected: false, healthy: false, error: String(r.reason) };
    });
  }

  /** Get status summary of all servers */
  getServerStatus(): Array<{ name: string; connected: boolean; transport: string }> {
    return Array.from(this.instances.entries()).map(([name, inst]) => ({
      name,
      connected: true,
      transport: this.configs.get(name)?.transport ?? (this.configs.get(name)?.command ? "stdio" : "unknown"),
    }));
  }

  /** Disconnect all servers */
  async close(): Promise<void> {
    logger.info("Closing all MCP connections...");
    const closings = Array.from(this.instances.values()).map(async (inst) => {
      try {
        await inst.client.close();
      } catch (e) {
        logger.warn(`Error closing '${inst.name}':`, e);
      }
    });
    await Promise.all(closings);
    this.instances.clear();
    logger.info("All connections closed");
  }
}
