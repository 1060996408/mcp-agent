import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import type { AgentResult, Message, ToolCall } from "./types.js";
import type { LLMClient, StreamCallbacks } from "./llm.js";
import type { ToolRouter } from "./router.js";

/** Maximum number of tool call rounds before forcing a final response */
const MAX_TOOL_ROUNDS = 20;

/**
 * The core agent loop: LLM → tool calls → results → LLM → ...
 * Continues until the LLM produces a response with no tool calls.
 */
export class AgentLoop {
  private llm: LLMClient;
  private router: ToolRouter;

  constructor(llm: LLMClient, router: ToolRouter) {
    this.llm = llm;
    this.router = router;
  }

  /** Run the agent loop (non-streaming) */
  async run(messages: Message[]): Promise<AgentResult> {
    const allMessages = [...messages];
    const tools = this.router.getOpenAITools();
    let toolCallsExecuted = 0;
    let rounds = 0;
    let totalTokens = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      logger.info(`Agent round ${rounds}...`);

      const response = await this.llm.chat(allMessages, tools);

      if (response.usage) {
        totalTokens += response.usage.prompt + response.usage.completion;
      }

      // If no tool calls, we're done
      if (response.toolCalls.length === 0) {
        allMessages.push({
          role: "assistant",
          content: response.content,
        });
        break;
      }

      // Record assistant message with tool calls
      allMessages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.toolCalls,
      });

      // Execute all tool calls
      const results = await this.executeToolCalls(response.toolCalls);
      toolCallsExecuted += results.length;

      // Add tool results to messages
      for (const result of results) {
        allMessages.push({
          role: "tool",
          content: result.content,
          tool_call_id: result.tool_call_id,
        });
      }
    }

    if (rounds >= MAX_TOOL_ROUNDS) {
      logger.warn(`Reached maximum tool rounds (${MAX_TOOL_ROUNDS})`);
    }

    return {
      messages: allMessages,
      toolCallsExecuted,
      tokensUsed: totalTokens > 0 ? totalTokens : undefined,
    };
  }

  /** Run the agent loop with streaming output */
  async runStream(
    messages: Message[],
    callbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    const allMessages = [...messages];
    const tools = this.router.getOpenAITools();
    let toolCallsExecuted = 0;
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      logger.info(`Agent round ${rounds}...`);

      const response = await this.llm.streamChat(allMessages, tools, {
        onToken: callbacks?.onToken,
        onToolCall: callbacks?.onToolCall,
      });

      // If no tool calls, we're done
      if (response.toolCalls.length === 0) {
        allMessages.push({
          role: "assistant",
          content: response.content,
        });
        break;
      }

      // Record assistant message with tool calls
      allMessages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.toolCalls,
      });

      // Execute all tool calls
      const results = await this.executeToolCalls(response.toolCalls);
      toolCallsExecuted += results.length;

      // Add tool results to messages
      for (const result of results) {
        allMessages.push({
          role: "tool",
          content: result.content,
          tool_call_id: result.tool_call_id,
        });
      }
    }

    if (rounds >= MAX_TOOL_ROUNDS) {
      logger.warn(`Reached maximum tool rounds (${MAX_TOOL_ROUNDS})`);
    }

    return {
      messages: allMessages,
      toolCallsExecuted,
    };
  }

  /** Execute multiple tool calls in parallel */
  private async executeToolCalls(
    toolCalls: ToolCall[],
  ): Promise<Array<{ tool_call_id: string; content: string }>> {
    const results = await Promise.allSettled(
      toolCalls.map(async (tc) => {
        const result = await this.router.callTool(tc.name, tc.arguments);
        return { tool_call_id: tc.id, content: result.content };
      }),
    );

    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      logger.error(`Tool call ${toolCalls[i].name} failed:`, err);
      return { tool_call_id: toolCalls[i].id, content: `Error: ${err}` };
    });
  }
}

/** Generate a unique tool call ID */
export function newToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
