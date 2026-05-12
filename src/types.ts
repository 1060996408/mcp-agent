import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Configuration for a single MCP server */
export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Agent configuration loaded from JSON */
export interface AgentConfig {
  servers: Record<string, MCPServerConfig>;
  llm?: LLMConfig;
  router?: RouterConfig;
}

/** Router conflict resolution and routing strategy */
export interface RouterConfig {
  /** How to handle tool name conflicts across servers (default: "prefix") */
  conflictStrategy?: "error" | "prefix" | "first-wins";
  /** Enable semantic fallback when exact tool name match fails (default: true) */
  semanticFallback?: boolean;
}

/** Conversation history configuration */
export interface ConversationConfig {
  /** Maximum number of messages to keep in history (default: 100) */
  maxHistoryMessages?: number;
}

/** LLM provider configuration */
export interface LLMConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** A connected MCP server instance */
export interface MCPServerInstance {
  name: string;
  client: Client;
  transport: Transport;
  instructions?: string;
}

/** Tool definition aggregated from all servers */
export interface AggregatedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

/** Resource info from MCP server */
export interface ResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Prompt info from MCP server */
export interface PromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** A prompt message returned by getPrompt */
export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "resource"; resource: { uri: string; text: string } | { uri: string; blob: string } };
}

/** A message in the agent conversation */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** A tool call from the LLM */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A tool result to send back to the LLM */
export interface ToolResult {
  tool_call_id: string;
  content: string;
  isError?: boolean;
}

/** Agent execution result */
export interface AgentResult {
  messages: Message[];
  toolCallsExecuted: number;
  tokensUsed?: number;
}
