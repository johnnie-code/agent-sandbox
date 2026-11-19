/**
 * Workspaces: a disposable directory an agent can clone into, edit, run and throw away.
 *
 * A workspace lives under SANDBOX_ROOT and is identified by a generated id. Nothing a caller sends is
 * used as a directory name, so a workspace cannot be created on top of another one or outside the root.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SandboxError, isWorkspaceId } from './paths.js';

const run = promisify(execFile);

export interface Workspace {
  id: string;
  dir: string;
  source: string | null;
  createdAt: string;
}

export interface WorkspaceRegistryOptions {
  root: string;
  timeoutMs: number;
}

/** A public repo is named owner/name. A URL is refused so a token can never be embedded in it. */
export function parseRepoSlug(value: string): { owner: string; name: string } {
  const trimmed = String(value ?? '').trim().replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new SandboxError('name a repository as owner/name, for example expressjs/express');
  }
  const [owner, name] = trimmed.split('/') as [string, string];
  return { owner, name };
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly options: WorkspaceRegistryOptions) {}

  get root(): string {
    return this.options.root;
  }

  list(): Workspace[] {
    return [...this.workspaces.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Workspace {
    if (!isWorkspaceId(id)) throw new SandboxError('that is not a workspace id');
    const found = this.workspaces.get(id);
    if (!found) throw new SandboxError(`no workspace called ${id}. Create one first, or list them.`);
    return found;
  }

  /** Clones a public repo at depth 1, or makes an empty directory when no repo is named. */
  async create(input: { repo?: string; ref?: string; name?: string }): Promise<Workspace> {
    const label = (input.name ?? input.repo ?? 'workspace')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'workspace';
    const id = `${label}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(this.options.root, id);
    await mkdir(dir, { recursive: true });

    if (input.repo) {
      const { owner, name } = parseRepoSlug(input.repo);
      const url = `https://github.com/${owner}/${name}.git`;
      const args = ['clone', '--depth', '1'];
      if (input.ref) {
        if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(input.ref)) throw new SandboxError('that ref name is not allowed');
        args.push('--branch', input.ref);
      }
      args.push(url, '.');
      try {
        await run('git', args, { cwd: dir, timeout: this.options.timeoutMs });
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        const detail = (error as { stderr?: string }).stderr?.slice(0, 400) ?? (error as Error).message;
        throw new SandboxError(`could not clone ${owner}/${name}: ${detail.trim()}`);
      }
    }

    const workspace: Workspace = {
      id,
      dir,
      source: input.repo ? `${parseRepoSlug(input.repo).owner}/${parseRepoSlug(input.repo).name}` : null,
      createdAt: new Date().toISOString(),
    };
    this.workspaces.set(id, workspace);
    return workspace;
  }

  async destroy(id: string): Promise<void> {
    const workspace = this.get(id);
    await rm(workspace.dir, { recursive: true, force: true });
    this.workspaces.delete(id);
  }

  /** Shallow listing used by the file tools. Directories first, then files, both alphabetical. */
  async listFiles(id: string, relative: string, depth: number): Promise<string[]> {
    const workspace = this.get(id);
    const base = path.resolve(workspace.dir);
    const target = path.resolve(base, relative || '.');
    if (!target.startsWith(base)) throw new SandboxError('path escapes the workspace');

    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    const rows: string[] = [];
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const childPath = path.posix.join(relative || '.', entry.name);
      if (entry.isDirectory()) {
        rows.push(`${childPath}/`);
        if (depth > 1) {
          const deeper = await this.listFiles(id, childPath, depth - 1);
          rows.push(...deeper.map((row) => `  ${row}`));
        }
      } else {
        const info = await stat(path.join(target, entry.name)).catch(() => null);
        rows.push(`${childPath}${info ? ` (${info.size} bytes)` : ''}`);
      }
    }
    return rows;
  }
}
