import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { css, Style } from 'hono/css';
import { validator } from 'hono/validator';
import { createAdaptorServer, getRequestListener } from '@hono/node-server';

// Dependency-level controls, NOT reachable-exploit claims: the bridge uses stdio.
// All requests/upgrade events are in memory; nothing listens on a network port.
describe('Hono advisory regressions', () => {
  it('rejects cross-origin text/ping (GHSA-46wx-v44x-9hh2)', async () => {
    const app = new Hono();
    app.use('*', csrf());
    app.post('/action', c => c.text('changed'));
    const request = (origin: string) => app.request('http://app.test/action', {
      method: 'POST', headers: { origin, 'content-type': 'text/ping' }, body: 'PING'
    });
    expect((await request('http://other.test')).status).toBe(403);
    expect((await request('http://app.test')).status).toBe(200);
  });

  it.each([
    ['/api/:tenant', '/api/:tenant/admin/*', '/api/a/xxxxx/admin/secret'],
    ['/app', '/app/admin/*', '/app/public%5C..%5Cadmin/secret']
  ])('does not remap %s around scoped auth (GHSA-4m76-xfj5-7975)', async (prefix, auth, path) => {
    const inner = new Hono();
    inner.get('/admin/secret', c => c.text('secret'));
    const outer = new Hono();
    outer.use(auth, async c => c.text('denied', 401));
    outer.mount(prefix, inner.fetch);
    expect(await (await outer.request(path)).text()).not.toBe('secret');
  });

  it('preserves ordinary static mounting', async () => {
    const inner = new Hono();
    inner.get('/ok', c => c.text('ok'));
    const outer = new Hono();
    outer.mount('/app', inner.fetch);
    expect(await (await outer.request('/app/ok')).text()).toBe('ok');
  });

  it('escapes split style closing tags (GHSA-3gg2-335m-rxc6)', async () => {
    const value = '/style><script>fixture</script>';
    const rendered = await Style({ children: css`p { content: "<${value}"; }` });
    expect(String(rendered)).not.toContain('</style><script>');
    expect(String(rendered)).toContain('<style');
  });

  it('validates multipart with extra parameters (GHSA-4h7h-rv7c-7m2v)', async () => {
    const app = new Hono();
    app.post('/', validator('form', (value, c) => {
      if ('blocked' in value) return c.text('denied', 400);
      return value;
    }), async c => c.json(await c.req.parseBody()));
    const body = '--fixture\r\nContent-Disposition: form-data; name="blocked"\r\n\r\nyes\r\n--fixture--\r\n';
    for (const parameters of ['boundary=fixture', 'boundary=fixture; charset=utf-8']) {
      expect((await app.request('/', { method: 'POST', headers: {
        'content-type': `multipart/form-data; ${parameters}`
      }, body })).status).toBe(400);
    }
  });

  it.each([
    ['/api/:tenant{[^/]+}/admin/*', '/api/:tenant/admin/:id', '/api/a/admin/secret'],
    ['/admin/*', '/admin*', '/admin/secret'],
    ['*', '/ok', '/missing%0Apath']
  ])('keeps wildcard auth on %s (GHSA-h7mg-cq63-vhpq)', async (middleware, route, path) => {
    const app = new Hono();
    app.use(middleware, async c => c.text('denied', 401));
    app.get(route, c => c.text('secret'));
    app.notFound(c => c.text('not found', 404));
    expect((await app.request(path)).status).toBe(401);
  });
});

async function adapterStatus(path: string) {
  const socket = new Socket();
  const incoming = new IncomingMessage(socket);
  incoming.method = 'GET'; incoming.url = path; incoming.headers = { host: 'app.test' };
  const outgoing = Object.assign(new EventEmitter(), {
    writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn()
  });
  const fetch = vi.fn(() => new Response(null, { status: 204 }));
  try {
    await getRequestListener(fetch, { overrideGlobalObjects: false })(incoming, outgoing as never);
    return { status: outgoing.writeHead.mock.calls[0]?.[0], fetch };
  } finally { socket.destroy(); }
}

describe('Node adapter advisory regressions without a listener', () => {
  it.each(['/admin\\secret', '/public\\..\\admin/secret', 'http://app.test/admin\\secret'])(
    'rejects raw path backslash %s (GHSA-jpvv-r467-5p4w)', async path => {
      const result = await adapterStatus(path);
      expect(result.status).toBe(400);
      expect(result.fetch).not.toHaveBeenCalled();
    });
  it.each(['/admin%5Csecret', '/ok?value=\\', '/ok'])(
    'still accepts valid target %s', async path => {
      const result = await adapterStatus(path);
      expect(result.status).toBe(204);
      expect(result.fetch).toHaveBeenCalledOnce();
    });

  it('handles a reset during async upgrade (GHSA-qv5m-9pm6-hqp3)', async () => {
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>(resolve => { release = resolve; });
    const wss = Object.assign(new EventEmitter(), {
      options: { noServer: true }, handleUpgrade: vi.fn(), close: vi.fn()
    });
    const server = createAdaptorServer({ fetch: () => waiting,
      overrideGlobalObjects: false, websocket: { server: wss as never } });
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false, end: vi.fn(), destroy() { this.destroyed = true; this.emit('close'); }
    });
    const request = { headers: { host: 'app.test', upgrade: 'websocket' }, url: '/ws', socket };
    const upgrade = server.listeners('upgrade')[0]!(request, socket, Buffer.alloc(0));
    try {
      expect(() => socket.emit('error', Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }))).not.toThrow();
    } finally {
      socket.destroy(); release(new Response(null, { status: 403 })); await upgrade;
      server.emit('close');
    }
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.end).not.toHaveBeenCalled();
  });
});
