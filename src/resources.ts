import { logger } from "./logger.js";
import type { MCPServerInstance, ResourceInfo } from "./types.js";

/**
 * Manages MCP resources across all connected servers.
 * Provides a unified interface to list, read, and subscribe to resources.
 */
export class ResourceManager {
  private resources = new Map<string, ResourceInfo & { serverName: string }>();
  private servers = new Map<string, MCPServerInstance>();

  /** Build resource index from all connected servers */
  async buildIndex(instances: MCPServerInstance[]): Promise<void> {
    this.resources.clear();
    this.servers.clear();

    for (const inst of instances) {
      this.servers.set(inst.name, inst);
    }

    const results = await Promise.allSettled(
      instances.map(async (inst) => {
        const { resources } = await inst.client.listResources();
        return { serverName: inst.name, resources };
      }),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") {
        logger.debug("Failed to list resources:", r.reason);
        continue;
      }
      const { serverName, resources } = r.value;
      for (const res of resources) {
        this.resources.set(res.uri, {
          uri: res.uri,
          name: res.name,
          description: res.description,
          mimeType: res.mimeType,
          serverName,
        });
      }
      logger.debug(`${serverName}: ${resources.length} resources`);
    }

    logger.info(`Resource index built: ${this.resources.size} resources from ${instances.length} servers`);
  }

  /** List all discovered resources */
  list(): ResourceInfo[] {
    return Array.from(this.resources.values()).map(({ serverName: _, ...info }) => info);
  }

  /** Read a resource by URI */
  async read(uri: string): Promise<{ contents: Array<{ text?: string; blob?: string; mimeType?: string }> } | null> {
    const entry = this.resources.get(uri);
    if (!entry) {
      logger.warn(`Resource not found: ${uri}`);
      return null;
    }

    const server = this.servers.get(entry.serverName);
    if (!server) return null;

    try {
      const result = await server.client.readResource({ uri });
      return { contents: result.contents as Array<{ text?: string; blob?: string; mimeType?: string }> };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to read resource ${uri}:`, msg);
      return null;
    }
  }

  /** Get number of indexed resources */
  get size(): number {
    return this.resources.size;
  }
}
