import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { claudePlugin } from '../agents/plugins/claude'
import { listProcessSnapshot, matchAgentProcesses, registrationMatchesProcess } from '../agents/processes'
import { parseTranscript } from '../agents/parse'
import { presentSession } from '../agents/watch'
import { check } from './store'
import type { ControlSession } from './types'

export interface ClaudeCommand { executable: string; args: string[]; env?: NodeJS.ProcessEnv }
export function findClaudeCommand(env = process.env): ClaudeCommand {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const dirs = [...(env.PATH ?? '').split(path.delimiter), path.join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(dir => path.isAbsolute(dir))
  for (const dir of dirs) {
    const roots = [path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code'), path.resolve(dir, '../lib/node_modules/@anthropic-ai/claude-code')]
    for (const file of [path.join(dir, `claude${suffix}`), ...roots.map(root => path.join(root, 'bin', `claude${suffix}`))]) {
      try {
        accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        const resolved = realpathSync(file)
        if (!/\.(?:cmd|bat|ps1|js|cjs|mjs)$/i.test(resolved)) return { executable: resolved, args: [] }
      } catch { /* Try the next installed executable. */ }
    }
    // Older npm releases ship JavaScript; use Node directly, never an interpolated shell shim.
    for (const root of roots) {
      const script = path.join(root, 'cli.js')
      try {
        accessSync(script, constants.R_OK)
        return { executable: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } }
      } catch { /* Not an older npm installation. */ }
    }
  }
  throw new Error('未找到 Claude Code CLI，请先安装并登录，然后重启灵动岛')
}

export async function checkClaudeRecovery(session: ControlSession, configFile?: string, env = process.env): Promise<void> {
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session.nativeId), 'Claude 原生会话 ID 无效')
  check(session.cwd && path.isAbsolute(session.cwd) && await stat(session.cwd).then(info => info.isDirectory(), () => false), '原会话工作目录不存在')
  const root = claudePlugin.defaultRoot(homedir(), env)
  const snapshot = await listProcessSnapshot([claudePlugin]).catch(() => { throw new Error('无法检查 Claude 进程，请稍后重试') })
  const byPid = new Map(snapshot.processes.map(p => [p.pid, p]))
  const registrations = await claudePlugin.registeredSessions!(root)
  // A crashed CLI leaves its registration behind, and a recycled PID makes it look alive forever.
  // Trust the registry only while that PID is still the same claude process, exactly as the watcher does.
  const holders = registrations.filter(s => s.sessionId === session.nativeId && registrationMatchesProcess(byPid, claudePlugin, s.pid, s.updatedAt))
  // Only a busy holder proves the session is executing. A closed VS Code conversation keeps its idle
  // peer process alive, and the watcher reads idle registrations as inactive for the same reason.
  check(!holders.some(s => s.busy), '原 Claude 会话正在运行中，请先结束当前任务再恢复', 409)
  // The idle holder's command line still carries the resume id. Skip known holders and count only
  // an agent-shaped process elsewhere as a competing recovery.
  const holderPids = new Set(holders.map(s => s.pid))
  check(!snapshot.processes.some(p => !holderPids.has(p.pid) && p.commandLine.includes(session.nativeId)
    && matchAgentProcesses(p.commandLine || p.name, [claudePlugin]).has(claudePlugin.kind)),
    '原 Claude 会话进程仍在运行，请勿重复恢复', 409)
  let transcript: string | undefined
  let transcriptMtime = 0
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => { throw new Error('无法读取 Claude 会话目录，请检查安装和文件权限') })) {
    if (!dir.isDirectory()) continue
    const file = path.join(root, dir.name, `${session.nativeId}.jsonl`)
    try {
      const fd = await open(file, 'r')
      try {
        const { size, mtimeMs } = await fd.stat()
        const start = Math.max(0, size - 512 * 1024)
        const buffer = Buffer.alloc(size - start)
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, start)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        transcript = start ? text.slice(text.indexOf('\n') + 1) : text
        transcriptMtime = mtimeMs
      } finally { await fd.close() }
      break
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取原 Claude 会话记录，请检查文件权限') }
  }
  const view = transcript && parseTranscript('claude', session.nativeId, transcript)
  // A turn that went silent with no live process is what the watcher reports as interrupted;
  // reuse its rule so the recovery gate and that notification can never disagree.
  check(!!view && view.sessionId === session.nativeId && presentSession(view, false, Date.now() - transcriptMtime, true)?.state === 'error',
    '原 Claude 会话已继续、已完成、已退出或无法确认中断状态', 409)
  check(!view.cwd || path.resolve(view.cwd) === path.resolve(session.cwd), '原会话工作目录已变化，请在本机确认后恢复', 409)
  let settings: Record<string, any>
  try { settings = JSON.parse(readFileSync(path.join(root, '..', 'settings.json'), 'utf8')) }
  catch { throw new Error('请先在远程接管设置中安装 Claude Code Hook') }
  check(configFile && ['PermissionRequest', 'PreToolUse'].every(event => Array.isArray(settings?.hooks?.[event]) && settings.hooks[event].some((group: any) =>
    Array.isArray(group?.hooks) && group.hooks.some((hook: any) => typeof hook?.command === 'string' && hook.command.includes(configFile) && /remote.*hook|cute-island-remote-hook/.test(hook.command)))),
  '请先安装指向当前接管配置的 Claude Code Hook')
}

export class ClaudeRecoveryRunner {
  private children = new Map<ChildProcess, { nativeId: string; cancel: () => void }>()
  private closed = false
  constructor(private readonly failed: (session: ControlSession, key: string) => void,
    private readonly launch: (exe: string, args: string[], options: SpawnOptions) => ChildProcess = spawn) {}
  isRunning(nativeId: string): boolean { return [...this.children.values()].some(child => child.nativeId === nativeId) }
  start(session: ControlSession, text: string, command: ClaudeCommand): Promise<void> {
    check(!this.closed, '远程接管已停用', 409)
    return new Promise((resolve, reject) => {
      const child = this.launch(command.executable, [...command.args, '--resume', session.nativeId, '--print', '--input-format', 'stream-json',
        '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-mode', 'default'],
      { cwd: session.cwd, env: { ...process.env, ...command.env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      let accepted = false
      let finished = false
      let resultFailed = false
      const timer = setTimeout(() => finish(new Error('Claude 未及时确认继续指令，请检查原会话')), 30000)
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      this.children.set(child, { nativeId: session.nativeId, cancel: () => finish(new Error('远程接管已停止')) })
      child.stderr?.resume()
      child.stdin?.on('error', () => finish(new Error('无法向 Claude 提交继续指令')))
      child.once('error', () => { this.children.delete(child); finish(new Error('Claude 恢复进程启动失败，请检查 CLI 和工作目录')) })
      child.once('close', code => {
        this.children.delete(child)
        if (this.closed) { finish(new Error('远程接管已停止')); return }
        if (!accepted) finish(new Error('Claude 未确认恢复原会话，请检查登录、版本和会话日志'))
        if (code !== 0 || resultFailed) {
          try { this.failed(session, `${child.pid ?? 'unknown'}:${Date.now()}`) }
          catch { console.error('Claude 恢复异常记录失败，请检查会话日志和状态文件') }
        }
      })
      child.stdout?.on('data', (chunk: Buffer) => {
        if (this.closed) return
        buffer += decoder.write(chunk)
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          let row: Record<string, any>
          try { row = JSON.parse(line) } catch { continue }
          if (!row || typeof row !== 'object' || row.session_id !== session.nativeId) continue
          const content = row.message?.content
          const replay = row.type === 'user' && (content === text || Array.isArray(content) && content.some((part: any) => part?.type === 'text' && part.text === text))
          if (row.type === 'result') resultFailed = row.is_error === true
          if (replay || row.type === 'result') { accepted = true; finish() }
        }
        if (buffer.length > 2 * 1024 * 1024) { finish(new Error('Claude 返回内容过大，恢复结果待确认')); child.kill() }
      })
      child.once('spawn', () => {
        if (this.closed) { child.kill(); return }
        child.stdin?.end(JSON.stringify({ type: 'user', session_id: session.nativeId, message: { role: 'user', content: text }, parent_tool_use_id: null }) + '\n')
      })
    })
  }
  close(): void { this.closed = true; for (const [child, state] of this.children) { state.cancel(); child.kill() } }
}
