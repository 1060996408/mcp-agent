import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";
import type { Message } from "./types.js";

export interface MemoryEntry {
  id: string;
  timestamp: string;
  summary: string;
  tags: string[];
}

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

    this.memories = state.memories ?? [];
    this.nextId = this.memories.length + 1;

    logger.info(`Loaded conversation: ${state.metadata?.turns ?? "?"} turns, ${this.memories.length} memories`);
    return state.history ?? [];
  }

  /** Add a memory entry */
  addMemory(summary: string, tags: string[] = []): MemoryEntry {
    const entry: MemoryEntry = {
      id: String(this.nextId++),
      timestamp: new Date().toISOString(),
      summary,
      tags,
    };
    this.memories.push(entry);
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
