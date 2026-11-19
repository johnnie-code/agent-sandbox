# agent-sandbox

An MCP server that gives an AI agent a disposable place to build things: clone any public repo, edit it,
run commands and tests, commit, and push or open a pull request. Workspaces are throwaway, so an agent can
break something without breaking anything that matters.

## What an agent can do with it

```
sandbox_create      create a workspace, optionally cloning any public GitHub repo at depth 1
sandbox_list        list the live workspaces
sandbox_destroy     delete a workspace
sandbox_exec        run one command, passed as an argv array, never a shell string
sandbox_read_file   read a text file
sandbox_write_file  write a text file, creating directories
sandbox_list_files  list a directory tree
sandbox_diff        git status and git diff for the workspace
sandbox_commit      stage everything and commit on a branch
sandbox_push        push a branch to a repo the token can write to
sandbox_open_pr     open a pull request from a workspace branch
```

## Run it

```bash
npm install
npm run build
SANDBOX_MODE=local npm start     # trusted machine only
SANDBOX_MODE=docker npm start    # the default and the safe one
```

Then point an MCP client at it. Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-sandbox": {
      "command": "node",
      "args": ["/absolute/path/to/agent-sandbox/dist/server.js"],
      "env": { "SANDBOX_MODE": "docker", "SANDBOX_IMAGE": "agent-sandbox:latest" }
    }
  }
}
```

Cursor and Windsurf take the same command and args in their MCP settings.

## Safety posture

The point of a sandbox is that the agent cannot reach the things you care about. In order of importance:

1. `docker` mode is the default. Every command runs in a container with `--memory 1g`, `--pids-limit 256`,
   `--cpus 1`, `--cap-drop ALL`, `--security-opt no-new-privileges`, and `--network none`, so a cloned
   repo cannot call out anywhere. Only the workspace directory is mounted, at `/workspace`.
2. No shell, ever. The caller passes an argv array and the first element is the program, so a destructive
   command typed inside an argument is just a string, not a command.
3. Every path is resolved and proved to sit inside its workspace before a file is touched. Absolute
   paths, drive letters, null bytes and parent-directory escapes are refused.
4. Every command has a wall-clock timeout and its output is truncated at 20,000 characters, keeping both
   ends and saying how much it dropped.
5. Repository names must be `owner/name`. A URL is refused, so a token cannot be smuggled in through one.
   Pushing passes the token through the environment, not into a remote URL stored on disk.

`SANDBOX_MODE=local` runs commands on the host itself. It is for a machine that is itself disposable.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `SANDBOX_MODE` | `docker` | `docker` or `local` |
| `SANDBOX_ROOT` | `/tmp/agent-sandbox/workspaces` | where workspaces live |
| `SANDBOX_IMAGE` | `node:22-bookworm` | image commands run in |
| `SANDBOX_NETWORK` | `none` | set to `bridge` only if a build needs the network |
| `SANDBOX_TIMEOUT_MS` | `120000` | per-command limit |
| `GITHUB_TOKEN` | unset | needed only for `sandbox_push` and `sandbox_open_pr` |

## Verified

- `npx tsc --noEmit` exits 0.
- `npm test` 9 passing: path escapes, null bytes, argv validation, container caps, output truncation.
- `npm run smoke` drives the real server over stdio: clones `octocat/Hello-World`, lists it, writes and
  reads a file, runs `git status`, and is refused when it asks for a path outside the workspace.

Not verified in the build environment: docker mode, because no docker daemon was available there. The
container arguments are asserted in a test, but a real container run is the first thing to check on a
machine with docker.

## Deliberately not built

- A hosted HTTP endpoint. This speaks stdio, which is how local MCP clients connect. A remote endpoint
  needs its own authentication story, and shipping one without that would be a public shell.
- Persistence across restarts. Workspaces are disposable by design; a restart forgets the registry, so
  the directories are the only record. Prune `SANDBOX_ROOT` if you use `local` mode.
