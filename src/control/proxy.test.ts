import { createServer, request, type Server } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { once } from 'node:events'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { SimpleShardingStrategy, WebSocketManager } from '@discordjs/ws'
import { REST } from 'discord.js'
import { chromiumProxy, createChannelTransport } from './proxy'
import { effectiveProxy, parseProxy, type ProxySettings } from '../shared/proxy'
import { TelegramChannel } from './channels/telegram'
import { ControlStore } from './store'
import { testRemoteConnection } from './connectivity'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => { server.closeAllConnections(); server.close() })
  return (server.address() as { port: number }).port
}
const certificate = readFileSync(new URL('./test-fixtures/proxy-cert.pem', import.meta.url))
async function proxyFixture(secure = false) {
  const paths: string[] = []
  const upstream = secure ? createHttpsServer({ cert: certificate, key: readFileSync(new URL('./test-fixtures/proxy-key.pem', import.meta.url)) }) : createServer()
  upstream.on('request', (req, res) => {
    paths.push(req.url!)
    const value = req.url!.endsWith('getWebhookInfo') ? { ok: true, result: { url: '' } }
      : req.url!.endsWith('getUpdates') ? { ok: true, result: [] } : { ok: true, result: { message_id: 1 } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value))
  })
  const port = await listen(upstream)
  const ws = new WebSocketServer({ server: upstream })
  cleanup.push(() => { for (const peer of ws.clients) peer.terminate(); ws.close() })
  const requests: string[] = []
  const proxy = createServer((req, res) => {
    requests.push(req.url!)
    const destination = new URL(req.url!)
    const forward = request({ hostname: '127.0.0.1', port, path: destination.pathname + destination.search, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res)
    })
    forward.on('error', () => res.destroy()); req.pipe(forward)
  })
  proxy.on('connect', (req, socket, head) => {
    requests.push(req.url!)
    const forward = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) forward.write(head)
      socket.pipe(forward); forward.pipe(socket)
    })
    socket.on('error', () => forward.destroy()); forward.on('error', () => socket.destroy())
    cleanup.push(() => { socket.destroy(); forward.destroy() })
  })
  return { requests, paths, ws, port, url: `http://127.0.0.1:${await listen(proxy)}` }
}
function transport(settings?: ProxySettings, override?: Parameters<typeof createChannelTransport>[1], resolver?: Parameters<typeof createChannelTransport>[2]) {
  const result = createChannelTransport(settings, override, resolver); cleanup.push(() => result.close()); return result
}

it('validates proxy policies without echoing secrets and resolves channel precedence', () => {
  const custom = { mode: 'custom' as const, url: 'http://localhost:7890' }
  expect(effectiveProxy()).toEqual({ mode: 'system' })
  expect(effectiveProxy(custom, { mode: 'inherit' })).toEqual(custom)
  for (const mode of ['direct', 'system'] as const) expect(effectiveProxy(custom, { mode })).toEqual({ mode })
  expect(parseProxy({ mode: 'custom', url: ' socks5://localhost:1080 ' })).toEqual({ mode: 'custom', url: 'socks5://localhost:1080' })
  for (const url of ['file:///secret', 'http://secret@host:0', 'socks5://secret@host', 'http://secret@host:7890/path', 'http://secret@host:7890?q=secret']) {
    expect(() => parseProxy({ mode: 'custom', url })).toThrow('代理地址')
    try { parseProxy({ mode: 'custom', url }) } catch (error) { expect(String(error)).not.toContain('secret') }
  }
  expect(() => parseProxy({ mode: 'inherit' })).toThrow('代理模式')
  expect(() => parseProxy({ mode: ['system'] })).toThrow('代理模式')
  expect(parseProxy({ mode: 'inherit' }, true)).toEqual({ mode: 'inherit' })
  expect(chromiumProxy('PROXY 127.0.0.1:7890; DIRECT')).toBe('http://127.0.0.1:7890')
  expect(chromiumProxy('SOCKS5 127.0.0.1:1080')).toBe('socks5h://127.0.0.1:1080')
  expect(chromiumProxy('DIRECT')).toBe('')
})

it('routes HTTP and WebSocket through one custom proxy and bypasses loopback', async () => {
  const fixture = await proxyFixture()
  const network = transport({ mode: 'custom', url: fixture.url })
  expect((await network.fetch('http://api.invalid/hello')).ok).toBe(true)
  fixture.ws.on('connection', peer => peer.on('message', bytes => peer.send(bytes.toString())))
  const socket = new WebSocket('ws://gateway.invalid/socket', { agent: network.agent })
  cleanup.push(() => socket.terminate())
  await once(socket, 'open'); socket.send('proxied'); expect((await once(socket, 'message'))[0].toString()).toBe('proxied')
  expect(fixture.requests).toEqual(['http://api.invalid/hello', 'gateway.invalid:80'])
  await network.fetch(`http://127.0.0.1:${fixture.port}/local`)
  expect(fixture.requests).toHaveLength(2)
})

it('tunnels HTTPS and WSS without weakening TLS verification', async () => {
  const fixture = await proxyFixture(true)
  const network = transport({ mode: 'custom', url: fixture.url })
  // Trust only this isolated fixture CA. Production keeps Node's certificate validation.
  network.agent.options.ca = certificate
  expect((await network.fetch('https://api.invalid/secure')).ok).toBe(true)
  const socket = new WebSocket('wss://gateway.invalid/secure', { agent: network.agent })
  cleanup.push(() => socket.terminate()); await once(socket, 'open')
  expect(fixture.requests).toEqual(['api.invalid:443', 'gateway.invalid:443'])
  const untrusted = transport({ mode: 'custom', url: fixture.url })
  await expect(untrusted.fetch('https://api.invalid/untrusted')).rejects.toThrow(/self.signed certificate/)
})

it('uses OS resolution for defaults and respects independent direct/custom overrides', async () => {
  const fixture = await proxyFixture()
  const resolver = vi.fn(async () => `PROXY ${new URL(fixture.url).host}`)
  await transport(undefined, undefined, resolver).fetch('http://api.invalid/system')
  await transport({ mode: 'direct' }, { mode: 'system' }, resolver).fetch('http://api.invalid/override-system')
  const custom = transport({ mode: 'direct' }, { mode: 'custom', url: fixture.url }, resolver)
  await custom.http.get('http://api.invalid/lark')
  const direct = transport({ mode: 'custom', url: fixture.url }, { mode: 'direct' }, resolver)
  await expect(direct.fetch('http://api.invalid/direct')).rejects.toThrow()
  expect(resolver).toHaveBeenCalledTimes(2)
  expect(fixture.requests).toEqual(['http://api.invalid/system', 'http://api.invalid/override-system', 'http://api.invalid/lark'])
})

it('uses the same proxy for Telegram startup, long polling and sends', async () => {
  const fixture = await proxyFixture()
  const network = transport({ mode: 'custom', url: fixture.url })
  const telegram = new TelegramChannel('tg', 'chat', ['owner'], 'synthetic-token', new ControlStore(), network.fetch, 'http://api.invalid')
  cleanup.push(() => telegram.close())
  await telegram.start(async () => '')
  await telegram.send('local fixture only')
  await vi.waitFor(() => expect(fixture.paths.some(path => path.endsWith('/getUpdates'))).toBe(true))
  telegram.close()
  expect(fixture.paths.some(path => path.endsWith('/getWebhookInfo'))).toBe(true)
  expect(fixture.paths.some(path => path.endsWith('/sendMessage'))).toBe(true)
})

it('uses SOCKS5 with remote DNS for both HTTP and WebSocket traffic', async () => {
  const fixture = await proxyFixture()
  const destinations: string[] = []
  const socks = createTcpServer(socket => {
    let buffered = Buffer.alloc(0), stage = 0
    const read = (bytes: Buffer) => {
      buffered = Buffer.concat([buffered, bytes])
      if (stage === 0 && buffered.length >= 2 + buffered[1]) {
        buffered = buffered.subarray(2 + buffered[1]); stage = 1; socket.write(Buffer.from([5, 0]))
      }
      if (stage === 1 && buffered.length >= 5 && buffered.length >= 7 + buffered[4]) {
        expect(buffered[3]).toBe(3) // Hostname must reach the proxy without local DNS.
        destinations.push(buffered.subarray(5, 5 + buffered[4]).toString())
        const remaining = buffered.subarray(7 + buffered[4]); stage = 2; socket.removeListener('data', read)
        const upstream = connect(fixture.port, '127.0.0.1', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
          if (remaining.length) upstream.write(remaining)
          socket.pipe(upstream); upstream.pipe(socket)
        })
        socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
        cleanup.push(() => { socket.destroy(); upstream.destroy() })
      }
    }
    socket.on('data', read)
  }).listen(0, '127.0.0.1')
  await once(socks, 'listening'); cleanup.push(() => { socks.close() })
  const url = `socks5://127.0.0.1:${(socks.address() as { port: number }).port}`
  const network = transport({ mode: 'custom', url })
  expect((await network.fetch('http://http.invalid/socks')).ok).toBe(true)
  const socket = new WebSocket('ws://ws.invalid/socks', { agent: network.agent })
  cleanup.push(() => socket.terminate()); await once(socket, 'open')
  expect(destinations).toEqual(['http.invalid', 'ws.invalid'])
})

it('uses the unsaved global proxy in the actual WeCom connectivity test', async () => {
  const fixture = await proxyFixture()
  fixture.ws.on('connection', peer => peer.on('message', bytes => {
    const message = JSON.parse(bytes.toString())
    peer.send(JSON.stringify({ headers: message.headers, errcode: 0, body: {} }))
  }))
  const result = await testRemoteConnection({ kind: 'channel', proxy: { mode: 'custom', url: fixture.url }, config: {
    id: 'wc', type: 'wecom', appId: 'test-bot', secretEnv: 'TEST_SECRET', destination: 'chat', allowedUsers: ['owner']
  } }, { env: { TEST_SECRET: 'synthetic-secret' }, wecomUrl: 'ws://wecom.invalid/socket', timeoutMs: 2000 })
  expect(result.ok).toBe(true)
  expect(fixture.requests).toEqual(['wecom.invalid:80'])
})

it('proxies Discord SDK Gateway handshakes and resume connections', async () => {
  const fixture = await proxyFixture()
  const network = transport({ mode: 'custom', url: fixture.url })
  const rest = new REST()
  vi.spyOn(rest, 'get').mockResolvedValue({ url: 'ws://gateway.invalid', shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 1000, max_concurrency: 1 } })
  const manager = new WebSocketManager({ token: 'synthetic-token', intents: 0, rest, shardCount: 1, compression: null,
    buildStrategy: manager => { Object.assign(manager.options, { islandAgent: network.agent }); return new SimpleShardingStrategy(manager) } })
  const ops: number[] = []
  fixture.ws.on('connection', peer => {
    peer.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }))
    peer.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); ops.push(message.op)
      if (message.op === 1) peer.send(JSON.stringify({ op: 11, d: null }))
      if (message.op === 2) {
        peer.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'test-session', resume_gateway_url: 'ws://resume.invalid', user: { id: '1' }, guilds: [] } }))
      }
      if (message.op === 6) peer.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 2, d: {} }))
    })
  })
  cleanup.push(async () => { await manager.destroy(); rest.clearHashSweeper(); rest.clearHandlerSweeper() })
  await manager.connect()
  for (const peer of fixture.ws.clients) peer.send(JSON.stringify({ op: 7, d: null }))
  await vi.waitFor(() => expect(ops).toContain(6), { timeout: 5000 })
  expect(fixture.requests).toEqual(['gateway.invalid:80', 'resume.invalid:80'])
})
