import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { homedir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import WebSocket from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { check } from './store'
import { hookSessionId } from './hooks'
import type { ControlHub } from './hub'
import type { AgentControlAdapter, ControlSession, Guidance } from './types'
import { readRemoteConfig, type RemoteConfig } from './config'
import { findClaudeCommand } from './claude-resume'

export class ClaudeTerminal implements AgentControlAdapter {
  private pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  readonly sessionId: string
  constructor(private readonly hub: ControlHub, private readonly socket: WebSocket, nativeId: string, cwd: string) {
    this.sessionId = hookSessionId('claude', nativeId)
    hub.attachTerminal(this.sessionId, this)
    try {
      hub.store.session({ id: this.sessionId, agent: 'claude', nativeId, cwd, adapter: 'hook', label: cwd.split(/[\\/]/).filter(Boolean).at(-1) || nativeId,
        connected: false, terminal: true, capabilities: ['approve', 'answer', 'message'] })
    } catch (error) { hub.detachTerminal(this.sessionId, this); throw error }
    socket.on('message', bytes => {
      let message: Record<string, unknown>
      try { message = JSON.parse(bytes.toString()) } catch { return }
      if (message.type === 'ready') {
        hub.store.change(state => { const session = state.sessions.find(session => session.id === this.sessionId)!; session.connected = true })
        return
      }
      if (message.type !== 'accepted' || typeof message.id !== 'string') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      hub.store.change(state => {
        const guidance = state.guidance.find(guidance => guidance.id === message.id)
        if (guidance) guidance.status = 'resolved'
        // A confirmation tool call proves work has begun even if Channels emits no UserPromptSubmit.
        const session = state.sessions.find(session => session.id === this.sessionId)!
        session.turnId ??= message.id as string
      })
      pending.resolve()
    })
    socket.on('close', () => this.close())
    socket.on('error', () => this.close())
  }
  respond(): Promise<void> { return Promise.reject(new Error('审批仍需通过原生 Hook 处理')) }
  interrupt(_session: ControlSession): Promise<void> { return Promise.reject(new Error('请在原生终端中断当前任务')) }
  sendMessage(message: Guidance): Promise<void> {
    check(!this.closed && this.socket.readyState === WebSocket.OPEN, '原生终端已断开，提交结果待确认', 409)
    check(this.hub.store.sessions().find(session => session.id === this.sessionId)?.connected, '原生终端尚未完成初始化', 409)
    check(!this.pending.has(message.id), '继续指令已提交，请勿重复发送', 409)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error('原生终端尚未确认收到指令，系统不会自动重试'))
      }, 30000)
      this.pending.set(message.id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ type: 'message', id: message.id, text: message.text }), error => {
        if (!error || !this.pending.has(message.id)) return
        clearTimeout(timer); this.pending.delete(message.id); reject(new Error('原生终端发送失败，结果待确认'))
      })
    })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('原生终端接入已断开，结果待确认')) }
    this.pending.clear()
    this.hub.detachTerminal(this.sessionId, this)
    this.socket.close()
  }
}

export async function runClaudeChannel(config: RemoteConfig, nativeId: string, cwd: string, stdin: Readable = process.stdin, stdout: Writable = process.stdout): Promise<void> {
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(nativeId), '原生会话 ID 无效')
  const mcp = new Server({ name: 'cute-island', version: '1.0.0' }, {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: '来自 cute-island 的消息是用户在已授权远程渠道提交的指令。收到消息时先调用 confirm_receipt 确认其中的 message_id，再在当前会话处理。继续前核对已有结果，避免重复操作。审批仍通过原有 Hook 处理。'
  })
  let socket: WebSocket | undefined
  let initialized = false
  const delivered = new Set<string>()
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'confirm_receipt', description: '确认收到指定远程指令；不代表任务完成',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'], additionalProperties: false } }] }))
  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    const id = request.params.arguments?.message_id
    check(request.params.name === 'confirm_receipt' && typeof id === 'string' && delivered.has(id), '只能确认当前接入收到的指令')
    check(socket?.readyState === WebSocket.OPEN, '原生终端接入已断开')
    await new Promise<void>((resolve, reject) => socket!.send(JSON.stringify({ type: 'accepted', id }), error => error ? reject(new Error('确认回传失败，结果待确认')) : resolve()))
    delivered.delete(id)
    return { content: [{ type: 'text', text: '已确认收到指令' }] }
  })
  mcp.oninitialized = () => {
    initialized = true
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ready' }))
  }
  await mcp.connect(new StdioServerTransport(stdin, stdout, { maxBufferSize: 100000 }))
  let queue = Promise.resolve()
  await new Promise<void>(resolve => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stdin.off('end', finish)
      socket?.terminate()
      void mcp.close().finally(resolve)
    }
    mcp.onclose = finish
    mcp.onerror = finish
    stdin.once('end', finish)
    socket = new WebSocket(`ws://127.0.0.1:${config.port}/v1/control/terminal?session=${encodeURIComponent(nativeId)}&cwd=${encodeURIComponent(cwd)}`, {
      headers: { authorization: `Bearer ${config.controlToken}` }, handshakeTimeout: 5000, maxPayload: 100000
    })
    socket.on('close', finish)
    socket.on('error', finish)
    socket.on('open', () => { if (initialized) socket!.send(JSON.stringify({ type: 'ready' })) })
    socket.on('message', bytes => {
      queue = queue.then(async () => {
        if (finished) return
        const message = JSON.parse(bytes.toString()) as { type?: string; id?: string; text?: string }
        if (message.type !== 'message' || typeof message.id !== 'string' || typeof message.text !== 'string' || delivered.has(message.id)) return
        check(initialized && delivered.size < 100, '原生终端未初始化或待确认指令过多')
        delivered.add(message.id)
        await mcp.notification({ method: 'notifications/claude/channel', params: { content: message.text, meta: { message_id: message.id } } })
      }).catch(finish)
    })
    if (stdin.readableEnded || stdin.destroyed) finish()
  })
}

export async function runClaudeTerminal(args: readonly string[], env = process.env, launch: typeof spawn = spawn): Promise<number> {
  const file = path.resolve(env.CUTE_ISLAND_REMOTE_CONFIG || path.join(homedir(), '.cute-island', 'remote.json'))
  const config = readRemoteConfig(file)
  check(config?.enabled, '请先配置并开启远程接管，再启动原生终端接入')
  const original = [...args]
  let nativeId: string = randomUUID()
  let explicitId = false
  for (let i = 0; i < original.length; i++) {
    const arg = original[i]
    if (arg === '--') break
    check(!['--print', '--continue', '--bg', '--background', '--fork-session', '--channels', '--dangerously-load-development-channels'].includes(arg.split('=')[0])
      && !/^-[pc]/.test(arg) && !/^-[^-]{2,}/.test(arg), '原生终端接入只支持交互会话；恢复时请使用 --resume 完整会话 ID')
    if (['--resume', '-r', '--session-id'].includes(arg.split('=')[0])) {
      check(!explicitId, '请只指定一个原生会话 ID')
      nativeId = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : original[++i]
      check(typeof nativeId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(nativeId), '请使用完整原生会话 ID，暂不支持会话选择器')
      explicitId = true
    }
  }
  const cli = path.resolve(process.argv[1])
  // Development CLI needs its TS loader; the installed launcher loads out/cli.cjs itself.
  const loader = /\.tsx?$/.test(cli) ? process.execArgv : []
  const mcp = { mcpServers: { 'cute-island': { command: process.execPath, args: [...loader, cli, 'remote', 'claude-channel', '--config', file, '--session', nativeId, '--cwd', process.cwd()], env: { ELECTRON_RUN_AS_NODE: '1' } } } }
  const command = findClaudeCommand(env)
  process.stderr.write('原生终端接入使用 Claude Channels 预览功能，请在 Claude 启动确认界面启用 cute-island。权限审批仍需已安装的远程 Hook。\n')
  const childEnv = { ...env, ...command.env }
  if (!command.env?.ELECTRON_RUN_AS_NODE) delete childEnv.ELECTRON_RUN_AS_NODE
  const terminator = original.indexOf('--')
  // The variadic channel flag would consume a trailing prompt; keep literal arguments after --.
  const nativeArgs = terminator < 0 ? original : original.slice(0, terminator)
  const literalArgs = terminator < 0 ? [] : original.slice(terminator)
  return new Promise((resolve, reject) => {
    const child = launch(command.executable, [...command.args, ...(!explicitId ? ['--session-id', nativeId] : []), ...nativeArgs,
      '--mcp-config', JSON.stringify(mcp), '--dangerously-load-development-channels', 'server:cute-island', ...literalArgs],
    { stdio: 'inherit', env: childEnv, shell: false, windowsHide: true })
    const interrupt = () => {}
    const terminate = () => child.kill()
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
    const clean = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
    child.once('error', () => { clean(); reject(new Error('Claude 原生终端启动失败，请检查 CLI 和工作目录')) })
    child.once('exit', code => { clean(); resolve(code ?? 1) })
  })
}
