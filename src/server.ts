#!/usr/bin/env node
/**
 * agent-sandbox: an MCP server that gives an agent a disposable place to build things.
 *
 * It speaks MCP over stdio, so any client that supports MCP servers can connect: Claude Desktop,
 * Cursor, Windsurf, or another agent. Point the client at `node dist/server.js` (or `npx agent-sandbox`).
 *
 * Safety posture, in order of importance:
 * - docker mode is the default. Commands run in a container with a memory cap, a pid cap, one cpu and
 *   no network, and only the workspace directory is mounted.
 * - local mode exists for a machine the operator trusts, and has to be asked for by name.
 * - paths are proved to be inside the workspace before any file is read or written.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WorkspaceRegistry } from './workspaces.js';
import { registerTools } from './tools.js';
import type { SandboxMode } from './exec.js';

const mode = (process.env.SANDBOX_MODE ?? 'docker') as SandboxMode;
if (mode !== 'docker' && mode !== 'local') {
  console.error(`SANDBOX_MODE must be docker or local, not ${mode}`);
  process.exit(1);
}

const registry = new WorkspaceRegistry({
  root: process.env.SANDBOX_ROOT ?? '/tmp/agent-sandbox/workspaces',
  timeoutMs: Number(process.env.SANDBOX_TIMEOUT_MS ?? 120000),
});

const server = new McpServer({ name: 'agent-sandbox', version: '0.1.0' });

registerTools(server, {
  registry,
  mode,
  image: process.env.SANDBOX_IMAGE ?? 'node:22-bookworm',
  network: process.env.SANDBOX_NETWORK ?? 'none',
  timeoutMs: Number(process.env.SANDBOX_TIMEOUT_MS ?? 120000),
  githubToken: process.env.GITHUB_TOKEN,
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`agent-sandbox ready in ${mode} mode, workspaces under ${registry.root}`);
