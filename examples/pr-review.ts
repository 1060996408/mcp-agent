/**
 * PR Review Agent: automatically review a GitHub pull request.
 *
 * Usage:
 *   npx tsx examples/pr-review.ts <owner/repo> <pr-number>
 *   npx tsx examples/pr-review.ts 1060996408/mcp-agent 1
 *   npx tsx examples/pr-review.ts --post-comment 1060996408/mcp-agent 1
 *
 * Environment:
 *   GITHUB_PERSONAL_ACCESS_TOKEN — required for API access
 */

import { Agent, LoggingMiddleware, RetryMiddleware } from "../src/index.js";

const CODING_REVIEW_PROMPT = `You are a senior code reviewer. When reviewing a PR:
1. Read the PR description and changed files
2. Check for: bugs, security issues, performance problems, style violations
3. Suggest specific improvements with file paths and line numbers
4. Be constructive — praise good patterns too
5. Keep the review concise and actionable

Format your review as:
## Summary
<1-2 sentence overview>

## Issues
- [severity] description (file:line)

## Suggestions
- improvement suggestion

## Verdict
<approve / request-changes / comment>`;

const CONFIG_PATH = process.env.MCP_AGENT_CONFIG ?? "~/.config/shared/mcp-servers.json";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let postComment = false;
  const filtered: string[] = [];

  for (const arg of args) {
    if (arg === "--post-comment") {
      postComment = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: npx tsx examples/pr-review.ts [options] <owner/repo> <pr-number>

Options:
  --post-comment   Post the review as a PR comment
  --help, -h       Show this help

Examples:
  npx tsx examples/pr-review.ts 1060996408/mcp-agent 1
  npx tsx examples/pr-review.ts --post-comment anthropics/anthropic-sdk-typescript 123
`);
      process.exit(0);
    } else {
      filtered.push(arg);
    }
  }

  if (filtered.length < 2) {
    console.error("Error: provide <owner/repo> and <pr-number>");
    console.error("  e.g.: npx tsx examples/pr-review.ts 1060996408/mcp-agent 1");
    process.exit(1);
  }

  const repo = filtered[0];
  const prNumber = parseInt(filtered[1], 10);

  if (isNaN(prNumber)) {
    console.error(`Error: invalid PR number: ${filtered[1]}`);
    process.exit(1);
  }

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    console.error(`Error: invalid repo format, expected owner/repo, got: ${repo}`);
    process.exit(1);
  }

  console.log(`Reviewing PR #${prNumber} on ${owner}/${repoName}...\n`);

  const agent = new Agent({
    baseUrl: process.env.MCP_AGENT_BASE_URL ?? "http://127.0.0.1:15721/v1",
    model: process.env.MCP_AGENT_MODEL ?? "gpt-5.4",
  });

  // Wire up middleware
  agent.use(new LoggingMiddleware());
  agent.use(new RetryMiddleware({ maxRetries: 2 }));

  // Set review-specific system prompt
  agent.setSystemPrompt(CODING_REVIEW_PROMPT);

  try {
    // Only connect github server (filesystem not needed for review)
    const { readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { resolve } = await import("node:path");

    const expandPath = (p: string) =>
      p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;

    const raw = readFileSync(expandPath(CONFIG_PATH), "utf-8");
    const config = JSON.parse(raw);
    const servers = config.servers ?? config;

    // Only connect github
    if (!servers.github) {
      console.error("Error: 'github' server not found in config");
      process.exit(1);
    }

    await agent.connectServers({ github: servers.github });
    console.log(`Connected: ${agent.pool.names().join(", ")} (${agent.router.size} tools)\n`);

    // Step 1: Get PR info
    console.log("Fetching PR details...");
    const prResult = await agent.run(
      `Get the details of PR #${prNumber} on ${owner}/${repoName}. ` +
      `Then get the diff/files changed. Provide a thorough code review.`
    );

    console.log("\n" + "=".repeat(60));
    console.log("CODE REVIEW");
    console.log("=".repeat(60) + "\n");
    console.log(agent.getLastResponse(prResult));

    // Step 2: Optionally post comment
    if (postComment) {
      console.log("\nPosting review as PR comment...");
      const reviewText = agent.getLastResponse(prResult);
      const commentResult = await agent.run(
        `Post the following review as a comment on PR #${prNumber} on ${owner}/${repoName}:\n\n${reviewText}`
      );
      console.log(agent.getLastResponse(commentResult));
    }

    console.log(`\n(${prResult.toolCallsExecuted} tool calls, ${prResult.rounds} rounds)`);
  } catch (e) {
    console.error("Error:", e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await agent.close();
  }
}

main().catch(console.error);
