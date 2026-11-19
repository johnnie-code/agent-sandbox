import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { isWorkspaceId, safeJoin } from '../src/paths.js';

const root = '/tmp/agent-sandbox/workspaces/demo-abc123';

test('a normal relative path lands inside the workspace', () => {
  assert.equal(safeJoin(root, 'src/index.ts'), path.join(root, 'src/index.ts'));
  assert.equal(safeJoin(root, './README.md'), path.join(root, 'README.md'));
  assert.equal(safeJoin(root, ''), path.resolve(root));
});

test('an escape attempt is refused, however it is dressed up', () => {
  for (const attempt of ['../outside.txt', 'src/../../outside', 'a/b/../../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini']) {
    assert.throws(() => safeJoin(root, attempt), /escapes the workspace|relative to the workspace/, attempt);
  }
});

test('a null byte is refused before it reaches the filesystem', () => {
  assert.throws(() => safeJoin(root, 'file\0.ts'), /null byte/);
});

test('a prefix that merely looks like the root is not the root', () => {
  assert.throws(() => safeJoin(root, '../demo-abc1234/secret'), /escapes the workspace/);
});

test('workspace ids are the shape this server generates', () => {
  assert.equal(isWorkspaceId('express-1a2b3c4d'), true);
  assert.equal(isWorkspaceId('../etc'), false);
  assert.equal(isWorkspaceId('A'), false);
});
