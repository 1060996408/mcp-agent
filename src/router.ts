import { logger } from "./logger.js";
import type { AggregatedTool, MCPServerInstance, RouterConfig } from "./types.js";

/**
 * Routes tool calls to the correct MCP server.
 * Builds a unified tool index from all connected servers.
 */
export class ToolRouter {
  private tools = new Map<string, AggregatedTool>();
  private servers = new Map<string, MCPServerInstance>();
  private config: Required<RouterConfig>;

  constructor(config?: RouterConfig) {
    this.config = {
      conflictStrategy: config?.conflictStrategy ?? "prefix",
      semanticFallback: config?.semanticFallback ?? true,
    };
  }

  /** Build tool index from all connected servers */
  async buildIndex(instances: MCPServerInstance[]): Promise<void> {
    this.tools.clear();
    this.servers.clear();

    for (const inst of instances) {
      this.servers.set(inst.name, inst);
    }

    // Fetch tools from all servers in parallel
    const results = await Promise.allSettled(
      instances.map(async (inst) => {
        const { tools } = await inst.client.listTools();
        return { serverName: inst.name, tools };
      }),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") {
        logger.error("Failed to list tools:", r.reason);
        continue;
      }
      const { serverName, tools } = r.value;
      for (const tool of tools) {
        const entry: AggregatedTool = {
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          serverName,
        };

        const existing = this.tools.get(tool.name);
        if (existing) {
          this.handleConflict(entry, existing);
        } else {
          this.tools.set(tool.name, entry);
        }
      }
      logger.debug(`${serverName}: ${tools.length} tools`);
    }

    logger.info(`Tool index built: ${this.tools.size} tools from ${instances.length} servers`);
  }

  /** Handle a tool name conflict based on configured strategy */
  private handleConflict(newTool: AggregatedTool, existing: AggregatedTool): void {
    switch (this.config.conflictStrategy) {
      case "first-wins":
        logger.warn(`Tool conflict: "${newTool.name}" from ${newTool.serverName} ignored (first-wins, kept ${existing.serverName})`);
        break;
      case "error":
        throw new Error(`Tool name conflict: "${newTool.name}" exists in both ${existing.serverName} and ${newTool.serverName}`);
      case "prefix": {
        // Prefix the new tool with its server name
        const prefixed = `${newTool.serverName}__${newTool.name}`;
        logger.warn(`Tool conflict: "${newTool.name}" from ${newTool.serverName} renamed to "${prefixed}"`);
        this.tools.set(prefixed, { ...newTool, name: prefixed });
        break;
      }
    }
  }

  /** Get all aggregated tools (for LLM tool definitions) */
  getAll(): AggregatedTool[] {
    return Array.from(this.tools.values());
  }

  /** Get tools formatted as OpenAI-compatible tool definitions */
  getOpenAITools(): Array<{
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }> {
    return this.getAll().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  /** Look up which server owns a tool */
  resolve(toolName: string): { server: MCPServerInstance; tool: AggregatedTool } | undefined {
    const tool = this.tools.get(toolName);
    if (tool) {
      const server = this.servers.get(tool.serverName);
      if (server) return { server, tool };
    }

    // Semantic fallback: search by description keyword overlap
    if (this.config.semanticFallback) {
      const best = this.semanticSearch(toolName);
      if (best) {
        logger.debug(`Semantic fallback: "${toolName}" → "${best.name}" (${best.serverName})`);
        const server = this.servers.get(best.serverName);
        if (server) return { server, tool: best };
      }
    }

    return undefined;
  }

  /** Find the best matching tool by description keyword overlap */
  private semanticSearch(query: string): AggregatedTool | undefined {
    const queryWords = tokenize(query);
    if (queryWords.length === 0) return undefined;

    let bestScore = 0;
    let bestTool: AggregatedTool | undefined;

    for (const tool of this.tools.values()) {
      const desc = `${tool.name} ${tool.description ?? ""}`;
      const toolWords = tokenize(desc);
      const score = overlapScore(queryWords, toolWords);
      if (score > bestScore) {
        bestScore = score;
        bestTool = tool;
      }
    }

    // Require at least 1 matching word
    return bestScore > 0 ? bestTool : undefined;
  }

  /** Execute a tool call on the correct server */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    const resolved = this.resolve(toolName);
    if (!resolved) {
      return { content: `Unknown tool: ${toolName}`, isError: true };
    }

    logger.debug(`Calling ${toolName} on ${resolved.server.name}`, args);

    try {
      const result = await resolved.server.client.callTool({
        name: toolName,
        arguments: args,
      });

      // Extract text content from result
      const content = Array.isArray(result.content)
        ? result.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { type: string; text: string }) => c.text)
            .join("\n")
        : String(result.content);

      return { content, isError: result.isError === true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Tool call failed: ${toolName}`, msg);
      return { content: `Tool error: ${msg}`, isError: true };
    }
  }

  /** Get number of indexed tools */
  get size(): number {
    return this.tools.size;
  }
}

/** Tokenize a string into lowercase words */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Count how many query words appear in the target set */
function overlapScore(queryWords: string[], targetWords: string[]): number {
  const set = new Set(targetWords);
  let score = 0;
  for (const w of queryWords) {
    if (set.has(w)) score++;
  }
  return score;
}
