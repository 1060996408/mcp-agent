import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Agent } from "../src/agent.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");
const SESSION_PATH = resolve(tmpdir(), "mcp-agent-e2e", "session.json");

/** Create a mock LLM that supports both regular and SSE streaming responses */
function createSmartMockLLM(): { server: Server; port: number; url: string } {
  let callCount = 0;

  const server = createServer((req, res) => {
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      callCount++;
      const parsed = JSON.parse(body);
      const messages = parsed.messages as Array<{ role: string; content: string }>;
      const last = messages[messages.length - 1];
      const isStream = parsed.stream === true;

      // Determine response content
      let responseContent: string;
      let toolCall: object | null = null;

      if (last.role === "tool") {
        responseContent = `Tool result received: ${last.content}`;
      } else if (last.content?.includes("remember")) {
        responseContent = `I will remember that. You said: ${last.content}`;
      } else {
        responseContent = "";
        toolCall = {
          id: `call_${callCount}`,
          type: "function",
          function: { name: "echo", arguments: JSON.stringify({ text: last.content }) },
        };
      }

      if (isStream) {
        // SSE streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (toolCall) {
          // Stream tool call in chunks
          const tc = toolCall as { id: string; function: { name: string; arguments: string } };
          const fnName = tc.function.name;
          const fnArgs = tc.function.arguments;
          // First chunk: role + tool call with full name + partial args
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "", tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: fnName, arguments: fnArgs.slice(0, 10) } }] } }] })}\n\n`);
          // Second chunk: remaining args only (no name field)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fnArgs.slice(10) } }] } }] })}\n\n`);
        } else {
          // Stream text content in chunks
          const words = responseContent.split(" ");
          for (const word of words) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word + " " } }] })}\n\n`);
          }
        }

        // Final chunk with usage
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        // Regular JSON response
        const response: Record<string, unknown> = {
          choices: [{ message: { content: responseContent, ...(toolCall ? { tool_calls: [toolCall] } : {}) } }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function newAgent(llmUrl: string) {
  return new Agent({ baseUrl: llmUrl, apiKey: "test", model: "mock" });
}

async function connectMock(agent: Agent) {
  await agent.connectServers({
    mock: { command: "npx", args: ["tsx", MOCK_SERVER] },
  });
}

describe("E2E: Full integration test", { timeout: 60_000 }, () => {
  let llmServer: Server;
  let llmUrl: string;

  beforeAll(async () => {
    const dir = resolve(tmpdir(), "mcp-agent-e2e");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const mock = await createSmartMockLLM();
    llmServer = mock.server;
    llmUrl = mock.url;
  });

  afterAll(() => {
    llmServer.close();
    if (existsSync(SESSION_PATH)) unlinkSync(SESSION_PATH);
  });

  it("should run full agent loop with tool call and result", async () => {
    const agent = newAgent(llmUrl);
    await connectMock(agent);

    const result = await agent.run("hello world");

    expect(result.messages.length).toBeGreaterThanOrEqual(4);
    expect(result.toolCallsExecuted).toBe(1);
    expect(agent.getLastResponse(result)).toContain("Echo: hello world");

    await agent.close();
  });

  it("should persist memory across save/load cycles", async () => {
    // Session 1: add memory and save
    const agent1 = newAgent(llmUrl);
    await connectMock(agent1);

    await agent1.run("remember this fact");
    agent1.memory.addMemory("User likes TypeScript", ["preference"]);
    agent1.memory.addMemory("Project uses Vitest", ["tooling"]);
    agent1.save(SESSION_PATH);

    expect(existsSync(SESSION_PATH)).toBe(true);
    await agent1.close();

    // Session 2: load and verify memories persist
    const agent2 = newAgent(llmUrl);
    await connectMock(agent2);
    agent2.load(SESSION_PATH);

    expect(agent2.memory.getMemories()).toHaveLength(2);
    expect(agent2.memory.getMemories()[0].summary).toBe("User likes TypeScript");
    expect(agent2.getHistory().length).toBeGreaterThan(0);

    const formatted = agent2.memory.formatMemories();
    expect(formatted).toContain("User likes TypeScript");
    expect(formatted).toContain("Vitest");

    agent2.memory.addMemory("Session 2 fact", ["s2"]);
    agent2.save(SESSION_PATH);
    await agent2.close();

    // Session 3: verify cumulative memories
    const agent3 = newAgent(llmUrl);
    await connectMock(agent3);
    agent3.load(SESSION_PATH);
    expect(agent3.memory.getMemories()).toHaveLength(3);
    await agent3.close();
  });

  it("should stream tokens and tool calls", async () => {
    const agent = newAgent(llmUrl);
    await connectMock(agent);

    const tokens: string[] = [];
    const toolCalls: Array<{ name: string; args: unknown }> = [];

    const result = await agent.runStream("stream test", {
      onToken: (token) => tokens.push(token),
      onToolCall: (tc) => toolCalls.push({ name: tc.name, args: tc.arguments }),
    });

    // Should have completed with tool call
    expect(result.toolCallsExecuted).toBe(1);
    expect(agent.getLastResponse(result)).toContain("stream test");

    await agent.close();
  });

  it("should handle multi-turn conversation with history injection", async () => {
    const agent = newAgent(llmUrl);
    await connectMock(agent);

    // Turn 1
    await agent.run("first question");
    const h1 = agent.getHistory().length;
    expect(h1).toBeGreaterThanOrEqual(2);

    // Turn 2 — history grows
    await agent.run("follow up");
    const h2 = agent.getHistory().length;
    expect(h2).toBeGreaterThanOrEqual(h1 + 2);

    // Turn 3
    await agent.run("third message");
    const h3 = agent.getHistory().length;
    expect(h3).toBeGreaterThanOrEqual(h2 + 2);

    // Verify content ordering
    const history = agent.getHistory();
    const userMsgs = history.filter((m) => m.role === "user");
    expect(userMsgs[0].content).toBe("first question");
    expect(userMsgs[1].content).toBe("follow up");
    expect(userMsgs[2].content).toBe("third message");

    await agent.close();
  });

  it("should truncate history when exceeding maxHistory", async () => {
    const agent = newAgent(llmUrl);
    agent.setMaxHistory(6);
    await connectMock(agent);

    // Run 5 turns
    for (let i = 0; i < 5; i++) {
      await agent.run(`message ${i}`);
    }

    // Safe truncation preserves turn integrity, so may keep slightly more than maxHistory
    const history = agent.getHistory();
    expect(history.length).toBeLessThanOrEqual(9); // maxHistory + one extra turn

    // Most recent user message should be preserved
    const lastUserMsg = history.findLast((m) => m.role === "user");
    expect(lastUserMsg?.content).toBe("message 4");

    await agent.close();
  });
});
