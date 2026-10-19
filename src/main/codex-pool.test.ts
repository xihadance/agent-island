import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ManagedCodexPool } from './codex-pool'
import { ManagedCodexServer, type CodexServerContext } from './codex-server'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'island-pool-')))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(path.join(directory, 'config.toml'), 'model = "default-model"\n')
  writeFileSync(path.join(directory, 'agentrouter.config.toml'), 'model = "profile-model"\n[model_providers.custom]\nname = "Custom"\nbase_url = "http://127.0.0.1:1"\nenv_key = "TEST_PROVIDER_KEY"\n')
  const children: ReturnType<typeof spawn>[] = []
  const launches: { args: string[]; context?: CodexServerContext }[] = []
  const pool = new ManagedCodexPool(() => {}, changed => new ManagedCodexServer(changed, (_exe, args, context) => {
    launches.push({ args, context })
    const script = `const {WebSocketServer}=require('ws');const s=new WebSocketServer({host:'127.0.0.1',port:${new URL(args.at(-1)!).port}});s.on('connection',w=>w.on('message',b=>{const m=JSON.parse(b);w.send(JSON.stringify({id:m.id,result:{userAgent:'fixture'}}))}));`
    const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    return child
  }, () => process.execPath))
  cleanup.push(() => pool.close())
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  const config = { enabled: true, port, executable: '' }
  await pool.configure(config)
  const request = { cwd: directory, overrides: [], env: { CODEX_HOME: directory, TEST_PROVIDER_KEY: 'fixture-private-value' } }
  return { pool, directory, children, launches, request, config }
}

it('deduplicates simultaneous launches, isolates defaults and profiles, and keeps terminal context in memory', async () => {
  const { pool, directory, launches, request } = await fixture()
  const selected = { ...request, profile: 'agentrouter' }
  const urls = await Promise.all([pool.ensure(selected), pool.ensure(selected), pool.ensure(request)])
  expect(urls[0]).toBe(urls[1])
  expect(urls[0]).not.toBe(urls[2])
  expect(launches).toHaveLength(3)
  const profile = launches.find(launch => launch.args.includes('model="profile-model"'))!
  expect(profile.args.join(' ')).toContain('base_url')
  expect(profile.args.join(' ')).toContain('TEST_PROVIDER_KEY')
  expect(profile.args.join(' ')).not.toContain('fixture-private-value')
  expect(profile.context?.env.TEST_PROVIDER_KEY).toBe('fixture-private-value')
  expect(profile.context?.env.CODEX_HOME).toBe(directory)
  expect(profile.context?.cwd).toBe(directory)
  expect(JSON.stringify(pool.state)).not.toContain('fixture-private-value')
  expect(launches.find(launch => launch.context && !launch.args.includes('model="profile-model"'))?.context?.args).toEqual([])
  expect(pool.urls).toHaveLength(3)
  expect(readFileSync(path.join(directory, 'config.toml'), 'utf8')).toBe('model = "default-model"\n')
}, 15000)

it('loads changed configuration and overrides into new instances without stopping previous sessions', async () => {
  const { pool, directory, children, launches, request } = await fixture()
  const selected = { ...request, profile: 'agentrouter' }
  const first = await pool.ensure(selected)
  writeFileSync(path.join(directory, 'agentrouter.config.toml'), 'model = "updated-profile"\n')
  const second = await pool.ensure(selected)
  expect(second).not.toBe(first)
  const defaultBefore = await pool.ensure(request)
  writeFileSync(path.join(directory, 'config.toml'), 'model = "updated-default"\n')
  expect(await pool.ensure(request)).not.toBe(defaultBefore)
  const override = await pool.ensure({ ...selected, overrides: ['model="explicit-override"'] })
  expect(override).not.toBe(second)
  expect(launches.at(-1)?.args.slice(1, -2)).toEqual(['-c', 'model="updated-profile"', '-c', 'model="explicit-override"'])
  const differentEnv = await pool.ensure({ ...selected, env: { ...request.env, TEST_PROVIDER_KEY: 'rotated-fixture' } })
  expect(differentEnv).not.toBe(second)
  expect(children.every(child => child.exitCode === null && child.signalCode === null)).toBe(true)
  await pool.close()
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  expect(pool.urls).toEqual([])
}, 20000)

it('cancels pending startup when stopped and permits a fresh retry after restart', async () => {
  const { pool, request, config, children } = await fixture()
  const pending = pool.ensure({ ...request, profile: 'agentrouter' })
  const rejected = expect(pending).rejects.toThrow('已停止')
  await pool.configure({ ...config, enabled: false })
  await rejected
  expect(pool.urls).toEqual([])
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  await pool.configure(config)
  await expect(pool.ensure({ ...request, profile: 'missing' })).rejects.toThrow('未找到')
  expect(await pool.ensure(request)).toMatch(/^ws:\/\/127\.0\.0\.1:/)
}, 15000)
