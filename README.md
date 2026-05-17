# mcp-agent

Lightweight MCP-native agent framework. Connect multiple MCP servers, aggregate tools/resources/prompts, and run LLM-powered agent loops with multi-turn conversation, streaming, middleware, events, validation, and session persistence.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                         Agent                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌─────────┐ │
│  │ MCPPool  │ │ToolRouter│ │ AgentLoop    │ │ Memory  │ │
│  │ connect  │ │ route    │ │ LLM ↔ tools  │ │ session │ │
│  └────┬─────┘ └────┬─────┘ └──────┬───────┘ └─────────┘ │
│       │             │              │                     │
│  ┌────▼─────────────▼──────────────▼───────────────────┐ │
│  │              MCP Servers + Local Tools               │ │
│  │        [ffmpeg] [filesystem] [github] [custom]       │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

```ts
import { Agent } from "mcp-agent";

const agent = new Agent({
  baseUrl: "http://127.0.0.1:15721/v1",
  model: "gpt-5.4",
});

await agent.connectServers({
  ffmpeg: { command: "node", args: ["./mcp-servers/ffmpeg/dist/index.js"] },
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  },
});

const result = await agent.run("probe video.mp4");
console.log(agent.getLastResponse(result));

await agent.close();
```

## LLM Providers

`Agent` accepts either a config object for the built-in OpenAI-compatible provider or a custom `LLMProvider` implementation.

```ts
import { Agent, OpenAIProvider, type LLMProvider } from "mcp-agent";

const provider = new OpenAIProvider({
  baseUrl: "http://127.0.0.1:15721/v1",
  model: "gpt-5.4",
  apiKey: process.env.MCP_AGENT_API_KEY,
});

const agent = new Agent(provider);
```

`LLMClient` remains exported as a backward-compatible alias for `OpenAIProvider`.

## Middleware

Middleware hooks can wrap LLM calls and tool calls. Built-ins include logging, retry, circuit breaker, budget limits, and output sanitization.

```ts
import { Agent, LoggingMiddleware, RetryMiddleware, BudgetMeter, OutputSanitizer } from "mcp-agent";

const agent = new Agent();
agent
  .use(new LoggingMiddleware())
  .use(new RetryMiddleware({ maxRetries: 2 }))
  .use(new BudgetMeter({ maxToolCalls: 20, wallClockMs: 120_000 }))
  .use(new OutputSanitizer({ maxOutputLength: 10_000 }));
```

## Events

`agent.events` exposes typed lifecycle events for UI, logging, and test assertions.

```ts
agent.events.on("beforeToolCall", ({ toolCall }) => {
  console.error(`calling ${toolCall.name}`);
});

agent.events.on("afterToolCall", ({ toolCall, elapsedMs, isError }) => {
  console.error(`${toolCall.name}: ${isError ? "error" : "ok"} in ${elapsedMs}ms`);
});
```

Available events include `runStart`, `beforeLLM`, `afterLLM`, `beforeToolCall`, `afterToolCall`, `error`, `runEnd`, and `historyTruncated`.

## Validation

Config validation is powered by Zod and is available directly when you need to check config before connecting.

```ts
import { validateConfig, validateServerConfig } from "mcp-agent";

const config = validateConfig({
  servers: {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
  },
});

validateServerConfig("remote", {
  transport: "streamable-http",
  url: "http://localhost:3000/mcp",
});
```

## Multi-turn and Sessions

```ts
const agent = new Agent();
await agent.connectServers({ /* servers */ });

await agent.run("What tools do you have?");
await agent.run("Use the filesystem tool on package.json");

const history = agent.getHistory();
agent.reset();

agent.enableSession("./session.json");
await agent.run("remember this conversation");
await agent.close();
```

`enableSession(path)` loads history from the session file and `close()` saves it back.

## Streaming

```ts
await agent.runStream("analyze this file", {
  onToken: (token) => process.stdout.write(token),
  onToolCallStart: (tool) => console.error(`\nstarting ${tool.name}`),
  onToolCall: (tool) => console.error(`\ncalled ${tool.name}`),
});
```

## CLI

```bash
# Single shot
mcp-agent "probe video.mp4"

# Streaming output
mcp-agent --stream "analyze this file"

# Interactive multi-turn mode
mcp-agent --interactive

# Persist interactive history and memory
mcp-agent --session ~/.agent/session.json --interactive

# Custom config and selected servers
mcp-agent --config ./my-servers.json --servers filesystem,github "list repo PRs"

# Health check connected servers
mcp-agent --health

# Debug logging
mcp-agent --verbose "test"
```

## Configuration

Use either a flat MCP server map or `{ "servers": { ... } }`.

```json
{
  "servers": {
    "ffmpeg": {
      "command": "node",
      "args": ["./mcp-servers/ffmpeg/dist/index.js"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "remote": {
      "transport": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Core Exports

| Export | Description |
|--------|-------------|
| `Agent` | Main entry point for config loading, server connections, sessions, streaming, middleware, and events |
| `MCPPool` | Manages multiple MCP server connections and health checks |
| `ToolRouter` | Discovers tools across servers and routes calls to the right server |
| `AgentLoop` | Executes LLM/tool rounds with cancellation and max-round control |
| `OpenAIProvider` / `LLMProvider` | Built-in OpenAI-compatible provider and provider interface |
| `MemoryManager` | Persists conversation history and memories |
| `AgentEventEmitter` | Typed agent lifecycle events |
| `validateConfig` / `validateServerConfig` | Zod-based config validation |
| `LoggingMiddleware`, `RetryMiddleware`, `CircuitBreakerMiddleware`, `BudgetMeter`, `OutputSanitizer` | Built-in middleware |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_AGENT_CONFIG` | `~/.config/shared/mcp-servers.json` | Default config path |
| `MCP_AGENT_MODEL` | `gpt-5.4` | LLM model name |
| `MCP_AGENT_BASE_URL` | `http://127.0.0.1:15721/v1` | LLM API base URL |
| `NO_COLOR` | unset | Disable CLI colors when set |

## Requirements

- Node.js >= 20
- Any OpenAI-compatible LLM API, local or remote

## License

MIT
