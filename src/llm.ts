import { logger } from "./logger.js";
import type { LLMConfig, Message, ToolCall } from "./types.js";

export interface StreamCallbacks {
  /** Called for each text token */
  onToken?: (token: string) => void;
  /** Called when a tool call is detected */
  onToolCall?: (toolCall: ToolCall) => void;
}

/**
 * OpenAI-compatible LLM client.
 * Works with any API that follows the OpenAI chat completions format.
 */
export class LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config?: LLMConfig) {
    this.baseUrl = (config?.baseUrl ?? "http://127.0.0.1:15721/v1").replace(/\/$/, "");
    this.apiKey = config?.apiKey ?? "PROXY_MANAGED";
    this.model = config?.model ?? "gpt-5.4";
    this.maxTokens = config?.maxTokens ?? 4096;
    this.temperature = config?.temperature ?? 0;
  }

  /** Build the request body (shared between chat and streamChat) */
  private buildBody(
    messages: Message[],
    tools?: Array<{
      type: "function";
      function: { name: string; description?: string; parameters: Record<string, unknown> };
    }>,
    stream = false,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => {
        const base: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) {
          base.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));
        }
        if (m.tool_call_id) {
          base.tool_call_id = m.tool_call_id;
        }
        return base;
      }),
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    return body;
  }

  /** Send a chat completion request (non-streaming) */
  async chat(
    messages: Message[],
    tools?: Array<{
      type: "function";
      function: { name: string; description?: string; parameters: Record<string, unknown> };
    }>,
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage?: { prompt: number; completion: number } }> {
    const body = this.buildBody(messages, tools, false);

    logger.debug("LLM request:", { model: this.model, messageCount: messages.length, toolCount: tools?.length ?? 0 });

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error("LLM returned no choices");

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: this.parseJSON(tc.function.arguments),
    }));

    const usage = data.usage
      ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
      : undefined;

    logger.debug("LLM response:", {
      contentLen: (choice.message.content ?? "").length,
      toolCalls: toolCalls.length,
      usage,
    });

    return {
      content: choice.message.content ?? "",
      toolCalls,
      usage,
    };
  }

  /** Send a streaming chat completion request */
  async streamChat(
    messages: Message[],
    tools?: Array<{
      type: "function";
      function: { name: string; description?: string; parameters: Record<string, unknown> };
    }>,
    callbacks?: StreamCallbacks,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const body = this.buildBody(messages, tools, true);

    logger.debug("LLM stream request:", { model: this.model, messageCount: messages.length, toolCount: tools?.length ?? 0 });

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("LLM streaming response has no body");
    }

    // Parse SSE stream
    let fullContent = "";
    // Tool calls can arrive incrementally — accumulate by index
    const toolCallAccumulators: Array<{ id: string; name: string; arguments: string }> = [];

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // skip empty lines and comments
        if (trimmed === "data: [DONE]") continue;

        if (!trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6);
        let chunk: {
          choices: Array<{
            delta: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };

        try {
          chunk = JSON.parse(jsonStr);
        } catch {
          logger.debug("Failed to parse SSE chunk:", jsonStr.slice(0, 100));
          continue;
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Content token
        if (delta.content) {
          fullContent += delta.content;
          callbacks?.onToken?.(delta.content);
        }

        // Tool call fragments
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // Ensure accumulator exists for this index
            while (toolCallAccumulators.length <= tc.index) {
              toolCallAccumulators.push({ id: "", name: "", arguments: "" });
            }
            const acc = toolCallAccumulators[tc.index];
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }
      }
    }

    // Build final tool calls
    const toolCalls: ToolCall[] = toolCallAccumulators
      .filter((tc) => tc.name)
      .map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: this.parseJSON(tc.arguments),
      }));

    // Notify about complete tool calls
    for (const tc of toolCalls) {
      callbacks?.onToolCall?.(tc);
    }

    logger.debug("LLM stream done:", { contentLen: fullContent.length, toolCalls: toolCalls.length });

    return { content: fullContent, toolCalls };
  }

  private parseJSON(s: string): Record<string, unknown> {
    try {
      return JSON.parse(s);
    } catch {
      logger.warn("Failed to parse tool arguments:", s);
      return {};
    }
  }
}
