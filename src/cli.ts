#!/usr/bin/env node

import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Agent } from "./agent.js";
import { LoggingMiddleware, RetryMiddleware } from "./middleware.js";
import { logger } from "./logger.js";

// ANSI color helpers (no external deps)
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};
const noColor = !!process.env.NO_COLOR;
const fmt = (color: string, text: string) => noColor ? text : `${color}${text}${c.reset}`;

const DEFAULT_CONFIG = process.env.MCP_AGENT_CONFIG ?? "~/.config/shared/mcp-servers.json";

/** Expand ~ to home directory (cross-platform) */
function expandPath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

const CODING_SYSTEM_PROMPT = `You are a coding assistant with access to MCP tools for file operations, GitHub, and more.
When asked to write or modify code:
- Read the relevant files first to understand the current state
- Make targeted changes rather than rewriting entire files
- Explain what you changed and why
When debugging:
- Read error messages and relevant source files
- Propose specific fixes with file paths and line numbers
Be concise. Show code, not explanations, unless asked.`;

function printHelp(): void {
  console.log(`
mcp-agent — Lightweight MCP-native agent framework

Usage:
  mcp-agent <prompt>                              Run with default config
  mcp-agent --config <path> <prompt>              Run with custom config
  mcp-agent --stream <prompt>                     Run with streaming output
  mcp-agent --interactive                         Interactive multi-turn mode
  mcp-agent --session <path> --interactive        Interactive with session persistence
  mcp-agent --verbose <prompt>                    Run with debug logging

Options:
  --config, -c <path>    Path to MCP server config JSON
  --session <path>       Session file for persistent memory + history
  --stream, -s           Enable streaming token output
  --interactive, -i      Interactive multi-turn conversation mode
  --verbose, -v          Enable debug logging
  --servers <names>      Comma-separated list of servers to connect (default: all)
  --health               Check health of connected MCP servers and exit
  --help, -h             Show this help

Examples:
  mcp-agent "帮我查看 video.mp4 的分辨率"
  mcp-agent --stream "分析这个文件"
  mcp-agent --session ~/.agent/session.json --interactive
  mcp-agent --servers filesystem,github "查看 repo 的 PR 列表"

Environment:
  MCP_AGENT_CONFIG    Default config path (default: ~/.config/shared/mcp-servers.json)
  MCP_AGENT_MODEL     LLM model name
  MCP_AGENT_BASE_URL  LLM API base URL
`);
}

function setupEvents(agent: Agent): void {
  agent.events.on("beforeToolCall", (d) => {
    const args = Object.keys(d.toolCall.arguments).length > 0
      ? `(${Object.entries(d.toolCall.arguments).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`
      : "";
    process.stderr.write(`  ${fmt(c.cyan, d.toolCall.name)}${fmt(c.dim, args)} ...`);
  });

  agent.events.on("afterToolCall", (d) => {
    if (d.isError) {
      process.stderr.write(` ${fmt(c.red, "ERROR")} ${fmt(c.dim, `(${d.elapsedMs}ms)`)}\n`);
    } else {
      process.stderr.write(` ${fmt(c.green, "ok")} ${fmt(c.dim, `(${d.elapsedMs}ms)`)}\n`);
    }
  });

  agent.events.on("error", (d) => {
    if (d.phase === "llm") {
      process.stderr.write(`  ${fmt(c.red, "error")}: ${d.error.message}\n`);
    }
  });
}

/** Callback for streaming: show tool call name as soon as it starts arriving */
function onToolCallStart(tc: { id: string; name: string }): void {
  process.stderr.write(`\n  ${fmt(c.cyan, tc.name)}${fmt(c.dim, " ...")}`);
}

async function runInteractive(agent: Agent): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`${fmt(c.bold, "mcp-agent")} interactive mode ${fmt(c.dim, "(type 'exit' to end, 'reset' to clear history)")}\n`);

  const prompt = (): Promise<string> =>
    new Promise((resolve) => rl.question(fmt(c.bold, "You: "), resolve));

  while (true) {
    const input = await prompt();
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit") break;
    if (trimmed === "reset") {
      agent.reset();
      console.log(`${fmt(c.dim, "[History cleared]")}\n`);
      continue;
    }

    try {
      const result = await agent.runStream(trimmed, {
        onToken: (token) => process.stdout.write(token),
        onToolCallStart,
      });

      // Ensure newline after streaming output
      const lastMsg = agent.getLastResponse(result);
      if (lastMsg && !lastMsg.endsWith("\n")) {
        console.log();
      }
      console.log();
    } catch (e) {
      console.error(fmt(c.red, "Error:"), e instanceof Error ? e.message : e);
    }
  }

  rl.close();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let configPath = DEFAULT_CONFIG;
  let verbose = false;
  let stream = false;
  let interactive = false;
  let healthCheck = false;
  let sessionPath: string | undefined;
  let serverFilter: string[] | undefined;
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === "--config" || arg === "-c") && i + 1 < args.length) {
      configPath = args[++i]!;
    } else if (arg === "--session" && i + 1 < args.length) {
      sessionPath = args[++i]!;
    } else if (arg === "--servers" && i + 1 < args.length) {
      serverFilter = args[++i]!.split(",").map((s) => s.trim());
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--stream" || arg === "-s") {
      stream = true;
    } else if (arg === "--interactive" || arg === "-i") {
      interactive = true;
    } else if (arg === "--health") {
      healthCheck = true;
    } else if (!arg.startsWith("-")) {
      promptParts.push(arg);
    }
  }

  if (verbose) logger.setLevel("debug");

  const agent = new Agent({
    baseUrl: process.env.MCP_AGENT_BASE_URL ?? "http://127.0.0.1:15721/v1",
    model: process.env.MCP_AGENT_MODEL ?? "gpt-5.4",
  });

  // Wire up middleware
  agent.use(new LoggingMiddleware());
  agent.use(new RetryMiddleware({ maxRetries: 2 }));

  // Wire up event display
  setupEvents(agent);

  // Set coding-specific system prompt
  agent.setSystemPrompt(CODING_SYSTEM_PROMPT);

  // Enable session persistence if requested
  if (sessionPath) {
    agent.enableSession(expandPath(sessionPath));
  }

  // Graceful shutdown on SIGINT/SIGTERM
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\n${fmt(c.dim, `[${signal} received, shutting down...]`)}\n`);
    try {
      await agent.close();
    } catch { /* ignore close errors during shutdown */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    if (serverFilter) {
      // Read config and filter to only specified servers
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(expandPath(configPath), "utf-8");
      const config = JSON.parse(raw);
      const allServers = config.servers ?? config;
      const filtered: Record<string, unknown> = {};
      for (const name of serverFilter) {
        if (name.startsWith("_")) continue;
        if (allServers[name]) {
          filtered[name] = allServers[name];
        } else {
          logger.warn(`Server not found in config: ${name}`);
        }
      }
      if (Object.keys(filtered).length === 0) {
        console.error("Error: no valid servers matched --servers filter");
        process.exit(1);
      }
      logger.info(`Connecting to: ${Object.keys(filtered).join(", ")}`);
      await agent.connectServers(filtered as Record<string, import("./types.js").MCPServerConfig>);
    } else {
      await agent.loadConfig(expandPath(configPath));
    }

    // Show server status in verbose mode
    if (verbose) {
      const status = agent.pool.getServerStatus();
      process.stderr.write(`\n${fmt(c.bold, "Servers:")}\n`);
      for (const s of status) {
        process.stderr.write(`  ${fmt(c.green, "●")} ${s.name} ${fmt(c.dim, `(${s.transport})`)}\n`);
      }
      process.stderr.write("\n");
    }

    // Health check mode: check servers and exit
    if (healthCheck) {
      const health = await agent.healthCheck();
      process.stdout.write(`\n${fmt(c.bold, "MCP Server Health")}\n`);
      process.stdout.write("─".repeat(50) + "\n");
      for (const h of health) {
        const status = h.healthy
          ? fmt(c.green, "✓ healthy")
          : fmt(c.red, "✗ unhealthy");
        const latency = h.latencyMs !== undefined ? fmt(c.dim, ` (${h.latencyMs}ms)`) : "";
        const tools = h.toolCount !== undefined ? fmt(c.dim, ` [${h.toolCount} tools]`) : "";
        process.stdout.write(`  ${status} ${h.name}${latency}${tools}\n`);
        if (h.error) process.stdout.write(`    ${fmt(c.red, h.error)}\n`);
      }
      process.stdout.write("\n");
      await agent.close();
      process.exit(0);
    }

    if (interactive) {
      await runInteractive(agent);
    } else {
      const prompt = promptParts.join(" ");
      if (!prompt) {
        console.error(fmt(c.red, "Error:") + " no prompt provided");
        process.exit(1);
      }

      if (stream) {
        const result = await agent.runStream(prompt, {
          onToken: (token) => process.stdout.write(token),
          onToolCallStart,
        });
        if (!agent.getLastResponse(result).endsWith("\n")) {
          console.log();
        }
      } else {
        const result = await agent.run(prompt);
        console.log(agent.getLastResponse(result));
      }
    }
  } catch (e) {
    console.error(fmt(c.red, "Error:"), e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await agent.close();
  }
}

main();
