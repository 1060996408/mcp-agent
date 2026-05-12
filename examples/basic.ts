/**
 * Basic example: connect to MCP servers and run a single query.
 *
 * Usage:
 *   npx tsx examples/basic.ts
 */

import { Agent } from "../src/index.js";

const CONFIG_PATH = process.env.MCP_AGENT_CONFIG ?? "~/.config/shared/mcp-servers.json";

async function main(): Promise<void> {
  const agent = new Agent();

  try {
    await agent.loadConfig(CONFIG_PATH);

    console.log(`Connected servers: ${agent.pool.names().join(", ")}`);
    console.log(`Available tools: ${agent.router.size}`);

    const result = await agent.run("List the available tools and briefly describe what each one does.");
    console.log("\n--- Response ---\n");
    console.log(agent.getLastResponse(result));
    console.log(`\n(${result.toolCallsExecuted} tool calls made)`);
  } finally {
    await agent.close();
  }
}

main().catch(console.error);
