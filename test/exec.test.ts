import assert from 'node:assert/strict';
import test from 'node:test';
import { dockerArgs, truncate, validateArgv, MAX_OUTPUT_CHARS } from '../src/exec.js';

test('a command must be an argv array, so nothing is ever handed to a shell', () => {
  assert.deepEqual(validateArgv(['npm', 'test']), ['npm', 'test']);
  assert.throws(() => validateArgv('npm test'), /as an array/);
  assert.throws(() => validateArgv([]), /as an array/);
  assert.throws(() => validateArgv(['echo', 5]), /not a string/);
  assert.throws(() => validateArgv(['echo', 'a\0b']), /null byte/);
});

test('shell metacharacters stay inside their argument', () => {
  const argv = validateArgv(['sh', '-c', 'rm -rf /; echo done']);
  assert.equal(argv.length, 3);
  assert.equal(argv[2], 'rm -rf /; echo done');
});

test('the container is capped and has no network by default', () => {
  const args = dockerArgs('/tmp/ws', ['npm', 'test'], 'node:22-bookworm', 'none');
  assert.equal(args[0], 'run');
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--memory') + 1], '1g');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '256');
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.ok(args.includes('/tmp/ws:/workspace'));
  assert.deepEqual(args.slice(-2), ['npm', 'test']);
});

test('long output keeps both ends and says how much it dropped', () => {
  const long = 'a'.repeat(MAX_OUTPUT_CHARS * 2);
  const result = truncate(long);
  assert.equal(result.truncated, true);
  assert.match(result.text, /characters removed/);
  assert.ok(result.text.length < long.length);
  assert.equal(truncate('short').truncated, false);
});
