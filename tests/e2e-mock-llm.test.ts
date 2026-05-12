import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Agent } from "../src/agent.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");

/**
 * Mock OpenAI API server for E2E testing.
 * Responds to chat/completions with deterministic tool calls and responses.
 */
function createMockLLMServer(): { server: Server; port: number; url: string } {
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
      const lastMessage = parsed.messages[parsed.messages.length - 1];

      if (callCount === 1) {
        // First call: return a tool call
        const response = {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_e2e_001",
                    type: "function",
                    function: {
                      name: "echo",
                      arguments: JSON.stringify({ text: "e2e test" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } else {
        // Second call: final response (after tool result)
        const response = {
          choices: [
            {
              message: {
                content: `I called the echo tool and got: "Echo: e2e test". The user said: "${lastMessage.content}"`,
              },
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 30 },
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

describe("E2E: Full agent loop with mock LLM HTTP server", { timeout: 60_000 }, () => {
  let agent: Agent;
  let llmServer: Server;
  let llmUrl: string;

  beforeAll(async () => {
    const mock = await createMockLLMServer();
    llmServer = mock.server;
    llmUrl = mock.url;

    agent = new Agent({
      baseUrl: llmUrl,
      apiKey: "test-key",
      model: "mock-model",
    });

    await agent.connectServers({
      mock: { command: "npx", args: ["tsx", MOCK_SERVER] },
    });
  }, 30_000);

  afterAll(async () => {
    await agent.close();
    llmServer.close();
  });

  it("should complete full agent loop: user → LLM → tool → result → final", async () => {
    const result = await agent.run("test e2e message");

    // Should have: system + user + assistant(tool_call) + tool(result) + assistant(final)
    expect(result.messages).toHaveLength(5);

    // Verify message roles
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("test e2e message");
    expect(result.messages[2].role).toBe("assistant");
    expect(result.messages[2].tool_calls).toHaveLength(1);
    expect(result.messages[2].tool_calls![0].name).toBe("echo");
    expect(result.messages[3].role).toBe("tool");
    expect(result.messages[3].content).toContain("Echo: e2e test");
    expect(result.messages[4].role).toBe("assistant");
    expect(result.messages[4].content).toContain("Echo: e2e test");

    // Verify stats
    expect(result.toolCallsExecuted).toBe(1);
    expect(result.tokensUsed).toBe(180); // 50+20 + 80+30

    // Verify getLastResponse
    expect(agent.getLastResponse(result)).toContain("Echo: e2e test");
  });

  it("should maintain history across multiple runs", async () => {
    // Reset for clean test
    agent.reset();

    // First turn
    await agent.run("first message");
    expect(agent.getHistory()).toHaveLength(2); // user + assistant

    // Second turn
    await agent.run("second message");
    expect(agent.getHistory()).toHaveLength(4); // user + assistant + user + assistant

    // History should contain both conversations
    const history = agent.getHistory();
    expect(history[0].content).toBe("first message");
    expect(history[2].content).toBe("second message");
  });

  it("should support reset between conversations", async () => {
    await agent.run("before reset");
    expect(agent.getHistory().length).toBeGreaterThan(0);

    agent.reset();
    expect(agent.getHistory()).toHaveLength(0);
  });
});
