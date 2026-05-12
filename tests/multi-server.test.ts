import { describe, it, expect, afterAll } from "vitest";
import { Agent } from "../src/agent.js";
import { MCPPool } from "../src/pool.js";
import { ToolRouter } from "../src/router.js";
import { resolve } from "node:path";

const __dirname = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-server.ts");
const FFMPEG_SERVER = resolve(
  process.env.HOME ?? process.env.USERPROFILE ?? "C:/Users/jiaxuan",
  "Documents/Codex/video-anime-pipeline/mcp-servers/ffmpeg/dist/index.js",
);

describe("Multi-server routing", () => {
  let pool: MCPPool;
  let router: ToolRouter;

  afterAll(async () => {
    if (pool) await pool.close();
  });

  it("should connect to 2 servers and route tools correctly", { timeout: 60_000 }, async () => {
    pool = new MCPPool();
    await pool.connectAll({
      mock: { command: "npx", args: ["tsx", MOCK_SERVER] },
      ffmpeg: { command: "node", args: [FFMPEG_SERVER] },
    });

    expect(pool.names().sort()).toEqual(["ffmpeg", "mock"]);

    router = new ToolRouter();
    await router.buildIndex(pool.getAll());

    // Should have tools from both servers
    expect(router.size).toBe(6); // 2 mock + 4 ffmpeg

    // Mock tools should route to mock server
    const echoResolved = router.resolve("echo");
    expect(echoResolved!.server.name).toBe("mock");

    // FFmpeg tools should route to ffmpeg server
    const probeResolved = router.resolve("ffmpeg-probe");
    expect(probeResolved!.server.name).toBe("ffmpeg");

    // Cross-server: call mock tool
    const mockResult = await router.callTool("echo", { text: "cross-server" });
    expect(mockResult.content).toContain("Echo: cross-server");

    // Cross-server: call ffmpeg tool
    const ffmpegResult = await router.callTool("ffmpeg-probe", { input: "test.mp4" });
    expect(ffmpegResult.content).toBeDefined();
  });

  it("should generate unified OpenAI tools from multiple servers", { timeout: 60_000 }, async () => {
    const tools = router.getOpenAITools();
    expect(tools.length).toBe(6);

    const names = tools.map((t) => t.function.name).sort();
    expect(names).toEqual(["add", "echo", "ffmpeg-concat", "ffmpeg-probe", "ffmpeg-transcode", "ffmpeg-trim"]);
  });
});
