import { z } from "zod";

/** Zod schema for MCPServerConfig */
export const MCPServerConfigSchema = z.object({
  transport: z.enum(["stdio", "sse", "streamable-http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().url().optional(),
}).refine(
  (data) => {
    // stdio requires command; sse/streamable-http requires url
    if (data.transport === "sse" || data.transport === "streamable-http") {
      return !!data.url;
    }
    // Default transport is stdio, which requires command
    return !!data.command || !!data.url;
  },
  { message: "stdio transport requires 'command'; sse/streamable-http requires 'url'" },
);

/** Zod schema for LLMConfig */
export const LLMConfigSchema = z.object({
  baseUrl: z.string().url("baseUrl must be a valid URL"),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout: z.number().int().positive().optional(),
});

/** Zod schema for RouterConfig */
export const RouterConfigSchema = z.object({
  conflictStrategy: z.enum(["error", "prefix", "first-wins"]).optional(),
  semanticFallback: z.boolean().optional(),
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
});

/** Zod schema for ConversationConfig */
export const ConversationConfigSchema = z.object({
  maxHistoryMessages: z.number().int().positive().optional(),
  maxToolRounds: z.number().int().positive().optional(),
});

/** Zod schema for AgentConfig (top-level config file) */
export const AgentConfigSchema = z.object({
  servers: z.record(MCPServerConfigSchema),
  llm: LLMConfigSchema.optional(),
  router: RouterConfigSchema.optional(),
}).refine(
  (data) => Object.keys(data.servers).length > 0,
  { message: "At least one server must be configured" },
);

export type ValidatedAgentConfig = z.infer<typeof AgentConfigSchema>;
export type ValidatedMCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
export type ValidatedLLMConfig = z.infer<typeof LLMConfigSchema>;

/** Validate a config object and return parsed result or throw with clear message */
export function validateConfig(raw: unknown): ValidatedAgentConfig {
  const result = AgentConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `  - ${path}${i.message}`;
    });
    throw new Error(`Invalid config:\n${issues.join("\n")}`);
  }
  return result.data;
}

/** Validate a single MCPServerConfig */
export function validateServerConfig(name: string, raw: unknown): ValidatedMCPServerConfig {
  const result = MCPServerConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `  - ${path}${i.message}`;
    });
    throw new Error(`Invalid config for server '${name}':\n${issues.join("\n")}`);
  }
  return result.data;
}
