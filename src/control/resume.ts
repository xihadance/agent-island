import { activityId } from '../agents/parse'
import { listProcessSnapshot } from '../agents/processes'
import type { ActivityStore } from '../shared/activity'
import type { CodexAdapter } from './codex'
import { checkClaudeRecovery, ClaudeRecoveryRunner, findClaudeCommand } from './claude-resume'
import type { ControlHub } from './hub'
import { check } from './store'
import type { ControlSession, InterventionRequest, SessionResumer } from './types'

export class NativeSessionResumer implements SessionResumer {
  private closed = false
  private claude: ClaudeRecoveryRunner
  constructor(hub: ControlHub, private readonly activities: ActivityStore, private readonly codex: readonly CodexAdapter[], private readonly configFile?: string) {
    this.claude = new ClaudeRecoveryRunner((session, key) => {
      if (this.closed) return
      hub.store.create({ sourceKey: `claude-resume-error:${key}`, sessionId: session.id, origin: 'observation', kind: 'error',
        title: 'Claude Code 恢复执行后再次异常退出', detail: '请检查原会话日志；可在排除问题后再次选择继续会话。', questions: [],
        actions: hub.recoveryActions(session.id), expiresAt: hub.store.now() + 86400000 })
    })
  }
  available(session: ControlSession): boolean {
    if (session.agent === 'claude') return !!session.cwd && /^[a-f0-9-]{36}$/i.test(session.nativeId)
    return session.agent === 'codex' && this.codex.filter(connection => connection.acceptsRecovery(session)).length === 1
  }
  async prepare(session: ControlSession, text: string, request: InterventionRequest): Promise<() => Promise<void>> {
    check(!this.closed && this.available(session), '此会话没有唯一可用的恢复入口，请检查原生会话和接管配置', 409)
    const activity = this.activities.get(activityId(session.agent, session.nativeId))
    check(!activity || activity.state === 'error', '原会话已继续或已完成，异常通知已失效', 409)
    check(!activity || request.failureStartedAt === undefined || request.failureStartedAt === activity.startedAt, '原会话已进入新一轮，异常通知已失效', 409)
    if (session.agent === 'claude') {
      check(!this.claude.isRunning(session.nativeId), '此 Claude 会话的恢复进程仍在运行', 409)
      await checkClaudeRecovery(session, this.configFile)
      const command = findClaudeCommand()
      return () => this.claude.start(session, text, command)
    }
    if (!session.connectionId) {
      const snapshot = await listProcessSnapshot().catch(() => { throw new Error('无法检查 Codex 进程，请稍后重试') })
      check(!snapshot.processes.some(p => p.commandLine.includes(session.nativeId)), '原 Codex 会话进程仍在运行，请勿重复恢复', 409)
    }
    return this.codex.find(connection => connection.acceptsRecovery(session))!.prepareResume(session, text, request.turnId)
  }
  close(): void { this.closed = true; this.claude.close() }
}
