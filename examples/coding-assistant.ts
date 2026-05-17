/**
 * Coding Assistant Agent — full-featured CLI that validates all framework capabilities.
 *
 * Demonstrates:
 * - Multi-server connection (filesystem + github)
 * - Streaming with incremental tool call display (onToolCallStart)
 * - Health check on startup
 * - Tool filtering (allow/deny)
 * - Error recovery (retry middleware, graceful shutdown)
 * - Session persistence
 * - Cancel support (Ctrl+C)
 *
 * Usage:
 *   npx tsx examples/coding-assistant.ts "查看当前目录的文件"
 *   npx tsx examples/coding-assistant.ts --stream "分析 src/agent.ts 的代码结构"
 *   npx tsx examples/coding-assistant.ts --interactive
 *   npx tsx examples/coding-assistant.ts --health
 *   npx tsx examples/coding-assistant.ts --session ~/.agent/session.json --interactive
 */

import { Agent, LoggingMiddleware, RetryMiddleware } from "../src/index.js";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// ANSI colors
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};
const fmt = (color: string, text: string) => `${color}${text}${c.reset}`;

const CONFIG_PATH = process.env.MCP_AGENT_CONFIG ?? "~/.config/shared/mcp-servers.json";

function expandPath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  return p;
}

const CODING_PROMPT = `You are a coding assistant with access to filesystem and GitHub tools.
When asked to write or modify code:
- Read the relevant files first to understand the current state
- Make targeted changes rather than rewriting entire files
- Explain what you changed and why
When debugging:
- Read error messages and relevant source files
- Propose specific fixes with file paths and line numbers
When reviewing code:
- Check for bugs, security issues, performance problems
- Suggest improvements with file:line references
Be concise. Show code, not explanations, unless asked.`;

function printHelp(): void {
  console.log(`
coding-assistant — Full-featured coding agent powered by mcp-agent

Usage:
  npx tsx examples/coding-assistant.ts <prompt>              Single query
  npx tsx examples/coding-assistant.ts --stream <prompt>     Streaming output
  npx tsx examples/coding-assistant.ts --interactive         Multi-turn mode
  npx tsx examples/coding-assistant.ts --health              Check server health

Options:
  --stream, -s           Enable streaming token output
  --interactive, -i      Interactive multi-turn mode
  --session <path>       Session file for persistent memory
  --health               Check MCP server health and exit
  --verbose, -v          Debug logging
  --help, -h             Show this help

Examples:
  npx tsx examples/coding-assistant.ts "列出 src/ 下的所有 TypeScript 文件"
  npx tsx examples/coding-assistant.ts --stream "分析 package.json 的依赖"
  npx tsx examples/coding-assistant.ts --interactive
  npx tsx examples/coding-assistant.ts --session ~/.agent/coding.json --interactive
`);
}

// Streaming callback: show tool name as soon as it starts arriving
function onToolCallStart(tc: { id: string; name: string }): void {
  process.stderr.write(`\n  ${fmt(c.cyan, tc.name)}${fmt(c.dim, " ...")}`);
}

// Wire up event display
function setupEvents(agent: Agent): void {
  agent.events.on("beforeToolCall", (d) => {
    const args =
      Object.keys(d.toolCall.arguments).length > 0
        ? `(${Object.entries(d.toolCall.arguments)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ")})`
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

async function runInteractive(agent: Agent): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(
    `${fmt(c.bold, "coding-assistant")} interactive mode ${fmt(c.dim, "(type 'exit' to end, 'reset' to clear)")}\n`,
  );

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
      const lastMsg = agent.getLastResponse(result);
      if (lastMsg && !lastMsg.endsWith("\n")) console.log();
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

  let verbose = false;
  let stream = false;
  let interactive = false;
  let healthCheck = false;
  let sessionPath: string | undefined;
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--session" && i + 1 < args.length) {
      sessionPath = args[++i];
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

  const agent = new Agent({
    baseUrl: process.env.MCP_AGENT_BASE_URL ?? "http://127.0.0.1:15721/v1",
    model: process.env.MCP_AGENT_MODEL ?? "gpt-5.4",
  });

  // Wire up middleware
  agent.use(new LoggingMiddleware());
  agent.use(new RetryMiddleware({ maxRetries: 2 }));

  // Wire up events
  setupEvents(agent);

  // Set coding system prompt
  agent.setSystemPrompt(CODING_PROMPT);

  // Session persistence
  if (sessionPath) agent.enableSession(expandPath(sessionPath));

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\n${fmt(c.dim, `[${signal} received, shutting down...]`)}\n`);
    try {
      await agent.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    // Load config — only connect filesystem + github for fast startup
    const raw = readFileSync(expandPath(CONFIG_PATH), "utf-8");
    const config = JSON.parse(raw);
    const allServers = config.servers ?? config;

    const wanted = ["filesystem", "github"];
    const filtered: Record<string, unknown> = {};
    for (const name of wanted) {
      if (allServers[name]) {
        filtered[name] = allServers[name];
      } else if (verbose) {
        console.error(fmt(c.yellow, `Warning: server '${name}' not found in config`));
      }
    }

    if (Object.keys(filtered).length === 0) {
      console.error(fmt(c.red, "Error:") + " no usable servers found in config");
      process.exit(1);
    }

    console.log(fmt(c.dim, `Connecting to: ${Object.keys(filtered).join(", ")}...`));
    await agent.connectServers(filtered as Record<string, import("../src/types.js").MCPServerConfig>);

    // Health check
    const health = await agent.healthCheck();
    for (const h of health) {
      const icon = h.healthy ? fmt(c.green, "●") : fmt(c.red, "✗");
      const tools = h.toolCount !== undefined ? fmt(c.dim, ` [${h.toolCount} tools]`) : "";
      console.log(`  ${icon} ${h.name}${tools}`);
    }
    console.log();

    // --health mode: print detailed health and exit
    if (healthCheck) {
      console.log(fmt(c.bold, "MCP Server Health"));
      console.log("─".repeat(50));
      for (const h of health) {
        const status = h.healthy ? fmt(c.green, "✓ healthy") : fmt(c.red, "✗ unhealthy");
        const latency = h.latencyMs !== undefined ? fmt(c.dim, ` (${h.latencyMs}ms)`) : "";
        const tools = h.toolCount !== undefined ? fmt(c.dim, ` [${h.toolCount} tools]`) : "";
        console.log(`  ${status} ${h.name}${latency}${tools}`);
        if (h.error) console.log(`    ${fmt(c.red, h.error)}`);
      }
      await agent.close();
      process.exit(0);
    }

    // Run
    if (interactive) {
      await runInteractive(agent);
    } else {
      const prompt = promptParts.join(" ");
      if (!prompt) {
        console.error(fmt(c.red, "Error:") + " no prompt provided");
        process.exit(1);
      }

      if (stream) {
        const result = await agent.runStream(prompt, { onToken: (t) => process.stdout.write(t), onToolCallStart });
        if (!agent.getLastResponse(result).endsWith("\n")) console.log();
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
