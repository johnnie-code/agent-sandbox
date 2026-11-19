/**
 * The tool surface an agent sees.
 *
 * Every tool answers with plain text, names what it did, and never claims a step succeeded that it did
 * not run. Failures come back as an error result with the reason, so a model can correct itself instead
 * of guessing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SandboxError, safeJoin } from './paths.js';
import { runCommand, type SandboxMode } from './exec.js';
import { WorkspaceRegistry } from './workspaces.js';

export interface ToolContext {
  registry: WorkspaceRegistry;
  mode: SandboxMode;
  image: string;
  network: string;
  timeoutMs: number;
  githubToken?: string;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (error: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
});

export function registerTools(server: McpServer, context: ToolContext): void {
  const { registry } = context;

  server.tool(
    'sandbox_create',
    'Create a disposable workspace. Optionally clone any public GitHub repo into it at depth 1.',
    { repo: z.string().optional(), ref: z.string().optional(), name: z.string().optional() },
    async (args) => {
      try {
        const workspace = await registry.create(args);
        return ok(
          `workspace ${workspace.id}\npath ${workspace.dir}\nsource ${workspace.source ?? 'empty directory'}\n` +
            `mode ${context.mode}${context.mode === 'docker' ? `, image ${context.image}, network ${context.network}` : ''}`,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool('sandbox_list', 'List the workspaces that exist right now.', {}, async () => {
    const rows = registry.list();
    if (rows.length === 0) return ok('no workspaces yet. Call sandbox_create first.');
    return ok(rows.map((row) => `${row.id}  ${row.source ?? 'empty'}  ${row.createdAt}`).join('\n'));
  });

  server.tool(
    'sandbox_destroy',
    'Delete a workspace and everything in it. This cannot be undone.',
    { id: z.string() },
    async ({ id }) => {
      try {
        await registry.destroy(id);
        return ok(`workspace ${id} deleted`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    'sandbox_exec',
    'Run one command in a workspace. Pass an argv array, never a shell string, for example ["npm", "test"].',
    {
      id: z.string(),
      argv: z.array(z.string()).min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1000).max(900000).optional(),
    },
    async ({ id, argv, cwd, timeoutMs }) => {
      try {
        const workspace = registry.get(id);
        const dir = cwd ? safeJoin(workspace.dir, cwd) : workspace.dir;
        const result = await runCommand({
          dir,
          argv,
          mode: context.mode,
          image: context.image,
          network: context.network,
          timeoutMs: timeoutMs ?? context.timeoutMs,
        });
        const parts = [
          `$ ${result.command}`,
          `exit ${result.exitCode ?? 'killed'}${result.timedOut ? ' (timed out)' : ''}`,
        ];
        if (result.stdout.trim()) parts.push(`stdout\n${result.stdout.trimEnd()}`);
        if (result.stderr.trim()) parts.push(`stderr\n${result.stderr.trimEnd()}`);
        if (result.truncated) parts.push('output was truncated');
        return ok(parts.join('\n\n'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    'sandbox_read_file',
    'Read a text file from a workspace.',
    { id: z.string(), path: z.string(), maxBytes: z.number().int().min(1).max(200000).optional() },
    async ({ id, path: relative, maxBytes }) => {
      try {
        const workspace = registry.get(id);
        const full = safeJoin(workspace.dir, relative);
        const content = await readFile(full, 'utf8');
        const limit = maxBytes ?? 100000;
        return ok(content.length > limit ? `${content.slice(0, limit)}\n\n[... file continues, ${content.length} characters total ...]` : content);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    'sandbox_write_file',
    'Write a text file into a workspace, creating its directories.',
    { id: z.string(), path: z.string(), content: z.string() },
    async ({ id, path: relative, content }) => {
      try {
        const workspace = registry.get(id);
        const full = safeJoin(workspace.dir, relative);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, content, 'utf8');
        return ok(`wrote ${content.length} characters to ${relative}`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    'sandbox_list_files',
    'List files in a workspace. Directories end with a slash. .git and node_modules are skipped.',
    { id: z.string(), path: z.string().optional(), depth: z.number().int().min(1).max(4).optional() },
    async ({ id, path: relative, depth }) => {
      try {
        const rows = await registry.listFiles(id, relative ?? '.', depth ?? 2);
        return ok(rows.length === 0 ? 'that directory is empty' : rows.join('\n'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    'sandbox_diff',
    'Show what changed in a workspace since it was cloned or created.',
    { id: z.string() },
    async ({ id }) => {
      try {
        const workspace = registry.get(id);
        const status = await runCommand({
          dir: workspace.dir,
          argv: ['git', 'status', '--porcelain'],
          mode: context.mode,
          image: context.image,
          network: context.network,
          timeoutMs: context.timeoutMs,
        });
        const diff = await runCommand({
          dir: workspace.dir,
          argv: ['git', 'diff'],
          mode: context.mode,
          image: context.image,
          network: context.network,
          timeoutMs: context.timeoutMs,
        });
        const body = `${status.stdout.trim() || 'nothing changed'}\n\n${diff.stdout.trim()}`.trim();
        return ok(body);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    'sandbox_commit',
    'Stage everything in a workspace and commit it on a branch.',
    { id: z.string(), message: z.string().min(1), branch: z.string().optional(), author: z.string().optional() },
    async ({ id, message, branch, author }) => {
      try {
        const workspace = registry.get(id);
        const name = author ?? 'agent-sandbox';
        const base = { dir: workspace.dir, mode: context.mode, image: context.image, network: context.network, timeoutMs: context.timeoutMs };
        if (branch) {
          if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(branch)) throw new SandboxError('that branch name is not allowed');
          await runCommand({ ...base, argv: ['git', 'checkout', '-B', branch] });
        }
        await runCommand({ ...base, argv: ['git', 'config', 'user.email', `${name}@users.noreply.github.com`] });
        await runCommand({ ...base, argv: ['git', 'config', 'user.name', name] });
        await runCommand({ ...base, argv: ['git', 'add', '-A'] });
        const commit = await runCommand({ ...base, argv: ['git', 'commit', '-m', message] });
        if (commit.exitCode !== 0) throw new SandboxError(`commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
        return ok(commit.stdout.trim() || 'committed');
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    'sandbox_push',
    'Push a workspace branch to a repository the GITHUB_TOKEN can write to.',
    { id: z.string(), repo: z.string(), branch: z.string() },
    async ({ id, repo, branch }) => {
      try {
        if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(branch)) throw new SandboxError('that branch name is not allowed');
        const workspace = registry.get(id);
        const problem = await pushWorkspace(context, workspace.dir, repo, branch);
        if (problem) throw new SandboxError(problem);
        return ok(`pushed ${branch} to ${repo}`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    'sandbox_open_pr',
    'Open a pull request from a workspace branch.',
    { id: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), base: z.string().optional(), branch: z.string() },
    async ({ id, repo, title, body, base, branch }) => {
      try {
        if (!context.githubToken) throw new SandboxError('set GITHUB_TOKEN in the server environment to open a pull request');
        const workspace = registry.get(id);
        const pushed = await pushWorkspace(context, workspace.dir, repo, branch);
        if (pushed) return fail(new SandboxError(pushed));
        const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${context.githubToken}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, body: body ?? '', head: branch, base: base ?? 'main' }),
        });
        const payload = (await response.json()) as { html_url?: string; message?: string };
        if (!response.ok) throw new SandboxError(`GitHub refused the pull request: ${payload.message ?? response.status}`);
        return ok(`pull request opened: ${payload.html_url}`);
      } catch (error) {
        return fail(error);
      }
    },
  );
}

/** Pushes with a token that is passed through the environment, never written into the remote URL on disk. */
async function pushWorkspace(context: ToolContext, dir: string, repo: string, branch: string): Promise<string | null> {
  if (!context.githubToken) return 'set GITHUB_TOKEN in the server environment to push';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return 'name the repository as owner/name';
  const result = await runCommand({
    dir,
    argv: ['git', 'push', `https://x-access-token:${context.githubToken}@github.com/${repo}.git`, `${branch}:${branch}`, '--force'],
    mode: context.mode,
    image: context.image,
    network: context.network,
    timeoutMs: context.timeoutMs,
  });
  return result.exitCode === 0 ? null : result.stderr.trim() || 'push failed';
}
