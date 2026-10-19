import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import WebSocket from 'ws'
import { canAutoRouteCodex, codexLaunchArguments, codexLaunchProfile, inspectCodexLaunch, type CodexLaunchRequest, type CodexLaunchRoute } from '../shared/codex-launch'
import { validateCodexUrl, validateCredentialName } from './config'

export interface CodexLaunchConfig { version: 1; executable: string; statusUrl: string; token: string }

export async function resolveCodexLaunch(args: readonly string[], file: string, env = process.env): Promise<string[]> {
  return (await resolveCodexLaunchPlan(args, file, env)).args
}

export async function resolveCodexLaunchPlan(args: readonly string[], file: string, env = process.env): Promise<{ args: string[]; notice?: string }> {
  const original = [...args]
  const fallback = { args: original }
  const profile = codexLaunchProfile(args)
  if (env.CUTE_ISLAND_CODEX_BYPASS === '1' || !canAutoRouteCodex(args, profile)) return fallback
  try {
    const config: CodexLaunchConfig = JSON.parse(readFileSync(file, 'utf8'))
    const status = new URL(config.statusUrl)
    if (config.version !== 1 || status.protocol !== 'http:' || status.hostname !== '127.0.0.1' || status.pathname !== '/v1/codex/launch' || status.username || status.password || status.search || status.hash || typeof config.token !== 'string' || config.token.length < 32) return fallback
    const response = await fetch(status, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1000), redirect: 'error' })
    if (!response.ok) return fallback
    let route: CodexLaunchRoute = await response.json()
    if (route.enabled !== true) return fallback
    if (route.managed) {
      const launch = inspectCodexLaunch(args)!
      const request: CodexLaunchRequest = { profile, cwd: path.resolve(launch.directory ?? process.cwd()), overrides: launch.overrides, env: nativeCodexEnvironment(env) }
      if (request.env.CODEX_HOME) request.env.CODEX_HOME = path.resolve(request.env.CODEX_HOME)
      try {
        const prepared = await fetch(status, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(20000), redirect: 'error' })
        if (!prepared.ok) throw new Error('服务启动失败')
        route = await prepared.json()
      } catch { return { ...fallback, notice: '灵动岛未接入：无法准备对应配置的服务，本次按原命令启动。请检查托管服务状态后重试。' } }
    }
    if (!route.enabled || typeof route.url !== 'string') return { ...fallback, ...(route.notice ? { notice: route.notice } : {}) }
    if (profile && route.profile !== profile) return { ...fallback, notice: '灵动岛未接入：已有外部服务无法自动加载此 profile，请启用应用内托管服务。本次按原命令启动。' }
    validateCodexUrl(route.url); validateCredentialName(route.tokenEnv)
    const token = route.tokenEnv ? env[route.tokenEnv] : undefined
    if (route.tokenEnv && !token) return fallback
    if (!await probeCodex(route.url, token)) return fallback
    return { args: codexLaunchArguments(args, route) }
  } catch { return fallback } // A stopped app or stale state restores native CLI behavior.
}

/** Environment values travel only over the authenticated loopback request, never into saved settings. */
export function nativeCodexEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result = { ...env }
  if (env.CUTE_ISLAND_CODEX_RUN_AS_NODE_SET !== undefined) {
    if (env.CUTE_ISLAND_CODEX_RUN_AS_NODE_SET === 'x') result.ELECTRON_RUN_AS_NODE = env.CUTE_ISLAND_CODEX_ORIGINAL_RUN_AS_NODE ?? ''
    else delete result.ELECTRON_RUN_AS_NODE
  }
  return Object.fromEntries(Object.entries(result).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('CUTE_ISLAND_CODEX_')))
}

function probeCodex(url: string, token?: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, handshakeTimeout: 750, maxPayload: 1024 * 1024 })
    let settled = false
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); resolve(ok) }
    const timer = setTimeout(() => finish(false), 1000)
    socket.on('error', () => finish(false)); socket.on('close', () => finish(false))
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cute_island_codex_launcher', version: '1.0.0' }, capabilities: { experimentalApi: true } } })))
    socket.on('message', bytes => { try { const message = JSON.parse(bytes.toString()); if (message.id === 1) finish(!!message.result && !message.error) } catch { finish(false) } })
  })
}

export async function runCodexLaunch(argv: readonly string[], stdout: (line: string) => void, env = process.env): Promise<number> {
  const [command, flag, file, separator, ...values] = argv
  const encoded = command === 'plan' && separator === '--args-base64' && values.length === 1
  if (!['plan', 'run'].includes(command) || flag !== '--config' || !file || separator !== '--' && !encoded) throw new Error('用法：codex-launch plan|run --config 文件 -- Codex 参数')
  const args: unknown = encoded ? JSON.parse(Buffer.from(values[0], 'base64').toString('utf8')) : values
  if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('Codex 参数必须是字符串数组')
  const plan = await resolveCodexLaunchPlan(args, file, env)
  if (command === 'plan') { stdout(JSON.stringify(plan)); return 0 }
  const routed = plan.args
  if (plan.notice) process.stderr.write(`${plan.notice}\n`)
  const config: CodexLaunchConfig = JSON.parse(readFileSync(file, 'utf8'))
  if (!path.isAbsolute(config.executable) || /\.(?:cmd|bat|ps1|js|mjs|cjs)$/i.test(config.executable)) throw new Error('Codex 原生程序路径无效')
  const childEnv = { ...env }
  if (env.CUTE_ISLAND_CODEX_RUN_AS_NODE_SET !== undefined) {
    if (env.CUTE_ISLAND_CODEX_RUN_AS_NODE_SET === 'x') childEnv.ELECTRON_RUN_AS_NODE = env.CUTE_ISLAND_CODEX_ORIGINAL_RUN_AS_NODE ?? ''
    else delete childEnv.ELECTRON_RUN_AS_NODE
  }
  delete childEnv.CUTE_ISLAND_CODEX_ORIGINAL_RUN_AS_NODE
  delete childEnv.CUTE_ISLAND_CODEX_RUN_AS_NODE_SET
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, routed, { stdio: 'inherit', env: childEnv, windowsHide: true })
    // The foreground process group also delivers Ctrl+C to Codex; let its TUI handle it.
    const interrupt = () => {}
    const terminate = () => child.kill('SIGTERM')
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('exit', code => { cleanup(); resolve(code ?? 1) })
  })
}
