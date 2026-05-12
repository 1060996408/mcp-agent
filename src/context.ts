import type { MCPServerInstance, PromptInfo, ResourceInfo } from "./types.js";

/**
 * Aggregates context from all connected MCP servers:
 * - Server instructions → system prompt additions
 * - Prompts → available prompt templates
 * - Resources → available data sources
 */
export class Context {
  private serverInstructions: string[] = [];
  private prompts: PromptInfo[] = [];
  private resources: ResourceInfo[] = [];

  /** Collect instructions from all servers */
  aggregate(instances: MCPServerInstance[]): void {
    this.serverInstructions = [];
    for (const inst of instances) {
      if (inst.instructions) {
        this.serverInstructions.push(`[${inst.name}] ${inst.instructions}`);
      }
    }
  }

  /** Set discovered prompts (from PromptManager) */
  setPrompts(prompts: PromptInfo[]): void {
    this.prompts = prompts;
  }

  /** Set discovered resources (from ResourceManager) */
  setResources(resources: ResourceInfo[]): void {
    this.resources = resources;
  }

  /** Build system prompt with server context */
  buildSystemPrompt(basePrompt?: string): string {
    const parts: string[] = [];

    if (basePrompt) {
      parts.push(basePrompt);
    }

    if (this.serverInstructions.length > 0) {
      parts.push("## Available MCP Server Instructions");
      parts.push(this.serverInstructions.join("\n\n"));
    }

    if (this.prompts.length > 0) {
      parts.push("## Available Prompt Templates");
      parts.push("Use these templates to generate structured prompts:");
      for (const p of this.prompts) {
        const args = p.arguments?.map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ") ?? "";
        parts.push(`- **${p.name}**${p.description ? `: ${p.description}` : ""}${args ? ` (${args})` : ""}`);
      }
    }

    if (this.resources.length > 0) {
      parts.push("## Available Resources");
      parts.push("These data sources can be read via the resource system:");
      for (const r of this.resources) {
        parts.push(`- **${r.name}** [${r.uri}]${r.description ? `: ${r.description}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}`);
      }
    }

    parts.push("## Tool Usage Guidelines");
    parts.push("- Call tools when you need to perform actions or retrieve information.");
    parts.push("- Use the most specific tool available for the task.");
    parts.push("- If a tool call fails, explain the error and try an alternative approach.");

    return parts.join("\n\n");
  }
}
