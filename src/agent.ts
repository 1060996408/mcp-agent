import { readFileSync } from "node:fs";
import { MCPPool } from "./pool.js";
import { ToolRouter } from "./router.js";
import { ResourceManager } from "./resources.js";
import { PromptManager } from "./prompts.js";
import { MemoryManager } from "./memory.js";
import { Context } from "./context.js";
import { LLMClient } from "./llm.js";
import type { StreamCallbacks } from "./llm.js";
import { AgentLoop } from "./loop.js";
import { logger } from "./logger.js";
import type { AgentConfig, AgentResult, ConversationConfig, LLMConfig, MCPServerConfig, Message, RouterConfig } from "./types.js";

const DEFAULT_MAX_HISTORY = 100;

/**
 * MCP Agent — main entry point.
 *
 * Supports multi-turn conversation with persistent memory:
 *   const agent = new Agent();
 *   await agent.connectServers(servers);
 *   agent.load("~/.agent/session.json");  // restore previous session
 *   await agent.run("continue where we left off");
 *   agent.save("~/.agent/session.json");  // persist for next session
 *   agent.memory.addMemory("User prefers TypeScript", ["preference"]);
 */
export class Agent {
  readonly pool: MCPPool;
  readonly router: ToolRouter;
  readonly resources: ResourceManager;
  readonly prompts: PromptManager;
  readonly memory: MemoryManager;
  readonly context: Context;
  private llm: LLMClient;
  private loop!: AgentLoop;
  private systemPrompt = "You are a helpful assistant with access to MCP tools.";
  private initialized = false;
  private history: Message[] = [];
  private maxHistory: number;

  constructor(llmConfig?: LLMConfig, conversationConfig?: ConversationConfig, routerConfig?: RouterConfig) {
    this.pool = new MCPPool();
    this.router = new ToolRouter(routerConfig);
    this.resources = new ResourceManager();
    this.prompts = new PromptManager();
    this.memory = new MemoryManager();
    this.context = new Context();
    this.llm = new LLMClient(llmConfig);
    this.maxHistory = conversationConfig?.maxHistoryMessages ?? DEFAULT_MAX_HISTORY;
  }

  /** Set the system prompt */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** Load MCP server config from a JSON file */
  async loadConfig(path: string): Promise<void> {
    logger.info(`Loading config from ${path}...`);
    const raw = readFileSync(path, "utf-8");
    const config = JSON.parse(raw) as AgentConfig & { servers?: Record<string, MCPServerConfig> };

    // Support both { servers: {...} } and flat { name: {command, args} } formats
    const servers = config.servers ?? (config as unknown as Record<string, MCPServerConfig>);

    // Filter out non-server keys (like _comment, _updated, etc.)
    const validServers: Record<string, MCPServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (name.startsWith("_")) continue;
      if (typeof cfg === "object" && cfg !== null && "command" in cfg) {
        validServers[name] = cfg as MCPServerConfig;
      }
    }

    await this.connectServers(validServers);
  }

  /** Connect to MCP servers from a config object */
  async connectServers(servers: Record<string, MCPServerConfig>): Promise<void> {
    await this.pool.connectAll(servers);
    const instances = this.pool.getAll();

    // Build indexes in parallel (tools, resources, prompts)
    await Promise.all([
      this.router.buildIndex(instances),
      this.resources.buildIndex(instances),
      this.prompts.buildIndex(instances),
    ]);

    // Aggregate context
    this.context.aggregate(instances);
    this.context.setPrompts(this.prompts.list());
    this.context.setResources(this.resources.list());

    this.loop = new AgentLoop(this.llm, this.router);
    this.initialized = true;
  }

  /** Save conversation state (history + memories) to a file */
  save(path: string): void {
    this.memory.save(path, this.history);
  }

  /** Load conversation state (history + memories) from a file */
  load(path: string): void {
    this.history = this.memory.load(path);
  }

  /** Run the agent with a user message (multi-turn: appends to history) */
  async run(userMessage: string): Promise<AgentResult> {
    if (!this.initialized) {
      throw new Error("Agent not initialized. Call loadConfig() or connectServers() first.");
    }

    const systemPrompt = this.buildFullSystemPrompt();

    // Build message list: system + history + new user message
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...this.history,
      { role: "user", content: userMessage },
    ];

    logger.info(`Running agent: "${userMessage.slice(0, 80)}${userMessage.length > 80 ? "..." : ""}"`);

    const result = await this.loop.run(messages);

    // Extract new messages (everything after the system + history + user we sent)
    const newMessages = result.messages.slice(messages.length);
    this.history.push({ role: "user", content: userMessage });
    this.history.push(...newMessages);

    // Truncate history if needed
    this.truncateHistory();

    logger.info(`Done: ${result.toolCallsExecuted} tool(s) called${result.tokensUsed ? `, ${result.tokensUsed} tokens` : ""}`);

    return result;
  }

  /** Run the agent with streaming output (multi-turn: appends to history) */
  async runStream(
    userMessage: string,
    callbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    if (!this.initialized) {
      throw new Error("Agent not initialized. Call loadConfig() or connectServers() first.");
    }

    const systemPrompt = this.buildFullSystemPrompt();

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...this.history,
      { role: "user", content: userMessage },
    ];

    logger.info(`Running agent (stream): "${userMessage.slice(0, 80)}${userMessage.length > 80 ? "..." : ""}"`);

    const result = await this.loop.runStream(messages, callbacks);

    // Accumulate history
    const newMessages = result.messages.slice(messages.length);
    this.history.push({ role: "user", content: userMessage });
    this.history.push(...newMessages);
    this.truncateHistory();

    logger.info(`Done: ${result.toolCallsExecuted} tool(s) called`);

    return result;
  }

  /** Run with pre-built messages (no history management) */
  async runMessages(messages: Message[]): Promise<AgentResult> {
    if (!this.initialized) {
      throw new Error("Agent not initialized. Call loadConfig() or connectServers() first.");
    }
    return this.loop.run(messages);
  }

  /** Get conversation history */
  getHistory(): readonly Message[] {
    return this.history;
  }

  /** Clear conversation history (keeps memories) */
  reset(): void {
    this.history = [];
  }

  /** Get the last assistant message from a result */
  getLastResponse(result: AgentResult): string {
    for (let i = result.messages.length - 1; i >= 0; i--) {
      if (result.messages[i].role === "assistant") {
        return result.messages[i].content;
      }
    }
    return "";
  }

  /** Build system prompt with context + memories */
  private buildFullSystemPrompt(): string {
    const base = this.context.buildSystemPrompt(this.systemPrompt);
    const memories = this.memory.formatMemories();
    if (!memories) return base;
    return `${base}\n\n${memories}`;
  }

  /** Truncate history to stay within maxHistory limit */
  private truncateHistory(): void {
    if (this.history.length <= this.maxHistory) return;

    // Keep the most recent messages
    const dropped = this.history.length - this.maxHistory;
    this.history = this.history.slice(dropped);
    logger.debug(`Truncated ${dropped} old messages from history (now ${this.history.length})`);
  }

  /** Shut down all connections */
  async close(): Promise<void> {
    await this.pool.close();
    this.initialized = false;
  }
}
