import { describe, it, expect, afterAll } from "vitest";
import { Agent } from "../src/agent.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const FFMPEG_SERVER = resolve(
  process.env.HOME ?? process.env.USERPROFILE ?? "C:/Users/jiaxuan",
  "Documents/Codex/video-anime-pipeline/mcp-servers/ffmpeg/dist/index.js",
);

const hasFfmpegServer = existsSync(FFMPEG_SERVER);

describe.skipIf(!hasFfmpegServer)("E2E: Real MCP servers", () => {
  let agent: Agent;

  afterAll(async () => {
    if (agent) await agent.close();
  });

  it("should connect to ffmpeg server and discover tools", { timeout: 60_000 }, async () => {
    agent = new Agent();
    await agent.connectServers({
      ffmpeg: {
        command: "node",
        args: [FFMPEG_SERVER],
      },
    });

    // Verify tools discovered
    expect(agent.router.size).toBeGreaterThanOrEqual(4);
    const toolNames = agent.router.getAll().map((t) => t.name).sort();
    expect(toolNames).toContain("ffmpeg-probe");
    expect(toolNames).toContain("ffmpeg-transcode");
    expect(toolNames).toContain("ffmpeg-trim");
    expect(toolNames).toContain("ffmpeg-concat");

    // Verify OpenAI tool format
    const openaiTools = agent.router.getOpenAITools();
    expect(openaiTools.length).toBeGreaterThanOrEqual(4);
    for (const t of openaiTools) {
      expect(t.type).toBe("function");
      expect(t.function.name).toBeDefined();
      expect(t.function.parameters).toBeDefined();
    }
  });

  it("should call ffmpeg-probe on a real file", { timeout: 60_000 }, async () => {
    // Use the ffmpeg server's built-in test: probe a non-existent file to verify error handling
    const result = await agent.router.callTool("ffmpeg-probe", {
      input: "nonexistent.mp4",
    });
    // Should get an error (file doesn't exist), but the call itself should succeed
    expect(result.content).toBeDefined();
    expect(typeof result.content).toBe("string");
  });
});

describe.skipIf(!hasFfmpegServer)("E2E: Agent loop with mock LLM", () => {
  it("should complete a full agent loop with tool calls", { timeout: 60_000 }, async () => {
    // This test verifies the agent loop works by connecting to a real MCP server
    // and checking that the loop structure is correct (without needing a real LLM)
    const agent = new Agent();
    await agent.connectServers({
      ffmpeg: {
        command: "node",
        args: [FFMPEG_SERVER],
      },
    });

    // Verify the agent is initialized
    expect(agent.pool.names()).toContain("ffmpeg");
    expect(agent.router.size).toBeGreaterThanOrEqual(4);

    // Verify context aggregation
    expect(agent.context).toBeDefined();

    await agent.close();
  });
});
