import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

it('keeps the SDK stdio handshake and tool calls working offline', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpServer({ name: 'offline-fixture', version: '1.0.0' });
  server.tool('fixture', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  const transport = new StdioServerTransport(input, output);
  async function request(id: number, method: string, params: object = {}) {
    const response = once(output, 'data');
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const [chunk] = await response;
    const message = JSON.parse(chunk.toString());
    expect(message.id).toBe(id);
    expect(message.error).toBeUndefined();
    return message.result;
  }
  try {
    await server.connect(transport);
    const init = await request(1, 'initialize', { protocolVersion: '2025-03-26',
      capabilities: {}, clientInfo: { name: 'offline-client', version: '1.0.0' } });
    expect(init.serverInfo.name).toBe('offline-fixture');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    expect((await request(2, 'tools/list')).tools.map((t: { name: string }) => t.name)).toEqual(['fixture']);
    expect((await request(3, 'tools/call', { name: 'fixture', arguments: {} })).content)
      .toEqual([{ type: 'text', text: 'ok' }]);
    expect(await request(4, 'ping')).toEqual({});
  } finally {
    await server.close(); input.destroy(); output.destroy();
  }
}, 5000);
