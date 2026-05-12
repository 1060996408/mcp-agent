#!/usr/bin/env node

import { createInterface } from "node:readline";
import { Agent } from "./agent.js";
import { logger } from "./logger.js";

const DEFAULT_CONFIG = process.env.MCP_AGENT_CONFIG ?? "~/.config/shared/mcp-servers.json";

function printHelp(): void {
  console.log(`
mcp-agent — Lightweight MCP-native agent framework

Usage:
  mcp-agent <prompt>                          Run with default config
  mcp-agent --config <path> <prompt>          Run with custom config
  mcp-agent --stream <prompt>                 Run with streaming output
  mcp-agent --interactive                     Interactive multi-turn mode
  mcp-agent --verbose <prompt>                Run with debug logging

Options:
  --config, -c <path>    Path to MCP server config JSON
  --stream, -s           Enable streaming token output
  --interactive, -i      Interactive multi-turn conversation mode
  --verbose, -v          Enable debug logging
  --help, -h             Show this help

Examples:
  mcp-agent "帮我查看 video.mp4 的分辨率"
  mcp-agent --stream "分析这个文件"
  mcp-agent --interactive

Environment:
  MCP_AGENT_CONFIG    Default config path (default: ~/.config/shared/mcp-servers.json)
  MCP_AGENT_MODEL     LLM model name
  MCP_AGENT_BASE_URL  LLM API base URL
`);
}

async function runInteractive(agent: Agent): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("mcp-agent interactive mode (type 'exit' or 'quit' to end, 'reset' to clear history)\n");

  const prompt = (): Promise<string> =>
    new Promise((resolve) => rl.question("You: ", resolve));

  while (true) {
    const input = await prompt();
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit") break;
    if (trimmed === "reset") {
      agent.reset();
      console.log("[History cleared]\n");
      continue;
    }

    try {
      const result = await agent.runStream(trimmed, {
        onToken: (token) => process.stdout.write(token),
      });

      // Ensure newline after streaming output
      const lastMsg = agent.getLastResponse(result);
      if (lastMsg && !lastMsg.endsWith("\n")) {
        console.log();
      }
      console.log();
    } catch (e) {
      console.error("Error:", e instanceof Error ? e.message : e);
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
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--stream" || arg === "-s") {
      stream = true;
    } else if (arg === "--interactive" || arg === "-i") {
      interactive = true;
    } else if (!arg.startsWith("-")) {
      promptParts.push(arg);
    }
  }

  if (verbose) logger.setLevel("debug");

  const agent = new Agent({
    baseUrl: process.env.MCP_AGENT_BASE_URL ?? "http://127.0.0.1:15721/v1",
    model: process.env.MCP_AGENT_MODEL ?? "gpt-5.4",
  });

  try {
    await agent.loadConfig(configPath);

    if (interactive) {
      await runInteractive(agent);
    } else {
      const prompt = promptParts.join(" ");
      if (!prompt) {
        console.error("Error: no prompt provided");
        process.exit(1);
      }

      if (stream) {
        const result = await agent.runStream(prompt, {
          onToken: (token) => process.stdout.write(token),
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
    console.error("Error:", e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await agent.close();
  }
}

main();
