import { logger } from "./logger.js";
import type { MCPServerInstance, PromptInfo, PromptMessage } from "./types.js";

/**
 * Manages MCP prompts across all connected servers.
 * Provides a unified interface to list and get prompts.
 */
export class PromptManager {
  private prompts = new Map<string, PromptInfo & { serverName: string }>();
  private servers = new Map<string, MCPServerInstance>();

  /** Build prompt index from all connected servers */
  async buildIndex(instances: MCPServerInstance[]): Promise<void> {
    this.prompts.clear();
    this.servers.clear();

    for (const inst of instances) {
      this.servers.set(inst.name, inst);
    }

    const results = await Promise.allSettled(
      instances.map(async (inst) => {
        const { prompts } = await inst.client.listPrompts();
        return { serverName: inst.name, prompts };
      }),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") {
        logger.debug("Failed to list prompts:", r.reason);
        continue;
      }
      const { serverName, prompts } = r.value;
      for (const prompt of prompts) {
        this.prompts.set(prompt.name, {
          name: prompt.name,
          description: prompt.description,
          arguments: prompt.arguments as PromptInfo["arguments"],
          serverName,
        });
      }
      logger.debug(`${serverName}: ${prompts.length} prompts`);
    }

    logger.info(`Prompt index built: ${this.prompts.size} prompts from ${instances.length} servers`);
  }

  /** List all discovered prompts */
  list(): PromptInfo[] {
    return Array.from(this.prompts.values()).map(({ serverName: _, ...info }) => info);
  }

  /** Get a prompt with its messages */
  async get(
    name: string,
    args?: Record<string, string>,
  ): Promise<{ messages: PromptMessage[]; description?: string } | null> {
    const entry = this.prompts.get(name);
    if (!entry) {
      logger.warn(`Prompt not found: ${name}`);
      return null;
    }

    const server = this.servers.get(entry.serverName);
    if (!server) return null;

    try {
      const result = await server.client.getPrompt({ name, arguments: args });
      return {
        messages: result.messages as PromptMessage[],
        description: result.description,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to get prompt ${name}:`, msg);
      return null;
    }
  }

  /** Get number of indexed prompts */
  get size(): number {
    return this.prompts.size;
  }
}
