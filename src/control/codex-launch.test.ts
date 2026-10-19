import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivityStore } from '../shared/activity'
import { startStatusServer, type StatusServer } from '../main/server'
import { resolveCodexLaunch, resolveCodexLaunchPlan, runCodexLaunch } from './codex-launch'
import type { CodexLaunchRequest, CodexLaunchRoute } from '../shared/codex-launch'

const servers: StatusServer[] = []
const peers: WebSocketServer[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()))
  for (const server of peers.splice(0)) { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture() {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); peers.push(ws)
  await new Promise<void>(resolve => ws.once('listening', resolve))
  const methods: string[] = []
  const tokens: (string | undefined)[] = []
  ws.on('connection', (socket, request) => {
    tokens.push(request.headers.authorization)
    socket.on('message', bytes => { const m = JSON.parse(bytes.toString()); methods.push(m.method); socket.send(JSON.stringify({ id: m.id, result: { userAgent: 'fixture' } })) })
  })
  let route: CodexLaunchRoute = { enabled: true, url: `ws://127.0.0.1:${(ws.address() as { port: number }).port}` }
  const token = 'local-launch-token-'.repeat(3)
  const prepared: CodexLaunchRequest[] = []
  const status = await startStatusServer(new ActivityStore(), { port: 0, token: 'unrelated-token', codexLaunch: { token, route: () => route,
    prepare: async value => { const request = value as CodexLaunchRequest; prepared.push(request); return { enabled: true, url: route.url, profile: request.profile } } } }); servers.push(status)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'island-codex-launch-')); directories.push(dir)
  const file = path.join(dir, 'launch.json')
  const statusUrl = `http://127.0.0.1:${status.port}/v1/codex/launch`
  const config = { version: 1, executable: process.execPath, statusUrl, token }
  writeFileSync(file, JSON.stringify(config))
  return { file, config, statusUrl, methods, tokens, prepared, setRoute: (next: CodexLaunchRoute) => { route = next } }
}

it('uses live switches for every launch, falls back after exit, and never creates or resumes a thread', async () => {
  const f = await fixture(); const args = ['-m', 'gpt-5', '保持 "引号" 和空格']
  const routed = await resolveCodexLaunch(args, f.file)
  expect(routed.slice(2)).toEqual(args)
  expect(routed[0]).toBe('--remote')
  f.setRoute({ enabled: false })
  expect(await resolveCodexLaunch(args, f.file)).toEqual(args)
  f.setRoute({ enabled: true, url: routed[1] })
  expect(await resolveCodexLaunch(args, f.file)).toEqual(routed)
  await servers[0].close()
  expect(await resolveCodexLaunch(args, f.file)).toEqual(args)
  expect(f.methods).toEqual(['initialize', 'initialize'])
})

it('protects launch status with its own token and returns no credentials', async () => {
  const f = await fixture()
  const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer unrelated-token' }, { authorization: `Bearer ${f.config.token}`, origin: 'https://example.test' }]
  for (const headers of attempts) {
    expect((await fetch(f.statusUrl, { headers })).status).toBe(403)
  }
  const response = await fetch(f.statusUrl, { headers: { authorization: `Bearer ${f.config.token}` } })
  expect(response.ok).toBe(true)
  expect(JSON.stringify(await response.json())).not.toContain(f.config.token)
})

it('keeps explicit choices and unsupported commands without subscribing to a service', async () => {
  const f = await fixture(); const args = ['--remote', 'wss://user.test']
  expect(await resolveCodexLaunch(args, f.file)).toEqual(args)
  expect(await resolveCodexLaunch(['exec', 'hello'], f.file)).toEqual(['exec', 'hello'])
  expect(await resolveCodexLaunch(['-p', 'luna'], f.file)).toEqual(['-p', 'luna'])
  expect(await resolveCodexLaunch([], f.file, { CUTE_ISLAND_CODEX_BYPASS: '1' })).toEqual([])
  expect(f.methods).toEqual([])
})

it('prepares the requested profile with terminal environment, cwd and overrides, preserving every client argument', async () => {
  const f = await fixture()
  const directory = path.dirname(f.file)
  const url = (await resolveCodexLaunch([], f.file))[1]
  const args = ['-p', 'agentrouter', '-C', directory, '-c', 'model="override"', 'resume', '--last']
  const env = { CODEX_HOME: directory, PROVIDER_KEY: 'terminal-only-value', ELECTRON_RUN_AS_NODE: '1', CUTE_ISLAND_CODEX_RUN_AS_NODE_SET: '' }
  f.setRoute({ enabled: true, url, managed: true })
  expect(await resolveCodexLaunchPlan(args, f.file, env)).toEqual({ args: ['--remote', url, ...args] })
  expect(f.prepared[0]).toEqual({ profile: 'agentrouter', cwd: directory, overrides: ['model="override"'], env: { CODEX_HOME: directory, PROVIDER_KEY: 'terminal-only-value' } })
  expect(await resolveCodexLaunchPlan([], f.file, env)).toEqual({ args: ['--remote', url] })
  expect(f.prepared[1].profile).toBeUndefined()
  expect(readFileSync(f.file, 'utf8')).not.toContain('terminal-only-value')
  f.setRoute({ enabled: false })
  expect(await resolveCodexLaunchPlan(args, f.file, env)).toEqual({ args })
  expect(f.prepared).toHaveLength(2)
  expect(f.methods).toEqual(['initialize', 'initialize', 'initialize'])
})

it('requires the independent token and rejects browser requests before preparing a service', async () => {
  const f = await fixture()
  const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer unrelated-token' }, { authorization: `Bearer ${f.config.token}`, origin: 'https://example.test' }]
  for (const headers of attempts) {
    expect((await fetch(f.statusUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
  }
  expect(f.prepared).toHaveLength(0)
})

it('decodes PowerShell argument arrays without losing quotes, Unicode or empty values', async () => {
  const f = await fixture()
  for (const args of [[], ['-m', 'gpt-5', '保持 "引号" $() `literal', '']]) {
    const output: string[] = []
    const encoded = Buffer.from(JSON.stringify(args)).toString('base64')
    expect(await runCodexLaunch(['plan', '--config', f.file, '--args-base64', encoded], line => output.push(line))).toBe(0)
    const routed = JSON.parse(output[0]).args
    expect(routed[0]).toBe('--remote')
    expect(routed.slice(2)).toEqual(args)
  }
  const invalid = Buffer.from(JSON.stringify({ args: ['unexpected shape'] })).toString('base64')
  await expect(runCodexLaunch(['plan', '--config', f.file, '--args-base64', invalid], () => {})).rejects.toThrow('字符串数组')
})

it('restores native startup for missing credentials, dead services and malformed state', async () => {
  const f = await fixture()
  f.setRoute({ enabled: true, url: 'ws://127.0.0.1:1', tokenEnv: 'TEST_CODEX_TOKEN' })
  expect(await resolveCodexLaunch(['-m', 'gpt-5'], f.file, {})).toEqual(['-m', 'gpt-5'])
  f.setRoute({ enabled: true, url: 'ws://127.0.0.1:1' })
  expect(await resolveCodexLaunch([], f.file)).toEqual([])
  writeFileSync(f.file, 'broken')
  expect(await resolveCodexLaunch([], f.file)).toEqual([])
  const network = vi.spyOn(globalThis, 'fetch')
  writeFileSync(f.file, JSON.stringify({ ...f.config, statusUrl: 'https://example.test/v1/codex/launch' }))
  expect(await resolveCodexLaunch([], f.file)).toEqual([])
  expect(network).not.toHaveBeenCalled(); network.mockRestore()
})

it('passes only the authentication variable name and probes with the terminal credential', async () => {
  const f = await fixture(); const url = (await resolveCodexLaunch([], f.file))[1]
  f.setRoute({ enabled: true, url, tokenEnv: 'TEST_CODEX_TOKEN' })
  const args = await resolveCodexLaunch([], f.file, { TEST_CODEX_TOKEN: 'test-only-bearer' })
  expect(args).toEqual(['--remote', url, '--remote-auth-token-env', 'TEST_CODEX_TOKEN'])
  expect(args).not.toContain('test-only-bearer')
  expect(f.tokens.at(-1)).toBe('Bearer test-only-bearer')
})

it.each([undefined, 'original-value'])('restores the original runtime environment (%s) for the native command', async original => {
  const f = await fixture(); f.setRoute({ enabled: false })
  const output = path.join(path.dirname(f.file), 'environment.json')
  const script = `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({runtime:process.env.ELECTRON_RUN_AS_NODE,metadata:Object.keys(process.env).filter(k=>k.startsWith('CUTE_ISLAND_CODEX_'))})); process.exit(7)`
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUTE_ISLAND_CODEX_RUN_AS_NODE_SET: original === undefined ? '' : 'x', CUTE_ISLAND_CODEX_ORIGINAL_RUN_AS_NODE: original ?? '' }
  expect(await runCodexLaunch(['run', '--config', f.file, '--', '-e', script], () => {}, env)).toBe(7)
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ ...(original === undefined ? {} : { runtime: original }), metadata: [] })
  expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
})
