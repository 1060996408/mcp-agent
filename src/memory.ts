import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";
import type { Message } from "./types.js";

export interface MemoryEntry {
  id: string;
  timestamp: string;
  summary: string;
  tags: string[];
  /** Importance score 0-1, higher = more important (default 0.5) */
  importance: number;
}

const DEFAULT_MAX_MEMORIES = 200;
const DEFAULT_IMPORTANCE = 0.5;

export interface PersistedState {
  history: Message[];
  memories: MemoryEntry[];
  metadata: {
    savedAt: string;
    turns: number;
  };
}

/**
 * Manages persistent conversation state:
 * - Save/load conversation history to disk
 * - Long-term memory bank (summarized facts across sessions)
 */
export class MemoryManager {
  private memories: MemoryEntry[] = [];
  private nextId = 1;
  private maxMemories: number;

  constructor(maxMemories = DEFAULT_MAX_MEMORIES) {
    this.maxMemories = maxMemories;
  }

  /** Save conversation history and memories to a file */
  save(path: string, history: Message[]): void {
    const state: PersistedState = {
      history,
      memories: this.memories,
      metadata: {
        savedAt: new Date().toISOString(),
        turns: history.filter((m) => m.role === "user").length,
      },
    };

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
    logger.info(`Saved conversation: ${state.metadata.turns} turns, ${this.memories.length} memories → ${path}`);
  }

  /** Load conversation history and memories from a file */
  load(path: string): Message[] {
    if (!existsSync(path)) {
      logger.warn(`No saved conversation found at ${path}`);
      return [];
    }

    const raw = readFileSync(path, "utf-8");
    const state = JSON.parse(raw) as PersistedState;

    this.memories = (state.memories ?? []).map((m) => ({
      ...m,
      importance: m.importance ?? DEFAULT_IMPORTANCE,
    }));
    this.nextId = this.memories.length + 1;

    logger.info(`Loaded conversation: ${state.metadata?.turns ?? "?"} turns, ${this.memories.length} memories`);
    return state.history ?? [];
  }

  /** Add a memory entry */
  addMemory(summary: string, tags: string[] = [], importance = DEFAULT_IMPORTANCE): MemoryEntry {
    const entry: MemoryEntry = {
      id: String(this.nextId++),
      timestamp: new Date().toISOString(),
      summary,
      tags,
      importance: Math.max(0, Math.min(1, importance)),
    };
    this.memories.push(entry);
    this.evict();
    logger.debug(`Memory added: ${summary.slice(0, 60)}...`);
    return entry;
  }

  /** Get all memories */
  getMemories(): readonly MemoryEntry[] {
    return this.memories;
  }

  /** Search memories by tag */
  searchByTag(tag: string): MemoryEntry[] {
    return this.memories.filter((m) => m.tags.includes(tag));
  }

  /** Full-text search across summary and tags */
  search(query: string): MemoryEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) return [];

    return this.memories
      .map((m) => {
        const text = `${m.summary} ${m.tags.join(" ")}`.toLowerCase();
        let score = 0;
        for (const word of words) {
          if (text.includes(word)) score++;
        }
        return { entry: m, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.importance - a.entry.importance)
      .map((r) => r.entry);
  }

  /** Evict lowest-importance memories when over limit */
  private evict(): void {
    if (this.memories.length <= this.maxMemories) return;
    // Sort by importance ascending, then by timestamp ascending (oldest first)
    this.memories.sort((a, b) => a.importance - b.importance || a.timestamp.localeCompare(b.timestamp));
    const dropped = this.memories.length - this.maxMemories;
    this.memories = this.memories.slice(dropped);
    logger.debug(`Evicted ${dropped} low-importance memories (now ${this.memories.length})`);
  }

  /** Get a formatted string of all memories (for system prompt injection) */
  formatMemories(): string {
    if (this.memories.length === 0) return "";

    const lines = ["## Long-term Memory"];
    for (const m of this.memories) {
      const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
      lines.push(`- (${m.id}) ${m.summary}${tags}`);
    }
    return lines.join("\n");
  }

  /** Clear all memories */
  clear(): void {
    this.memories = [];
    this.nextId = 1;
  }
}
