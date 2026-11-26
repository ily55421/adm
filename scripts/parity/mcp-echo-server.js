// 差分基座用的最小 MCP stdio 服务器（scripts/parity/capture-parity.ps1 会把它写进两侧隔离配置）。
// 提供 1 个工具 / 1 个 Prompt / 1 个 Resource，响应固定，便于逐字对拍。
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const tools = [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
const prompts = [{ name: 'greet', description: 'Greeting prompt', arguments: [{ name: 'who', required: true }] }];
const resources = [{ uri: 'test://resource/hello', name: 'hello', mimeType: 'text/plain', description: 'Hello resource' }];
function send(m) { process.stdout.write(JSON.stringify(m) + '\n'); }
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  const id = msg.id;
  if (!msg.method) { if (id != null) send({ jsonrpc: '2.0', id, result: {} }); return; }
  switch (msg.method) {
    case 'initialize':
      if (id != null) send({ jsonrpc: '2.0', id, result: { protocolVersion: (msg.params || {}).protocolVersion || '2024-11-05', capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'parity-mcp', version: '1.0.0' } } });
      return;
    case 'notifications/initialized': return;
    case 'tools/list': if (id != null) send({ jsonrpc: '2.0', id, result: { tools } }); return;
    case 'prompts/list': if (id != null) send({ jsonrpc: '2.0', id, result: { prompts } }); return;
    case 'resources/list': if (id != null) send({ jsonrpc: '2.0', id, result: { resources } }); return;
    case 'resources/read':
      if (id != null) send({ jsonrpc: '2.0', id, result: { contents: [{ uri: (msg.params || {}).uri || '', mimeType: 'text/plain', text: 'hello from parity mcp' }] } });
      return;
    case 'prompts/get':
      if (id != null) send({ jsonrpc: '2.0', id, result: { description: 'greeting', messages: [{ role: 'user', content: { type: 'text', text: 'hello ' + (((msg.params || {}).arguments || {}).who || 'world') } }] } });
      return;
    case 'tools/call':
      if (id != null) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo:' + (((msg.params || {}).arguments || {}).text || '') }] } });
      return;
    case 'ping': if (id != null) send({ jsonrpc: '2.0', id, result: {} }); return;
    default: if (id != null) send({ jsonrpc: '2.0', id, result: {} }); return;
  }
});
process.stdin.on('end', () => process.exit(0));
