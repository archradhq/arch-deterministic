/**
 * Local MCP smoke test: spawns archrad-mcp, lists tools, calls archrad_suggest_fix.
 * Run from package root: npm run build && npm run smoke:mcp
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const serverJs = join(root, 'dist', 'mcp-server.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverJs],
  cwd: root,
});

const client = new Client({ name: 'archrad-smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log('Tools (%d):', names.length, names.join(', '));

if (!names.includes('archrad_suggest_fix')) {
  console.error('FAIL: archrad_suggest_fix not registered');
  process.exitCode = 1;
} else {
  const r = await client.callTool({
    name: 'archrad_suggest_fix',
    arguments: { findingCode: 'IR-LINT-MISSING-AUTH-010' },
  });
  const text = r.content?.[0]?.text;
  if (!text || !text.includes('IR-LINT-MISSING-AUTH-010')) {
    console.error('FAIL: unexpected suggest_fix response', r);
    process.exitCode = 1;
  } else {
    console.log('archrad_suggest_fix OK (snippet):', text.slice(0, 200).replace(/\n/g, ' '), '…');
  }
}

await client.close();
