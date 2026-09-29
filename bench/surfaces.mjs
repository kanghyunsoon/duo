import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startDuoUiServer, LLMProviderPool } from '@duo-director/integration';

const CLI = fileURLToPath(new URL('../apps/cli/dist/main.js', import.meta.url));
const timed = async (fn) => { const t = performance.now(); const value = await fn(); return { ms: performance.now() - t, value }; };
export async function measureSurfaces(root, registry) {
  const out = { mcp: {}, ui: {} };
  const t = performance.now();
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--root', root], cwd: root, stderr: 'pipe',
    env: { ...getDefaultEnvironment(), OPENAI_API_KEY: '', OPENAI_BASE_URL: '' } });
  const client = new Client({ name: 'duo-benchmark', version: '0.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    out.mcp.connectMs = performance.now() - t;
    const call = async (name, args = {}) => timed(async () => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) throw new Error(`${name}: ${JSON.stringify(response.structuredContent ?? response.content)}`);
      return response.structuredContent;
    });
    out.mcp.firstStatus = (await call('duo_get_status')).ms;
    out.mcp.subsequentStatus = (await call('duo_get_status')).ms;
    out.mcp.firstContext = (await call('duo_get_context', { task: 'AUTH-03' })).ms;
    out.mcp.sameContext = (await call('duo_get_context', { task: 'AUTH-03' })).ms;
    out.mcp.review = (await call('duo_review_changes', { task: 'AUTH-03' })).ms;
    out.mcp.stderr = stderr ? stderr.slice(0, 500) : undefined;
  } finally { await client.close(); }

  const start = performance.now();
  const server = await startDuoUiServer({ root, version: 'benchmark', registry, llm: new LLMProviderPool({}) });
  try {
    out.ui.serverStartupMs = performance.now() - start;
    const opened = await fetch(server.launchUrl, { redirect: 'manual' });
    if (opened.status !== 303) throw new Error(`UI session: ${opened.status}`);
    const cookie = opened.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('UI session cookie missing');
    const get = async (route) => timed(async () => {
      const response = await fetch(`${server.origin}${route}`, { headers: { Cookie: cookie } });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(`${route}: ${JSON.stringify(body.error)}`);
      return body.data;
    });
    const csrf = (await get('/api/session')).value.csrf;
    const post = async (route, data) => timed(async () => {
      const response = await fetch(`${server.origin}${route}`, { method: 'POST', headers: { Cookie: cookie, Origin: server.origin,
        'Content-Type': 'application/json', 'X-Duo-CSRF': csrf }, body: JSON.stringify(data) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(`${route}: ${JSON.stringify(body.error)}`);
      return body.data;
    });
    out.ui.overviewMs = (await get('/api/overview')).ms;
    out.ui.directionMs = (await get('/api/direction')).ms;
    out.ui.graphMs = (await get('/api/graph?node=AUTH-03&kind=trace&depth=2')).ms;
    out.ui.contextMs = (await post('/api/context', { task: 'AUTH-03' })).ms;
    out.ui.reviewMs = (await post('/api/review', { task: 'AUTH-03' })).ms;
  } finally { await server.close(); }
  return out;
}
