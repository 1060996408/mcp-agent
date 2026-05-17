import { logger } from "./logger.js";
import type { Message, ToolCall } from "./types.js";

/** Context passed to middleware hooks */
export interface MiddlewareContext {
  /** Which phase triggered this hook */
  type: "llm" | "tool";
  /** The tool call being executed (tool hooks only) */
  toolCall?: ToolCall;
  /** The messages being sent to LLM (llm hooks only) */
  messages?: Message[];
  /** LLM response or tool result (afterLLM/afterToolCall) */
  result?: { content: string; toolCalls?: ToolCall[]; isError?: boolean };
  /** Error if the operation failed */
  error?: Error;
  /** Shared metadata bag for passing data between hooks */
  metadata: Record<string, unknown>;
}

/** Call to pass control to the next middleware or the actual operation */
export type Next = () => Promise<void>;

/** Middleware interface — implement any subset of hooks */
export interface Middleware {
  name?: string;
  /** Before LLM chat/streamChat call */
  beforeLLM?: (ctx: MiddlewareContext, next: Next) => Promise<void>;
  /** After LLM returns a response */
  afterLLM?: (ctx: MiddlewareContext, next: Next) => Promise<void>;
  /** Before a single tool call executes */
  beforeToolCall?: (ctx: MiddlewareContext, next: Next) => Promise<void>;
  /** After a single tool call completes */
  afterToolCall?: (ctx: MiddlewareContext, next: Next) => Promise<void>;
  /** On error in any phase */
  onError?: (ctx: MiddlewareContext, next: Next) => Promise<void>;
}

/** Run a middleware chain for a given hook name, with an action at the end */
export async function runHooks(
  middleware: Middleware[],
  hookName: keyof Middleware,
  ctx: MiddlewareContext,
  action: () => Promise<void>,
): Promise<void> {
  const applicable = middleware.filter((m) => typeof m[hookName] === "function");
  if (applicable.length === 0) return action();

  let index = 0;
  const next: Next = async () => {
    const mw = applicable[index++];
    const hook = mw?.[hookName];
    if (typeof hook === "function") {
      await (hook as (ctx: MiddlewareContext, next: Next) => Promise<void>)(ctx, next);
    } else {
      await action();
    }
  };
  await next();
}

// ── Built-in middleware ─────────────────────────────────────────────

/** Logs timing for LLM calls and tool calls */
export class LoggingMiddleware implements Middleware {
  name = "logging";

  beforeLLM = async (ctx: MiddlewareContext, next: Next) => {
    ctx.metadata._llmStart = Date.now();
    await next();
  };

  afterLLM = async (ctx: MiddlewareContext, next: Next) => {
    const elapsed = Date.now() - (ctx.metadata._llmStart as number ?? Date.now());
    const tcCount = ctx.result?.toolCalls?.length ?? 0;
    logger.info(`LLM call: ${elapsed}ms, ${tcCount} tool call(s)`);
    await next();
  };

  beforeToolCall = async (ctx: MiddlewareContext, next: Next) => {
    ctx.metadata._toolStart = Date.now();
    logger.debug(`Tool call: ${ctx.toolCall?.name}`);
    await next();
  };

  afterToolCall = async (ctx: MiddlewareContext, next: Next) => {
    const elapsed = Date.now() - (ctx.metadata._toolStart as number ?? Date.now());
    logger.info(`Tool ${ctx.toolCall?.name}: ${elapsed}ms${ctx.result?.isError ? " (error)" : ""}`);
    await next();
  };
}

export interface RetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
}

/** Retries failed LLM calls with exponential backoff */
export class RetryMiddleware implements Middleware {
  name = "retry";
  private maxRetries: number;
  private baseDelayMs: number;

  constructor(config?: RetryConfig) {
    this.maxRetries = config?.maxRetries ?? 3;
    this.baseDelayMs = config?.baseDelayMs ?? 1000;
  }

  onError = async (ctx: MiddlewareContext, next: Next) => {
    if (ctx.type !== "llm" || !ctx.error) {
      await next();
      return;
    }

    const attempt = (ctx.metadata._retryAttempt as number) ?? 0;
    if (attempt >= this.maxRetries) {
      logger.warn(`Retry exhausted after ${attempt} attempts`);
      await next();
      return;
    }

    const delay = this.baseDelayMs * 2 ** attempt;
    logger.info(`Retrying LLM call (attempt ${attempt + 1}/${this.maxRetries}) after ${delay}ms`);
    ctx.metadata._retryAttempt = attempt + 1;
    ctx.metadata._shouldRetry = true;

    await new Promise((r) => setTimeout(r, delay));
    // Don't call next — the loop will re-enter based on _shouldRetry flag
  };
}

// ── CircuitBreaker ──────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Number of consecutive identical failures before tripping (default: 3) */
  threshold?: number;
}

/**
 * Tracks consecutive identical failures per tool name.
 * Trips after threshold, halting further tool calls.
 * Resets on success or a different error signature.
 * Inspired by naqsha's circuit_breaker.py.
 */
export class CircuitBreakerMiddleware implements Middleware {
  name = "circuit-breaker";
  private threshold: number;
  private failureStreaks = new Map<string, { count: number; signature: string }>();

  constructor(config?: CircuitBreakerConfig) {
    this.threshold = config?.threshold ?? 3;
  }

  afterToolCall = async (ctx: MiddlewareContext, next: Next) => {
    const toolName = ctx.toolCall?.name ?? "unknown";

    if (ctx.result?.isError) {
      const signature = ctx.result.content.slice(0, 200);
      const streak = this.failureStreaks.get(toolName);

      if (streak && streak.signature === signature) {
        streak.count++;
      } else {
        this.failureStreaks.set(toolName, { count: 1, signature });
      }

      const current = this.failureStreaks.get(toolName)!;
      if (current.count >= this.threshold) {
        logger.warn(`Circuit breaker tripped for tool "${toolName}" after ${current.count} consecutive failures`);
        ctx.metadata._circuitTripped = true;
        // Replace the result with a circuit-breaker error
        ctx.result = {
          content: `Circuit breaker: tool "${toolName}" failed ${current.count} times consecutively with the same error. Further calls blocked.`,
          isError: true,
        };
      }
    } else {
      // Success resets the streak
      this.failureStreaks.delete(toolName);
    }

    await next();
  };

  /** Get current failure streak info (for testing/monitoring) */
  getStreak(toolName: string): { count: number; signature: string } | undefined {
    return this.failureStreaks.get(toolName);
  }

  /** Reset all streaks */
  reset(): void {
    this.failureStreaks.clear();
  }
}

// ── BudgetMeter ─────────────────────────────────────────────────────

export interface BudgetConfig {
  /** Maximum total tool calls per run (default: 50) */
  maxToolCalls?: number;
  /** Maximum wall clock time per run in ms (default: 300000 = 5min) */
  wallClockMs?: number;
  /** Maximum time per individual tool call in ms (default: 60000 = 1min) */
  perToolMs?: number;
  /** Maximum total tokens (prompt + completion) per run */
  maxTokens?: number;
}

/**
 * Enforces hard caps on agent execution.
 * Raises errors when budget is exceeded. Inspired by naqsha's budgets.py.
 */
export class BudgetMeter implements Middleware {
  name = "budget";
  private maxToolCalls: number;
  private wallClockMs: number;
  private perToolMs: number;
  private maxTokens: number;
  private runStart = 0;
  private toolCallCount = 0;
  private tokenCount = 0;

  constructor(config?: BudgetConfig) {
    this.maxToolCalls = config?.maxToolCalls ?? 50;
    this.wallClockMs = config?.wallClockMs ?? 300_000;
    this.perToolMs = config?.perToolMs ?? 60_000;
    this.maxTokens = config?.maxTokens ?? Infinity;
  }

  beforeLLM = async (ctx: MiddlewareContext, next: Next) => {
    if (!this.runStart) this.runStart = Date.now();

    const elapsed = Date.now() - this.runStart;
    if (elapsed > this.wallClockMs) {
      ctx.error = new Error(`Budget exceeded: wall clock limit (${this.wallClockMs}ms) reached after ${elapsed}ms`);
      ctx.metadata._budgetExceeded = true;
      return; // Don't call next
    }
    await next();
  };

  afterLLM = async (ctx: MiddlewareContext, next: Next) => {
    const tokens = ctx.metadata._tokensUsed as number | undefined;
    if (tokens) {
      this.tokenCount += tokens;
      if (this.tokenCount > this.maxTokens) {
        ctx.error = new Error(`Budget exceeded: token limit (${this.maxTokens}) reached (${this.tokenCount} used)`);
        ctx.metadata._budgetExceeded = true;
        return;
      }
    }
    await next();
  };

  beforeToolCall = async (ctx: MiddlewareContext, next: Next) => {
    this.toolCallCount++;

    if (this.toolCallCount > this.maxToolCalls) {
      ctx.error = new Error(`Budget exceeded: tool call limit (${this.maxToolCalls}) reached`);
      ctx.metadata._budgetExceeded = true;
      return;
    }

    const elapsed = Date.now() - this.runStart;
    if (elapsed > this.wallClockMs) {
      ctx.error = new Error(`Budget exceeded: wall clock limit (${this.wallClockMs}ms) reached`);
      ctx.metadata._budgetExceeded = true;
      return;
    }

    // Store timeout for per-tool enforcement
    ctx.metadata._perToolTimeout = this.perToolMs;
    await next();
  };

  /** Reset counters for a new run */
  resetRun(): void {
    this.runStart = Date.now();
    this.toolCallCount = 0;
    this.tokenCount = 0;
  }

  /** Get current stats */
  stats(): { toolCalls: number; elapsedMs: number; tokens: number } {
    return { toolCalls: this.toolCallCount, elapsedMs: Date.now() - this.runStart, tokens: this.tokenCount };
  }
}

// ── OutputSanitizer ─────────────────────────────────────────────────

export interface SanitizerConfig {
  /** Maximum output length in characters (default: 10000) */
  maxOutputLength?: number;
  /** Custom patterns to redact (in addition to defaults) */
  customPatterns?: RegExp[];
}

const DEFAULT_REDACT_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[=:]\s*\S+/gi,
  /(?:secret|token|password|passwd|pwd)\s*[=:]\s*\S+/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._\-]+/gi,
  /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/g,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
];

/**
 * Sanitizes tool output before it enters the model context.
 * Truncates long output and redacts potential secrets.
 * Inspired by naqsha's sanitizer.py.
 */
export class OutputSanitizer implements Middleware {
  name = "sanitizer";
  private maxOutputLength: number;
  private patterns: RegExp[];

  constructor(config?: SanitizerConfig) {
    this.maxOutputLength = config?.maxOutputLength ?? 10_000;
    this.patterns = [...DEFAULT_REDACT_PATTERNS, ...(config?.customPatterns ?? [])];
  }

  afterToolCall = async (ctx: MiddlewareContext, next: Next) => {
    if (ctx.result?.content) {
      ctx.result.content = this.sanitize(ctx.result.content);
    }
    await next();
  };

  sanitize(text: string): string {
    let result = text;

    // Redact secrets
    for (const pattern of this.patterns) {
      result = result.replace(pattern, "[REDACTED]");
    }

    // Truncate
    if (result.length > this.maxOutputLength) {
      result = result.slice(0, this.maxOutputLength) + `\n... [truncated at ${this.maxOutputLength} chars, original: ${text.length}]`;
    }

    return result;
  }
}
