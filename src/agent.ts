import { readFileSync } from "node:fs";
import { MCPPool } from "./pool.js";
import { ToolRouter } from "./router.js";
import { ResourceManager } from "./resources.js";
import { PromptManager } from "./prompts.js";
import { MemoryManager } from "./memory.js";
import { Context } from "./context.js";
import { OpenAIProvider } from "./llm-provider.js";
import type { LLMProvider, StreamCallbacks } from "./llm-provider.js";
import { AgentLoop } from "./loop.js";
import { logger } from "./logger.js";
import { AgentEventEmitter } from "./events.js";
import { validateServerConfig } from "./validation.js";
import type { Middleware } from "./middleware.js";
import type { AgentConfig, AgentResult, ConversationConfig, LLMConfig, MCPServerConfig, Message, RouterConfig } from "./types.js";
import type { ServerHealth } from "./pool.js";

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
  readonly events: AgentEventEmitter;
  private llm: LLMProvider;
  private loop!: AgentLoop;
  private systemPrompt = "You are a helpful assistant with access to MCP tools.";
  private initialized = false;
  private history: Message[] = [];
  private maxHistory: number;
  private maxToolRounds: number;
  private middleware: Middleware[] = [];
  private sessionPath?: string;

  constructor(llmOrConfig?: LLMProvider | LLMConfig, conversationConfig?: ConversationConfig, routerConfig?: RouterConfig) {
    this.pool = new MCPPool();
    this.router = new ToolRouter(routerConfig);
    this.resources = new ResourceManager();
    this.prompts = new PromptManager();
    this.memory = new MemoryManager();
    this.context = new Context();
    this.events = new AgentEventEmitter();
    // Accept either an LLMProvider instance or a legacy LLMConfig
    this.llm = llmOrConfig && "chat" in llmOrConfig
      ? llmOrConfig
      : new OpenAIProvider(llmOrConfig as LLMConfig | undefined);
    this.maxHistory = conversationConfig?.maxHistoryMessages ?? DEFAULT_MAX_HISTORY;
    this.maxToolRounds = conversationConfig?.maxToolRounds ?? 20;
  }

  /** Set the system prompt */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** Enable session persistence: auto-load on enable, auto-save on close */
  enableSession(path: string): void {
    this.sessionPath = path;
    this.history = this.memory.load(path);
  }

  /** Add a middleware to the agent's processing pipeline */
  use(middleware: Middleware): this {
    this.middleware.push(middleware);
    return this;
  }

  /** Load MCP server config from a JSON file */
  async loadConfig(path: string): Promise<void> {
    logger.info(`Loading config from ${path}...`);
    const raw = readFileSync(path, "utf-8");
    const config = JSON.parse(raw) as AgentConfig & { servers?: Record<string, MCPServerConfig> };

    // Support both { servers: {...} } and flat { name: {command, args} } formats
    const servers = config.servers ?? (config as unknown as Record<string, MCPServerConfig>);

    // Filter out non-server keys (like _comment, _updated, etc.) and validate
    const validServers: Record<string, MCPServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (name.startsWith("_")) continue;
      if (typeof cfg === "object" && cfg !== null && ("command" in cfg || "url" in cfg)) {
        validateServerConfig(name, cfg);
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

    // Register virtual tools for resources and prompts
    this.registerVirtualTools();

    this.loop = new AgentLoop(this.llm, this.router, this.middleware, this.maxToolRounds, this.events);
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

  /** Cancel the currently running agent loop */
  cancel(): void {
    this.loop?.cancel();
  }

  /** Health-check all connected MCP servers */
  async healthCheck(): Promise<ServerHealth[]> {
    return this.pool.healthCheck();
  }

  /** Set max history message count */
  setMaxHistory(max: number): void {
    this.maxHistory = max;
  }

  /** Get the last assistant message from a result */
  getLastResponse(result: AgentResult): string {
    for (let i = result.messages.length - 1; i >= 0; i--) {
      const msg = result.messages[i];
      if (msg?.role === "assistant") {
        return msg.content;
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

  /** Truncate history to stay within maxHistory limit, preserving turn integrity */
  private truncateHistory(): void {
    if (this.history.length <= this.maxHistory) return;

    // Group messages into turns: each turn starts with a user message
    // and includes the assistant response + any tool results
    const turns: Array<{ start: number; end: number }> = [];
    let turnStart = -1;

    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg?.role === "user") {
        if (turnStart >= 0) {
          turns.push({ start: turnStart, end: i - 1 });
        }
        turnStart = i;
      }
    }
    if (turnStart >= 0) {
      turns.push({ start: turnStart, end: this.history.length - 1 });
    }

    // Find how many complete turns to drop from the front
    let dropUpTo = 0;
    let remaining = this.history.length;
    for (const turn of turns) {
      const turnSize = turn.end - turn.start + 1;
      if (remaining - turnSize >= this.maxHistory) {
        remaining -= turnSize;
        dropUpTo = turn.end + 1;
      } else {
        break;
      }
    }

    if (dropUpTo > 0) {
      const dropped = dropUpTo;
      this.history = this.history.slice(dropped);
      logger.debug(`Truncated ${dropped} messages from history (now ${this.history.length}), turns preserved`);
      this.events.emit("historyTruncated", { dropped, remaining: this.history.length });
    }
  }

  /** Register virtual tools that expose resources and prompts as callable tools */
  private registerVirtualTools(): void {
    // Only register if there are resources or prompts available
    if (this.resources.size > 0) {
      this.router.registerLocalTool(
        "mcp__read_resource",
        "Read an MCP resource by URI. Use mcp__list_resources first to discover available resources.",
        {
          type: "object",
          properties: {
            uri: { type: "string", description: "The URI of the resource to read" },
          },
          required: ["uri"],
        },
        async (args) => {
          const uri = args.uri as string;
          if (!uri) return { content: "Error: uri is required", isError: true };
          const result = await this.resources.read(uri);
          if (!result) return { content: `Resource not found: ${uri}`, isError: true };
          const text = result.contents
            .map((c) => c.text ?? `[${c.mimeType ?? "binary"} content]`)
            .join("\n");
          return { content: text, isError: false };
        },
      );

      this.router.registerLocalTool(
        "mcp__list_resources",
        "List all available MCP resources. Call this before mcp__read_resource to discover resource URIs.",
        { type: "object", properties: {} },
        async () => {
          const resources = this.resources.list();
          if (resources.length === 0) return { content: "No resources available.", isError: false };
          const lines = resources.map((r) => `- ${r.uri} (${r.name})${r.description ? `: ${r.description}` : ""}`);
          return { content: lines.join("\n"), isError: false };
        },
      );
    }

    if (this.prompts.size > 0) {
      this.router.registerLocalTool(
        "mcp__get_prompt",
        "Get an MCP prompt with its messages. Use mcp__list_prompts first to discover available prompts.",
        {
          type: "object",
          properties: {
            name: { type: "string", description: "The name of the prompt" },
            arguments: { type: "object", description: "Arguments to pass to the prompt", additionalProperties: { type: "string" } },
          },
          required: ["name"],
        },
        async (args) => {
          const name = args.name as string;
          if (!name) return { content: "Error: name is required", isError: true };
          const result = await this.prompts.get(name, args.arguments as Record<string, string> | undefined);
          if (!result) return { content: `Prompt not found: ${name}`, isError: true };
          const messages = result.messages.map((m) => `[${m.role}] ${m.content.type === "text" ? m.content.text : "[non-text content]"}`);
          return { content: messages.join("\n"), isError: false };
        },
      );

      this.router.registerLocalTool(
        "mcp__list_prompts",
        "List all available MCP prompts. Call this before mcp__get_prompt to discover prompt names and arguments.",
        { type: "object", properties: {} },
        async () => {
          const prompts = this.prompts.list();
          if (prompts.length === 0) return { content: "No prompts available.", isError: false };
          const lines = prompts.map((p) => {
            const args = p.arguments?.map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ") ?? "";
            return `- ${p.name}(${args})${p.description ? `: ${p.description}` : ""}`;
          });
          return { content: lines.join("\n"), isError: false };
        },
      );
    }
  }

  /** Shut down all connections (auto-saves session if enabled) */
  async close(): Promise<void> {
    if (this.sessionPath) {
      this.save(this.sessionPath);
    }
    await this.pool.close();
    this.initialized = false;
  }
}
