import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedCodexServer, findCodexExecutable } from './codex-server'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port
}
function fixture() {
  const children: ReturnType<typeof spawn>[] = []
  const launches: string[][] = []
  const manager = new ManagedCodexServer(() => {}, (_exe, args) => {
    launches.push(args)
    const port = new URL(args.at(-1)!).port
    const code = `const {WebSocketServer}=require('ws'); const s=new WebSocketServer({host:'127.0.0.1',port:${port}}); s.on('connection',ws=>ws.on('message',b=>{const m=JSON.parse(b); ws.send(JSON.stringify({id:m.id,result:{userAgent:'fixture'}}));}));`
    const child = spawn(process.execPath, ['-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); return child
  }, () => process.execPath)
  cleanup.push(() => manager.close()); return { manager, children, launches }
}
it('owns one native service, probes the protocol, restarts on port changes and stops only its child', async () => {
  const { manager, children } = fixture(); const port = await freePort()
  const config = { enabled: true, port, executable: '' }
  await manager.configure(config)
  expect(manager.state.status).toBe('running')
  await manager.configure(config); expect(children).toHaveLength(1)
  const nextPort = await freePort(); await manager.configure({ ...config, port: nextPort })
  expect(children).toHaveLength(2); expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true)
  expect(manager.state.url).toBe(`ws://127.0.0.1:${nextPort}`)
  await manager.close(); expect(manager.state.status).toBe('stopped')
  expect(children[1].exitCode !== null || children[1].signalCode !== null).toBe(true)
}, 15000)
it('never attaches to or terminates a service already using the selected port', async () => {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const { manager, children } = fixture()
  await manager.configure({ enabled: true, port: (server.address() as { port: number }).port, executable: '' })
  expect(manager.state.status).toBe('error'); expect(manager.state.detail).toContain('已被占用'); expect(children).toHaveLength(0)
  expect(server.listening).toBe(true)
})

it('cancels startup when stopped immediately and rejects shell-shim executable paths', async () => {
  const { manager, children } = fixture(); const port = await freePort()
  const start = manager.configure({ enabled: true, port, executable: '' })
  const stop = manager.configure({ enabled: false, port, executable: '' })
  await Promise.all([start, stop]); expect(manager.state.status).toBe('stopped'); expect(children).toHaveLength(0)
  expect(() => findCodexExecutable('codex.cmd')).toThrow('原生')
})
