/**
 * Running a command for an agent.
 *
 * Three rules keep this from becoming a remote shell on the host:
 * 1. No shell. The caller passes an argv array, and the first element is the program. Nothing is
 *    concatenated into a command string, so a quote or a semicolon is just a character in an argument.
 * 2. In docker mode every command runs inside a container with a memory cap, a pid cap, one cpu and no
 *    network by default. The workspace is the only thing mounted.
 * 3. Every command has a wall-clock limit and its output is truncated, so a runaway process cannot
 *    hold a turn open or flood a model's context.
 */
import { spawn } from 'node:child_process';

export const MAX_OUTPUT_CHARS = 20000;
export const MAX_ARGV = 64;
export const MAX_ARG_CHARS = 4096;

export type SandboxMode = 'docker' | 'local';

export interface RunOptions {
  dir: string;
  argv: string[];
  mode: SandboxMode;
  image: string;
  network: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface RunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/** Rejects an argv that could not be a program call, before anything is spawned. */
export function validateArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('pass the command as an array, for example ["npm", "test"]');
  }
  if (argv.length > MAX_ARGV) throw new Error(`a command may have at most ${MAX_ARGV} parts`);
  return argv.map((part, index) => {
    if (typeof part !== 'string') throw new Error(`part ${index} of the command is not a string`);
    if (part.includes('\0')) throw new Error(`part ${index} of the command contains a null byte`);
    if (part.length > MAX_ARG_CHARS) throw new Error(`part ${index} of the command is too long`);
    return part;
  });
}

export function truncate(text: string, max = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor(max / 2);
  return {
    text: `${text.slice(0, half)}\n\n[... ${text.length - max} characters removed ...]\n\n${text.slice(-half)}`,
    truncated: true,
  };
}

/** The docker invocation. Kept separate so it can be asserted in a test without a docker daemon. */
export function dockerArgs(dir: string, argv: string[], image: string, network: string): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--network',
    network,
    '--memory',
    '1g',
    '--memory-swap',
    '1g',
    '--cpus',
    '1',
    '--pids-limit',
    '256',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-v',
    `${dir}:/workspace`,
    '-w',
    '/workspace',
    image,
    ...argv,
  ];
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  const argv = validateArgv(options.argv);
  const [program, ...rest] = argv as [string, ...string[]];

  const useDocker = options.mode === 'docker';
  const finalProgram = useDocker ? 'docker' : program;
  const finalArgs = useDocker ? dockerArgs(options.dir, argv, options.image, options.network) : rest;

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(finalProgram, finalArgs, {
      cwd: useDocker ? undefined : options.dir,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...(options.env ?? {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 4) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 4) stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        command: argv.join(' '),
        exitCode: null,
        stdout: '',
        stderr: `${(error as Error).message}`,
        timedOut,
        truncated: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const out = truncate(stdout);
      const err = truncate(stderr);
      resolve({
        command: argv.join(' '),
        exitCode: code,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}
