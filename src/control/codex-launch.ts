import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import WebSocket from 'ws'
import { canAutoRouteCodex, codexLaunchArguments, type CodexLaunchRoute } from '../shared/codex-launch'
import { validateCodexUrl, validateCredentialName } from './config'

export interface CodexLaunchConfig { version: 1; executable: string; statusUrl: string; token: string }

export async function resolveCodexLaunch(args: readonly string[], file: string, env = process.env): Promise<string[]> {
  const original = [...args]
  if (env.CUTE_ISLAND_CODEX_BYPASS === '1' || !canAutoRouteCodex(args)) return original
  try {
    const config: CodexLaunchConfig = JSON.parse(readFileSync(file, 'utf8'))
    const status = new URL(config.statusUrl)
    if (config.version !== 1 || status.protocol !== 'http:' || status.hostname !== '127.0.0.1' || status.pathname !== '/v1/codex/launch' || status.username || status.password || status.search || status.hash || typeof config.token !== 'string' || config.token.length < 32) return original
    const response = await fetch(status, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1000), redirect: 'error' })
    if (!response.ok) return original
    const route: CodexLaunchRoute = await response.json()
    if (route.enabled !== true || typeof route.url !== 'string') return original
    validateCodexUrl(route.url); validateCredentialName(route.tokenEnv)
    const token = route.tokenEnv ? env[route.tokenEnv] : undefined
    if (route.tokenEnv && !token) return original
    if (!await probeCodex(route.url, token)) return original
    return codexLaunchArguments(args, route)
  } catch { return original } // A stopped app or stale state restores native CLI behavior.
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
  const routed = await resolveCodexLaunch(args, file, env)
  if (command === 'plan') { stdout(JSON.stringify({ args: routed })); return 0 }
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
