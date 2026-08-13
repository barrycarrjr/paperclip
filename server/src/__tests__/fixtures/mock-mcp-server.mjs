#!/usr/bin/env node
/**
 * Minimal stdio MCP server used by `external-mcp-integration.test.ts` to
 * exercise the external-MCP connector end-to-end without npm-installing a
 * community server.
 *
 * Deliberately tiny:
 *   - `echo`           — read-class; returns args back as text. Verifies the
 *                        happy path (spawn → connect → tools/list → callTool).
 *   - `create_thing`   — write-class (name prefix triggers the mutation
 *                        heuristic). Verifies the allowMutations gate.
 *   - `read_secret_env`— echoes back `process.env.SECRET_TOKEN`. Verifies
 *                        secret-ref env vars are resolved and injected.
 *
 * Stays in pure JS / .mjs so the test can spawn it with `node <abs-path>`
 * — no build step, no .cmd resolution issues on Windows.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock-mcp-server", version: "0.1.0" });

server.tool(
  "echo",
  "Echo the input string back as text. Read-only.",
  { message: z.string() },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  }),
);

server.tool(
  "create_thing",
  "Create a thing. Write-class — the bare name prefix triggers the mutation heuristic.",
  { name: z.string() },
  async ({ name }) => ({
    content: [{ type: "text", text: `created: ${name}` }],
  }),
);

server.tool(
  "read_secret_env",
  "Returns the value of process.env.SECRET_TOKEN. Used to verify env-var injection.",
  {},
  async () => ({
    content: [
      { type: "text", text: `SECRET_TOKEN=${process.env.SECRET_TOKEN ?? "<unset>"}` },
    ],
  }),
);

// Records one line per process start, so a test can assert how many children
// were actually spawned (the connect pool is supposed to dedupe concurrent
// callers into a single cold start).
if (process.env.MOCK_MCP_SPAWN_LOG) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.MOCK_MCP_SPAWN_LOG, `${process.pid}\n`);
}

// Simulates a gateway that is slow to come up (Docker MCP Gateway cold-starts
// a container per enabled server before it will answer `initialize`). The
// child is alive and healthy the whole time, it just has not finished
// starting, which is exactly the case discovery has to survive.
const startupDelayMs = Number(process.env.MOCK_MCP_STARTUP_DELAY_MS ?? "0");
if (startupDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
}

const transport = new StdioServerTransport();
await server.connect(transport);
