import { homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from '../cli'
import { initRemoteConfig, readRemoteConfig, remoteExplicitlyDisabled, saveRemoteEnabled, type RemoteConfig } from './config'
import { check, record, uid } from './store'
import { hookDecision, hookPassthrough, type HookReply } from './hooks'
import type { Decision, Question } from './types'

interface Io { stdout: (line: string) => void; stderr: (line: string) => void; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; stdin?: () => Promise<string> }
export async function runRemoteCli(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv
  if (!command || ['help', '--help', '-h'].includes(command)) {
    io.stdout('接管命令：remote init | serve | enable | disable | status | send | respond | hook | hook-config\n通用选项：--config 文件\n接入说明：REMOTE_CONTROL.md')
    return 0
  }
  const args = parseArgs(rest)
  const env = io.env ?? process.env
  const file = path.resolve(args.config ?? env.CUTE_ISLAND_REMOTE_CONFIG ?? path.join(homedir(), '.cute-island', 'remote.json'))
  if (command === 'init') {
    initRemoteConfig(file)
    io.stdout(`已创建接管配置（默认关闭）：${file}\n请配置专用 Bot 和允许操作的用户 ID，然后运行 remote enable；文件中的 controlToken 仅供本机 Hook 使用。`)
    return 0
  }
  if (command === 'hook-config') {
    io.stdout(JSON.stringify(hookConfig(args.agent, file, args.cli ?? path.resolve('out/cli.cjs')), null, 2))
    return 0
  }
  if (command === 'hook') return runHook(args, file, io)
  const config = readRemoteConfig(file)
  check(config, '接管配置不存在，请先运行 remote init')
  const request = controlRequest(config, io.fetchImpl ?? fetch)
  if (command === 'enable' || command === 'disable' || command === 'status') {
    try {
      if (command === 'status') {
        const state = record(await request(''))
        io.stdout(JSON.stringify({ control: state.control, sessions: state.sessions, requests: state.requests, guidance: state.guidance }, null, 2))
      } else {
        const state = record(await request('/enabled', { enabled: command === 'enable' }))
        io.stdout(state.enabled ? '远程接管已开启' : '远程接管已关闭，后续人工介入交回原 Agent')
      }
    } catch (error) {
      if (!(error instanceof TypeError) || (error.cause as { code?: string } | undefined)?.code !== 'ECONNREFUSED') throw error
      if (command !== 'status') saveRemoteEnabled(file, command === 'enable')
      if (command === 'disable') {
        const { ControlStore } = await import('./store')
        new ControlStore(config.stateFile).releaseControl()
      }
      io.stdout(JSON.stringify({ control: { enabled: command === 'status' ? config.enabled !== false : command === 'enable', running: false },
        message: command === 'enable' ? '已保存开启设置；启动桌面应用或 remote serve 后生效' : '接管服务未运行，当前开关设置已保留' }, null, 2))
    }
    return 0
  }
  if (command === 'send') { io.stdout(JSON.stringify(await request('/messages', { sessionId: args.session, text: args.text }))); return 0 }
  if (command === 'respond') {
    const decision: Decision = { action: args.action as Decision['action'], ...(args.answers ? { answers: JSON.parse(args.answers) } : {}) }
    io.stdout(JSON.stringify(await request(`/requests/${encodeURIComponent(args.id)}/respond`, { revision: Number(args.revision), decision })))
    return 0
  }
  if (command === 'serve') {
    const [{ ActivityStore }, { startStatusServer }, { createControlRuntime }, { SessionWatcher }] = await Promise.all([import('../shared/activity'), import('../main/server'), import('./runtime'), import('../agents/watch')])
    const activities = new ActivityStore()
    const control = createControlRuntime(config, activities, { configFile: file })
    const server = await startStatusServer(activities, { port: config.port, token: env.CUTE_ISLAND_TOKEN, control })
    const watcher = new SessionWatcher(activities)
    if (env.CUTE_ISLAND_WATCH !== '0') watcher.start()
    try { await control.start() } catch (error) { io.stderr(error instanceof Error ? error.message : '接管启动失败') }
    io.stderr(`本机控制服务已启动：127.0.0.1:${server.port} · 远程接管${control.status().running ? '已开启' : '未运行，可用 remote enable 开启'}`)
    await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    watcher.stop(); control.close(); activities.dispose(); await server.close()
    return 0
  }
  throw new Error('remote 子命令：init、serve、enable、disable、status、send、respond、hook、hook-config')
}

function controlRequest(config: RemoteConfig, fetchImpl: typeof fetch) {
  return async (endpoint: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`http://127.0.0.1:${config.port}/v1/control${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.controlToken}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    const result = await response.json()
    if (!response.ok) throw new Error((result as { error?: string }).error ?? '接管请求失败')
    return result
  }
}

async function runHook(args: Record<string, string>, file: string, io: Io): Promise<number> {
  const event = record(JSON.parse(await (io.stdin ?? readStdin)()))
  if (args.event) event.hook_event_name = args.event
  const release = (): number => { io.stdout(JSON.stringify(hookPassthrough(args.agent, event))); return 0 }
  if (remoteExplicitlyDisabled(file)) return release()
  const invocationId = uid()
  try {
    const config = readRemoteConfig(file)
    check(config, '接管配置不存在')
    const request = controlRequest(config, io.fetchImpl ?? fetch)
    const reply = await request('/hook', { agent: args.agent, invocationId, event }) as HookReply
    if (remoteExplicitlyDisabled(file)) return release()
    if (reply.output) { io.stdout(JSON.stringify(reply.output)); return 0 }
    check(reply.requestId && reply.deadline, 'Hook 响应无效')
    while (Date.now() < reply.deadline) {
      if (remoteExplicitlyDisabled(file)) return release()
      const result = await request(`/requests/${reply.requestId}?invocation=${invocationId}`) as { status: string; released?: boolean; decision?: Decision; questions?: Question[] }
      if (result.released || remoteExplicitlyDisabled(file)) return release()
      if (result.decision) { io.stdout(JSON.stringify(hookDecision(args.agent, event, result.decision, result.questions))); return 0 }
      if (['expired', 'cancelled', 'uncertain', 'resolved'].includes(result.status)) break
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    io.stdout(JSON.stringify(hookDecision(args.agent, event, undefined)))
    return 0
  } catch {
    if (remoteExplicitlyDisabled(file)) return release()
    // A command-hook crash must not turn into the host's default fail-open path.
    io.stdout(JSON.stringify(hookDecision(args.agent, event, undefined)))
    io.stderr('远程接管不可用，本次操作未获批准')
    return 0
  }
}
async function readStdin(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) { text += chunk.toString(); check(text.length <= 1000000, 'Hook 输入过大') }
  return text
}
export function hookConfig(agent: string, config: string, cli: string): unknown {
  check(['claude', 'cursor', 'gemini'].includes(agent), '请选择 claude、cursor 或 gemini')
  check(!/[\r\n"`$%]/.test(config + cli + process.execPath), '路径含有不支持的 Shell 字符')
  const command = `"${process.execPath}" "${path.resolve(cli)}" remote hook --agent ${agent} --config "${config}"`
  const names = agent === 'claude' ? ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'Elicitation', 'SessionEnd']
    : agent === 'cursor' ? ['sessionStart', 'beforeShellExecution', 'beforeMCPExecution', 'postToolUse', 'postToolUseFailure', 'stop', 'sessionEnd']
      : ['SessionStart', 'BeforeTool', 'BeforeAgent', 'AfterTool', 'Notification', 'SessionEnd']
  const hooks: Record<string, unknown[]> = {}
  for (const name of names) hooks[name] = agent === 'cursor' ? [{ command: `${command} --event ${name}`, timeout: 330, failClosed: true }]
    : [{ matcher: '', hooks: [{ type: 'command', command: `${command} --event ${name}`, timeout: agent === 'gemini' ? 330000 : 330 }] }]
  if (agent === 'claude') hooks.PreToolUse = [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: `${command} --event PreToolUse`, timeout: 330 }] }]
  return agent === 'cursor' ? { version: 1, hooks } : { hooks }
}
