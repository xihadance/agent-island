import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { readCodexProfile } from '../control/codex-profile'
import { isCodexProfile } from '../shared/codex-profile'
import type { CodexLaunchRequest } from '../shared/codex-launch'
import type { Preferences, SettingsSnapshot } from '../shared/preferences'
import { ManagedCodexServer, type CodexServerContext } from './codex-server'

/** A changed configuration gets a new process; existing clients keep their original process. */
export class ManagedCodexPool {
  private primary: ManagedCodexServer
  private entries = new Map<string, { server: ManagedCodexServer; ready: Promise<string> }>()
  private config?: Preferences['codexServer']
  private generation = 0
  private queue: Promise<void> = Promise.resolve()
  constructor(private changed: () => void, private create = (changed: () => void) => new ManagedCodexServer(changed)) {
    this.primary = create(changed)
  }
  get urls(): string[] {
    if (!this.config?.enabled) return []
    return [this.primary, ...[...this.entries.values()].map(entry => entry.server)]
      .filter(server => server.state.status === 'running').map(server => server.state.url)
  }
  get state(): SettingsSnapshot['codexServer'] {
    const urls = this.urls
    return { ...this.primary.state, ...(this.primary.state.status === 'running' ? {
      detail: `服务已就绪，当前运行 ${urls.length} 个实例。codex 按默认配置接入，codex -p 按指定配置接入。` } : {}), instances: urls.length }
  }
  configure(config: Preferences['codexServer']): Promise<void> {
    if (JSON.stringify(config) === JSON.stringify(this.config)) return this.queue
    this.config = { ...config }
    ++this.generation
    const closing = this.stopInstances()
    this.queue = Promise.all([closing, this.primary.configure(config)]).then(() => {})
    return this.queue
  }
  async ensure(value: unknown): Promise<string> {
    const generation = this.generation
    const request = validateRequest(value)
    await this.queue
    this.checkEnabled(generation)
    const cwd = realpathSync(request.cwd)
    const directory = realpathSync(request.env.CODEX_HOME || path.join(os.homedir(), '.codex'))
    const profile = request.profile ? readCodexProfile(request.profile, directory) : undefined
    const context: CodexServerContext = { cwd, env: { ...request.env, CODEX_HOME: directory },
      args: [...(profile?.args ?? []), ...request.overrides.flatMap(value => ['-c', value])] }
    // Hash source files as well as overrides, including defaults and project layers read natively.
    const sources = [path.join(directory, 'config.toml')]
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      sources.push(path.join(dir, '.codex', 'config.toml'))
      if (path.dirname(dir) === dir) break
    }
    const digest = createHash('sha256').update(JSON.stringify([request.profile, cwd, context.args,
      Object.entries(context.env).sort(([a], [b]) => a.localeCompare(b)), this.config?.executable]))
    for (const file of sources) { digest.update(file); if (existsSync(file)) digest.update(readFileSync(file)); digest.update('\0') }
    const key = digest.digest('hex')
    const previous = this.entries.get(key)
    if (previous && previous.server.state.status !== 'error') return previous.ready
    if (previous) {
      this.entries.delete(key); await previous.server.close()
      const replacement = this.entries.get(key)
      if (replacement) return replacement.ready
    }
    this.checkEnabled(generation)
    if (this.entries.size >= 32) throw new Error('托管服务实例已达上限，请结束会话后停止并重新启动托管服务')
    const server = this.create(this.changed)
    const entry = { server, ready: Promise.resolve('') }
    entry.ready = Promise.resolve().then(async () => {
      try {
        const port = await freePort()
        this.checkEnabled(generation)
        await server.configure({ ...this.config!, port }, context)
        this.checkEnabled(generation)
        if (server.state.status !== 'running') throw new Error('对应配置的 Codex 服务启动失败，请检查配置与 CLI 版本')
        return server.state.url
      } catch (error) {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        await server.close()
        throw error
      }
    })
    this.entries.set(key, entry)
    return entry.ready
  }
  async close(): Promise<void> {
    ++this.generation
    this.config = undefined
    const closing = this.stopInstances()
    const primary = this.primary.close()
    await this.queue
    await closing
    await primary
  }
  private checkEnabled(generation: number) {
    if (!this.config?.enabled || generation !== this.generation) throw new Error('托管服务已停止，请重新开启后再运行命令')
  }
  private async stopInstances() {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map(async entry => { await entry.server.close(); await entry.ready.catch(() => {}) }))
    this.changed()
  }
}

function validateRequest(value: unknown): CodexLaunchRequest {
  const request = value as CodexLaunchRequest | null
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
    request.profile !== undefined && !isCodexProfile(request.profile) ||
    typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd) || !statSync(request.cwd).isDirectory() ||
    !Array.isArray(request.overrides) || request.overrides.length > 128 || request.overrides.some(value => typeof value !== 'string' || value.includes('\0')) ||
    !request.env || typeof request.env !== 'object' || Array.isArray(request.env) ||
    Object.entries(request.env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')) ||
    request.env.CODEX_HOME && !path.isAbsolute(request.env.CODEX_HOME)) throw new Error('Codex 启动配置无效')
  return request
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}
