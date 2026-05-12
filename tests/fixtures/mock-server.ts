#!/usr/bin/env node

/**
 * A minimal MCP server for testing.
 * Exposes 2 tools: echo (returns input) and add (adds two numbers).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "mock-server",
  version: "0.1.0",
});

server.tool("echo", "Echo back the input text", {
  text: z.string().describe("Text to echo"),
}, async ({ text }) => ({
  content: [{ type: "text", text: `Echo: ${text}` }],
}));

server.tool("add", "Add two numbers", {
  a: z.number().describe("First number"),
  b: z.number().describe("Second number"),
}, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Mock server error:", err);
  process.exit(1);
});
