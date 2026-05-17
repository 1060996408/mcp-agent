/**
 * Backward-compatible re-export.
 * LLMClient is now OpenAIProvider — same behavior, new name.
 * Import from "llm-provider.js" for the new interface-based API.
 */
export { OpenAIProvider as LLMClient } from "./llm-provider.js";
export type { StreamCallbacks, LLMResponse, LLMProvider, LLMToolDef } from "./llm-provider.js";
