/**
 * A real end-to-end check: start the server the way a client would, over stdio, and use it.
 * It creates a workspace from a public repo, lists files, runs a command, writes a file and reads it back.
 * Run with SANDBOX_MODE=local on a machine where that is acceptable, or with docker available.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/server.ts'],
  env: { ...process.env, SANDBOX_MODE: process.env.SANDBOX_MODE ?? 'local', SANDBOX_ROOT: '/tmp/agent-sandbox/smoke' },
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((tool) => tool.name).join(', ')}`);

const created = await client.callTool({ name: 'sandbox_create', arguments: { repo: 'octocat/Hello-World', name: 'smoke' } });
const text = (created.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
console.log(`create:\n${text}`);
const id = /workspace (\S+)/.exec(text)?.[1];
if (!id) throw new Error('the server did not return a workspace id');

const files = await client.callTool({ name: 'sandbox_list_files', arguments: { id, depth: 1 } });
console.log(`files:\n${(files.content as Array<{ text?: string }>)[0]?.text}`);

const wrote = await client.callTool({ name: 'sandbox_write_file', arguments: { id, path: 'notes/hello.txt', content: 'built by an agent\n' } });
console.log(`write: ${(wrote.content as Array<{ text?: string }>)[0]?.text}`);

const read = await client.callTool({ name: 'sandbox_read_file', arguments: { id, path: 'notes/hello.txt' } });
console.log(`read: ${JSON.stringify((read.content as Array<{ text?: string }>)[0]?.text)}`);

const ran = await client.callTool({ name: 'sandbox_exec', arguments: { id, argv: ['git', 'status', '--porcelain'] } });
console.log(`exec:\n${(ran.content as Array<{ text?: string }>)[0]?.text}`);

const escaped = await client.callTool({ name: 'sandbox_read_file', arguments: { id, path: '../../../etc/passwd' } });
console.log(`escape attempt: ${(escaped.content as Array<{ text?: string }>)[0]?.text}`);

await client.callTool({ name: 'sandbox_destroy', arguments: { id } });
await client.close();
console.log('smoke ok');
