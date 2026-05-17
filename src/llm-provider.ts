import { logger } from "./logger.js";
import type { LLMConfig, Message, ToolCall } from "./types.js";

/** Error thrown when an LLM request exceeds the configured timeout */
export class LLMTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "LLMTimeoutError";
  }
}

export interface StreamCallbacks {
  onToken?: (token: string) => void;
  /** Fires for each completed tool call (after all arguments received) */
  onToolCall?: (toolCall: ToolCall) => void;
  /** Fires as soon as a tool call name is known (arguments may still be streaming) */
  onToolCallStart?: (toolCall: { id: string; name: string }) => void;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: { prompt: number; completion: number };
}

export interface LLMToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** Abstraction for LLM providers — implement this to swap backends */
export interface LLMProvider {
  chat(messages: Message[], tools?: LLMToolDef[]): Promise<LLMResponse>;
  streamChat(messages: Message[], tools?: LLMToolDef[], callbacks?: StreamCallbacks): Promise<LLMResponse>;
}

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

/** OpenAI-compatible LLM provider (works with any OpenAI-format API) */
export class OpenAIProvider implements LLMProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private timeoutMs: number;

  constructor(config?: LLMConfig) {
    this.baseUrl = (config?.baseUrl ?? "http://127.0.0.1:15721/v1").replace(/\/$/, "");
    this.apiKey = config?.apiKey ?? "PROXY_MANAGED";
    this.model = config?.model ?? "gpt-5.4";
    this.maxTokens = config?.maxTokens ?? 4096;
    this.temperature = config?.temperature ?? 0;
    this.timeoutMs = config?.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  private buildBody(messages: Message[], tools?: LLMToolDef[], stream = false): Record<string, unknown> {
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
        if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
        return base;
      }),
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (tools && tools.length > 0) body.tools = tools;
    return body;
  }

  async chat(messages: Message[], tools?: LLMToolDef[]): Promise<LLMResponse> {
    const body = this.buildBody(messages, tools, false);
    logger.debug("LLM request:", { model: this.model, messageCount: messages.length, toolCount: tools?.length ?? 0 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new LLMTimeoutError(this.timeoutMs);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error("LLM returned no choices");

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: this.parseJSON(tc.function.arguments),
    }));

    const usage = data.usage ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens } : undefined;
    logger.debug("LLM response:", { contentLen: (choice.message.content ?? "").length, toolCalls: toolCalls.length, usage });

    return { content: choice.message.content ?? "", toolCalls, usage };
  }

  async streamChat(messages: Message[], tools?: LLMToolDef[], callbacks?: StreamCallbacks): Promise<LLMResponse> {
    const body = this.buildBody(messages, tools, true);
    logger.debug("LLM stream request:", { model: this.model, messageCount: messages.length, toolCount: tools?.length ?? 0 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new LLMTimeoutError(this.timeoutMs);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("LLM streaming response has no body");

    let fullContent = "";
    const toolCallAccumulators: Array<{ id: string; name: string; arguments: string }> = [];
    const startedToolCalls = new Set<number>(); // track which tool calls have fired onToolCallStart
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamUsage: { prompt: number; completion: number } | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]" || !trimmed.startsWith("data: ")) continue;

        let chunk: { choices: Array<{ delta: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
        try { chunk = JSON.parse(trimmed.slice(6)); } catch { continue; }

        // Extract usage from the final chunk (sent when stream_options.include_usage is true)
        if (chunk.usage) {
          streamUsage = { prompt: chunk.usage.prompt_tokens, completion: chunk.usage.completion_tokens };
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          fullContent += delta.content;
          callbacks?.onToken?.(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            while (toolCallAccumulators.length <= tc.index) toolCallAccumulators.push({ id: "", name: "", arguments: "" });
            const acc = toolCallAccumulators[tc.index];
            if (!acc) continue;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            // Fire onToolCallStart as soon as we have a name and haven't fired yet
            if (acc.name && !startedToolCalls.has(tc.index)) {
              startedToolCalls.add(tc.index);
              callbacks?.onToolCallStart?.({ id: acc.id, name: acc.name });
            }
          }
        }
      }
    }

    const toolCalls: ToolCall[] = toolCallAccumulators.filter((tc) => tc.name).map((tc) => ({
      id: tc.id, name: tc.name, arguments: this.parseJSON(tc.arguments),
    }));

    for (const tc of toolCalls) callbacks?.onToolCall?.(tc);
    logger.debug("LLM stream done:", { contentLen: fullContent.length, toolCalls: toolCalls.length, usage: streamUsage });

    return { content: fullContent, toolCalls, usage: streamUsage };
  }

  private parseJSON(s: string): Record<string, unknown> {
    try { return JSON.parse(s); }
    catch { logger.warn("Failed to parse tool arguments:", s); return {}; }
  }
}
