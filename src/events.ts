import type { Message, ToolCall } from "./types.js";

/** All agent event types */
export interface AgentEvents {
  /** Fired when a run starts */
  runStart: { userMessage: string; messageCount: number };
  /** Fired before sending messages to the LLM */
  beforeLLM: { round: number; messageCount: number };
  /** Fired after LLM responds */
  afterLLM: { round: number; content: string; toolCallCount: number; tokensUsed?: number };
  /** Fired before executing a tool call */
  beforeToolCall: { round: number; toolCall: ToolCall };
  /** Fired after a tool call completes */
  afterToolCall: { round: number; toolCall: ToolCall; content: string; isError: boolean; elapsedMs: number };
  /** Fired when an error occurs */
  error: { phase: "llm" | "tool"; error: Error; toolCall?: ToolCall };
  /** Fired when the run completes */
  runEnd: { toolCallsExecuted: number; tokensUsed?: number; rounds: number };
  /** Fired when history is truncated */
  historyTruncated: { dropped: number; remaining: number };
}

export type EventName = keyof AgentEvents;
export type EventHandler<T extends EventName> = (data: AgentEvents[T]) => void;

/**
 * Typed event emitter for agent lifecycle events.
 * Enables monitoring, TUI, and test assertions without touching core code.
 */
type HandlerMap = {
  [K in EventName]?: Set<EventHandler<K>>;
};

export class AgentEventEmitter {
  private handlers: HandlerMap = {};

  on<T extends EventName>(event: T, handler: EventHandler<T>): void {
    this.getHandlers(event).add(handler);
  }

  off<T extends EventName>(event: T, handler: EventHandler<T>): void {
    this.getHandlers(event).delete(handler);
  }

  emit<T extends EventName>(event: T, data: AgentEvents[T]): void {
    for (const handler of this.getHandlers(event)) {
      try { handler(data); } catch { /* don't let handler errors break the loop */ }
    }
  }

  removeAllListeners(event?: EventName): void {
    if (event) delete this.handlers[event];
    else this.handlers = {};
  }

  private getHandlers<T extends EventName>(event: T): Set<EventHandler<T>> {
    this.handlers[event] ??= new Set() as HandlerMap[T];
    return this.handlers[event] as Set<EventHandler<T>>;
  }
}
