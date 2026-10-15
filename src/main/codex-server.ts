import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import os from 'node:os'
import WebSocket from 'ws'
import type { Preferences, SettingsSnapshot } from '../shared/preferences'

/** Locate the native binary, including npm installations, without executing a shell shim. */
export function findCodexExecutable(configured = '', env = process.env): string {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const platform = `${process.platform}-${process.arch}`
  const target = ({ 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
    'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' } as Record<string, string>)[platform]
  const native = (file: string): boolean => { try { accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true } catch { return false } }
  if (configured) {
    if (!path.isAbsolute(configured) || /\.(?:cmd|bat|ps1|js|mjs|cjs)$/i.test(configured) || !native(configured)) throw new Error('请选择 Codex 原生可执行文件（Windows 为 codex.exe），或留空自动检测')
    return configured
  }
  const dirs = [...(env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean)
  for (const dir of dirs) {
    const direct = path.join(dir, `codex${suffix}`)
    const roots = [path.join(dir, 'node_modules', '@openai', 'codex'), path.resolve(dir, '../lib/node_modules/@openai/codex')]
    try { roots.unshift(path.resolve(realpathSync(path.join(dir, 'codex')), '../..')) } catch { /* Not an npm executable. */ }
    for (const root of roots) {
      const vendors = [path.join(root, 'vendor'), path.join(root, 'node_modules', '@openai', `codex-${platform}`, 'vendor'), path.join(root, '..', `codex-${platform}`, 'vendor')]
      for (const vendor of vendors) for (const folder of ['bin', 'codex']) {
        const candidate = path.join(vendor, target ?? '', folder, `codex${suffix}`)
        if (native(candidate)) return candidate
      }
    }
    // Native standalone installations have no npm wrapper or child launcher.
    if (native(direct) && (suffix || !existsSync(path.join(path.resolve(direct, '../..'), 'package.json')))) {
      const resolved = realpathSync(direct)
      if (!/\.(?:js|mjs|cjs)$/.test(resolved)) return resolved
    }
  }
  throw new Error('未找到 Codex CLI。请先安装并登录 Codex，或填写原生程序路径')
}

export class ManagedCodexServer {
  state: SettingsSnapshot['codexServer'] = { status: 'stopped', url: '', detail: '' }
  private child?: ChildProcess
  private socket?: WebSocket
  private generation = 0
  private key = ''
  private queue: Promise<void> = Promise.resolve()
  constructor(private changed: () => void, private launch = (exe: string, args: string[]) => spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), private resolve = findCodexExecutable) {}

  configure(config: Preferences['codexServer']): Promise<void> {
    const key = JSON.stringify(config)
    if (key === this.key) return this.queue
    this.key = key
    const generation = ++this.generation
    this.socket?.terminate()
    this.queue = this.queue.then(async () => {
      await this.stopChild()
      if (generation !== this.generation) return
      if (!config.enabled) { this.set('stopped', '', '服务已停止'); return }
      const url = `ws://127.0.0.1:${config.port}`
      this.set('starting', url, '正在启动本机 Codex 服务…')
      try {
        const executable = this.resolve(config.executable)
        await this.checkPort(config.port)
        if (generation !== this.generation) return
        const child = this.launch(executable, ['app-server', '--listen', url])
        this.child = child
        child.stdout?.resume(); child.stderr?.resume()
        let failed = false
        child.on('error', () => { failed = true })
        child.on('exit', () => {
          failed = true
          if (this.child === child && generation === this.generation) {
            this.child = undefined
            this.set('error', url, 'Codex 服务已退出，请检查 CLI 登录与版本后重新启动')
          }
        })
        const deadline = Date.now() + 12000
        while (generation === this.generation && !failed && Date.now() < deadline) {
          if (await this.probe(url)) {
            if (generation === this.generation && !failed) this.set('running', url, '服务已启动。使用下方命令连接 Codex CLI 后，再开启自动审批')
            return
          }
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        if (generation !== this.generation) return
        throw new Error('Codex 服务未能就绪，请检查 CLI 版本、登录状态和程序路径')
      } catch (error) {
        await this.stopChild()
        if (generation === this.generation) this.set('error', url, error instanceof Error ? error.message : 'Codex 服务启动失败')
      }
    })
    return this.queue
  }
  async close(): Promise<void> {
    ++this.generation; this.socket?.terminate()
    await this.queue
    await this.stopChild()
    this.key = ''; this.set('stopped', '', '服务已停止')
  }
  private set(status: SettingsSnapshot['codexServer']['status'], url: string, detail: string) { this.state = { status, url, detail }; this.changed() }
  private checkPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', () => reject(new Error(`端口 ${port} 已被占用，请更换端口或连接已有服务`)))
      server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()))
    })
  }
  private probe(url: string): Promise<boolean> {
    return new Promise(resolve => {
      const socket = new WebSocket(url, { handshakeTimeout: 500 })
      this.socket = socket
      let settled = false
      const finish = (result: boolean) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); if (this.socket === socket) this.socket = undefined; resolve(result) }
      const timer = setTimeout(() => finish(false), 1000)
      socket.on('error', () => finish(false)); socket.on('close', () => finish(false))
      socket.on('open', () => socket.send(JSON.stringify({ id: 'health', method: 'initialize', params: { clientInfo: { name: 'cute_island_health', version: '1.0.0' }, capabilities: { experimentalApi: true } } })))
      socket.on('message', data => { try { const result = JSON.parse(data.toString()); if (result.id === 'health') finish(!!result.result && !result.error) } catch { finish(false) } })
    })
  }
  private async stopChild(): Promise<void> {
    const child = this.child; this.child = undefined
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill()
    })
  }
}
