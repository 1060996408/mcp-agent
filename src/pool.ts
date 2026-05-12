import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "./logger.js";
import type { MCPServerConfig, MCPServerInstance } from "./types.js";

/**
 * Manages connections to multiple MCP servers.
 * Each server gets its own Client + Transport pair.
 */
export class MCPPool {
  private instances = new Map<string, MCPServerInstance>();

  /** Connect to a single MCP server */
  async connect(name: string, config: MCPServerConfig): Promise<MCPServerInstance> {
    if (this.instances.has(name)) {
      logger.warn(`Server '${name}' already connected, skipping`);
      return this.instances.get(name)!;
    }

    logger.info(`Connecting to MCP server '${name}'...`);

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      cwd: config.cwd,
    });

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
