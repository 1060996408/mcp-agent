# mcp-agent

Lightweight MCP-native agent framework. Connect multiple MCP servers, aggregate their tools, and run LLM-powered agent loops with multi-turn conversation and streaming support.

## Architecture

```
┌─────────────────────────────────────────────┐
│                   Agent                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ MCPPool  │ │ToolRouter│ │ AgentLoop    │ │
│  │ (connect)│ │ (route)  │ │ (LLM ↔ tool) │ │
│  └────┬─────┘ └────┬─────┘ └──────┬───────┘ │
│       │             │              │          │
│  ┌────▼─────────────▼──────────────▼───────┐ │
│  │            MCP Servers                   │ │
│  │  [ffmpeg] [filesystem] [custom] ...      │ │
│  └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Quick Start

```ts
import { Agent } from "mcp-agent";

const agent = new Agent({
  baseUrl: "http://localhost:11434/v1", // any OpenAI-compatible API
  model: "llama3",
});

// Connect to MCP servers
await agent.connectServers({
  ffmpeg: { command: "node", args: ["./mcp-servers/ffmpeg/dist/index.js"] },
  filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
});

// Single shot
const result = await agent.run("probe video.mp4");
console.log(agent.getLastResponse(result));

// Multi-turn conversation
await agent.run("What tools do you have?");
await agent.run("Use ffmpeg-probe on test.mp4");
const history = agent.getHistory(); // full conversation
agent.reset(); // clear for new conversation

// Streaming
await agent.runStream("analyze this", {
  onToken: (token) => process.stdout.write(token),
  onToolCall: (tc) => console.log(`\n[called: ${tc.name}]`),
});

await agent.close();
```

## CLI

```bash
# Single shot
mcp-agent "probe video.mp4"

# Streaming output
mcp-agent --stream "analyze this file"

# Interactive multi-turn mode
mcp-agent --interactive

# Custom config
mcp-agent --config ./my-servers.json "do something"

# Debug logging
mcp-agent --verbose "test"
```

## Core Components

| Component | Description |
|-----------|-------------|
| `Agent` | Main entry point. Multi-turn history, streaming, config loading |
| `MCPPool` | Manages multiple MCP server connections in parallel |
| `ToolRouter` | Discovers tools across servers, routes calls to the right server |
| `AgentLoop` | Core reasoning loop: LLM → tool calls → results → repeat |
| `LLMClient` | OpenAI-compatible HTTP client with streaming support |
| `Context` | Aggregates server instructions into system prompts |

## Configuration

Create a JSON file with your MCP servers:

```json
{
  "ffmpeg": {
    "command": "node",
    "args": ["./mcp-servers/ffmpeg/dist/index.js"]
  },
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }
}
```

Or use the shared config format:

```json
{
  "servers": {
    "ffmpeg": { "command": "node", "args": ["./ffmpeg.js"] }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_AGENT_CONFIG` | `~/.config/shared/mcp-servers.json` | Default config path |
| `MCP_AGENT_MODEL` | `gpt-5.4` | LLM model name |
| `MCP_AGENT_BASE_URL` | `http://127.0.0.1:15721/v1` | LLM API base URL |

## Programmatic API

```ts
import { Agent, MCPPool, ToolRouter, LLMClient } from "mcp-agent";

// Full control
const pool = new MCPPool();
await pool.connectAll({ ... });
const router = new ToolRouter();
await router.buildIndex(pool.getAll());

const llm = new LLMClient({ baseUrl: "...", model: "..." });
const loop = new AgentLoop(llm, router);
const result = await loop.run(messages);
```

## Requirements

- Node.js >= 20
- Any OpenAI-compatible LLM API (local or remote)

## License

MIT
