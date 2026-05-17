import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import type { AgentResult, Message, ToolCall } from "./types.js";
import type { LLMProvider, StreamCallbacks } from "./llm-provider.js";
import type { ToolRouter } from "./router.js";
import type { Middleware, MiddlewareContext } from "./middleware.js";
import { runHooks } from "./middleware.js";
import { AgentEventEmitter } from "./events.js";

/** Default maximum tool call rounds */
const DEFAULT_MAX_TOOL_ROUNDS = 20;

/**
 * The core agent loop: LLM → tool calls → results → LLM → ...
 * Continues until the LLM produces a response with no tool calls.
 */
export class AgentLoop {
  private llm: LLMProvider;
  private router: ToolRouter;
  private middleware: Middleware[];
  private maxToolRounds: number;
  private aborted = false;
  readonly events: AgentEventEmitter;

  constructor(llm: LLMProvider, router: ToolRouter, middleware: Middleware[] = [], maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS, events?: AgentEventEmitter) {
    this.llm = llm;
    this.router = router;
    this.middleware = middleware;
    this.maxToolRounds = maxToolRounds;
    this.events = events ?? new AgentEventEmitter();
  }

  /** Cancel the currently running agent loop */
  cancel(): void {
    this.aborted = true;
  }

  /** Reset the aborted flag (for reuse) */
  resetCancel(): void {
    this.aborted = false;
  }

  /** Run the agent loop (non-streaming) */
  async run(messages: Message[]): Promise<AgentResult> {
    const allMessages = [...messages];
    const tools = this.router.getOpenAITools();
    let toolCallsExecuted = 0;
    let rounds = 0;
    let totalTokens = 0;

    this.events.emit("runStart", { userMessage: messages[messages.length - 1]?.content ?? "", messageCount: messages.length });

    while (rounds < this.maxToolRounds) {
      if (this.aborted) {
        logger.info("Agent loop cancelled");
        break;
      }

      rounds++;
      logger.info(`Agent round ${rounds}...`);

      this.events.emit("beforeLLM", { round: rounds, messageCount: allMessages.length });

      // LLM call with middleware hooks (supports retry via _shouldRetry flag)
      let response: { content: string; toolCalls: ToolCall[]; usage?: { prompt: number; completion: number } } | undefined;
      const llmMetadata: Record<string, unknown> = {};
      while (true) {
        const llmCtx: MiddlewareContext = { type: "llm", messages: allMessages, metadata: llmMetadata };
        try {
          await runHooks(this.middleware, "beforeLLM", llmCtx, async () => {
            response = await this.llm.chat(allMessages, tools);
          });
          if (llmCtx.error) throw llmCtx.error;
          if (!response) throw new Error("LLM call skipped by middleware");
          llmCtx.result = { content: response.content, toolCalls: response.toolCalls };
          await runHooks(this.middleware, "afterLLM", llmCtx, async () => {});
          break;
        } catch (e) {
          llmCtx.error = e instanceof Error ? e : new Error(String(e));
          this.events.emit("error", { phase: "llm", error: llmCtx.error });
          await runHooks(this.middleware, "onError", llmCtx, async () => {});
          if (llmCtx.metadata._shouldRetry) {
            llmCtx.metadata._shouldRetry = false;
            continue; // retry
          }
          throw e;
        }
      }

      this.events.emit("afterLLM", {
        round: rounds,
        content: response.content,
        toolCallCount: response.toolCalls.length,
        tokensUsed: response.usage ? response.usage.prompt + response.usage.completion : undefined,
      });

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

      // Execute all tool calls (with per-call middleware hooks)
      const results = await this.executeToolCalls(response.toolCalls, rounds);
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

    if (rounds >= this.maxToolRounds) {
      logger.warn(`Reached maximum tool rounds (${this.maxToolRounds})`);
    }

    this.events.emit("runEnd", {
      toolCallsExecuted,
      tokensUsed: totalTokens > 0 ? totalTokens : undefined,
      rounds,
    });

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

    this.events.emit("runStart", { userMessage: messages[messages.length - 1]?.content ?? "", messageCount: messages.length });

    while (rounds < this.maxToolRounds) {
      if (this.aborted) {
        logger.info("Agent loop cancelled");
        break;
      }

      rounds++;
      logger.info(`Agent round ${rounds}...`);

      this.events.emit("beforeLLM", { round: rounds, messageCount: allMessages.length });

      // LLM streaming call with middleware hooks
      let response: { content: string; toolCalls: ToolCall[] } | undefined;
      const llmMetadata: Record<string, unknown> = {};
      while (true) {
        const llmCtx: MiddlewareContext = { type: "llm", messages: allMessages, metadata: llmMetadata };
        try {
          await runHooks(this.middleware, "beforeLLM", llmCtx, async () => {
            response = await this.llm.streamChat(allMessages, tools, {
              onToken: callbacks?.onToken,
              onToolCall: callbacks?.onToolCall,
              onToolCallStart: callbacks?.onToolCallStart,
            });
          });
          if (llmCtx.error) throw llmCtx.error;
          if (!response) throw new Error("LLM call skipped by middleware");
          llmCtx.result = { content: response.content, toolCalls: response.toolCalls };
          await runHooks(this.middleware, "afterLLM", llmCtx, async () => {});
          break;
        } catch (e) {
          llmCtx.error = e instanceof Error ? e : new Error(String(e));
          this.events.emit("error", { phase: "llm", error: llmCtx.error });
          await runHooks(this.middleware, "onError", llmCtx, async () => {});
          if (llmCtx.metadata._shouldRetry) {
            llmCtx.metadata._shouldRetry = false;
            continue;
          }
          throw e;
        }
      }

      this.events.emit("afterLLM", {
        round: rounds,
        content: response.content,
        toolCallCount: response.toolCalls.length,
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

      // Execute all tool calls (with per-call middleware hooks)
      const results = await this.executeToolCalls(response.toolCalls, rounds);
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

    if (rounds >= this.maxToolRounds) {
      logger.warn(`Reached maximum tool rounds (${this.maxToolRounds})`);
    }

    this.events.emit("runEnd", {
      toolCallsExecuted,
      rounds,
    });

    return {
      messages: allMessages,
      toolCallsExecuted,
    };
  }

  /** Execute multiple tool calls in parallel */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    round: number,
  ): Promise<Array<{ tool_call_id: string; content: string }>> {
    const results = await Promise.allSettled(
      toolCalls.map(async (tc) => {
        this.events.emit("beforeToolCall", { round, toolCall: tc });
        const toolCtx: MiddlewareContext = { type: "tool", toolCall: tc, metadata: {} };
        const start = Date.now();
        try {
          await runHooks(this.middleware, "beforeToolCall", toolCtx, async () => {
            const result = await this.router.callTool(tc.name, tc.arguments);
            toolCtx.result = { content: result.content, isError: result.isError };
          });
          if (toolCtx.error) throw toolCtx.error;
          if (!toolCtx.result) throw new Error(`Tool call "${tc.name}" skipped by middleware`);
          await runHooks(this.middleware, "afterToolCall", toolCtx, async () => {});
          this.events.emit("afterToolCall", {
            round,
            toolCall: tc,
            content: toolCtx.result.content,
            isError: toolCtx.result.isError ?? false,
            elapsedMs: Date.now() - start,
          });
          return { tool_call_id: tc.id, content: toolCtx.result.content };
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          toolCtx.error = err;
          this.events.emit("error", { phase: "tool", error: err, toolCall: tc });
          this.events.emit("afterToolCall", {
            round,
            toolCall: tc,
            content: err.message,
            isError: true,
            elapsedMs: Date.now() - start,
          });
          await runHooks(this.middleware, "onError", toolCtx, async () => {});
          throw e;
        }
      }),
    );

    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const tc = toolCalls[i]!;
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      logger.error(`Tool call ${tc.name} failed:`, err);
      return { tool_call_id: tc.id, content: `Error: ${err}` };
    });
  }
}

/** Generate a unique tool call ID */
export function newToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
