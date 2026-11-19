/**
 * Path handling for a workspace.
 *
 * An agent chooses the paths, so every path it sends is treated as hostile until it is proved to land
 * inside the workspace it belongs to. This is the single place that check happens, so no tool can skip it.
 */
import path from 'node:path';

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Resolves a caller-supplied relative path inside a root directory.
 * Absolute paths, drive letters, null bytes and any traversal that escapes the root are refused.
 */
export function safeJoin(root: string, relative: string): string {
  if (typeof relative !== 'string') throw new SandboxError('a path is required');
  if (relative.includes('\0')) throw new SandboxError('a path cannot contain a null byte');

  const cleaned = relative.trim().replace(/\\/g, '/');
  if (!cleaned) return path.resolve(root);
  if (cleaned.startsWith('/')) throw new SandboxError('use a path relative to the workspace, not an absolute one');
  if (/^[a-zA-Z]:/.test(cleaned)) throw new SandboxError('use a path relative to the workspace, not a drive path');

  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, cleaned);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new SandboxError(`path escapes the workspace: ${relative}`);
  }
  return resolved;
}

/** A workspace id is generated here, never taken from a caller, but ids are re-checked before use. */
export function isWorkspaceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(value);
}
