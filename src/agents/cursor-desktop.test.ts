import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'

const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n')

/**
 * Cursor desktop records assistant messages without tool ids and without
 * tool_result rows, and asks for approval through `request_smart_mode_approval`.
 * Without both of those, a stale first call stayed the headline and the pending
 * question or approval was reported as an interruption.
 */
describe('Cursor desktop transcripts', () => {
  const assistant = (...content: unknown[]) => ({ role: 'assistant', message: { content } })
  const text = (value: string) => ({ type: 'text', text: value })
  const tool = (name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', name, input })
  const shell = (command: string, extra: Record<string, unknown> = {}) =>
    tool('Shell', { command, description: command, required_permissions: ['all'], ...extra })
  const push = shell('git push origin main', { request_smart_mode_approval: true, smart_mode_block_reason: '推送到远端仓库' })
  const question = tool('AskQuestion', {
    title: '选择要迁移的项目',
    questions: [{ id: 'private', prompt: '私有仓库要迁移哪些？', allow_multiple: true, options: [{ id: 'a', label: 'php/business' }] }]
  })
  const user = (query: string) => ({
    role: 'user',
    message: { content: [text(`<timestamp>Friday, Oct 9, 2026, 6:16 PM (UTC+8)</timestamp>\n<user_query>\n${query}\n</user_query>`)] }
  })

  it('retires id-less calls so the newest tool is the headline', () => {
    const view = parseTranscript('cursor', 'anon', jsonl([
      assistant(shell('npm install')),
      assistant(shell('npm test')),
      assistant(tool('Read', { path: 'src/main/index.ts' }))
    ]))
    expect(view).toMatchObject({ state: 'running', title: '读取文件 index.ts', terminal: false })
    expect(view?.steps.filter((step) => step.status === 'active')).toHaveLength(1)
  })

  it('reads request_smart_mode_approval as an approval with its block reason', () => {
    const view = parseTranscript('cursor', 'approve', jsonl([assistant(push)]))
    expect(view).toMatchObject({
      state: 'approval',
      title: 'git push origin main',
      detail: '推送到远端仓库',
      operation: { kind: 'command', command: 'git push origin main' },
      terminal: false
    })
  })

  it('keeps an approval through commentary and clears it once a tool follows', () => {
    const rows = [assistant(push), assistant(text('这一步会把本地提交推到远端，确认后继续。'))]
    expect(parseTranscript('cursor', 'approve', jsonl(rows))).toMatchObject({ state: 'approval', detail: '推送到远端仓库' })

    const resumed = parseTranscript('cursor', 'approve', jsonl([...rows, assistant(shell('git log --oneline -1'))]))
    expect(resumed).toMatchObject({ state: 'running', title: 'git log --oneline -1' })
    expect(resumed?.state).not.toBe('approval')
  })

  it('keeps an unanswered question ahead of an earlier call, then clears it on the answer', () => {
    const rows = [assistant(shell('ls')), assistant(text('下面这些项目可以迁移。'), question)]
    const asking = parseTranscript('cursor', 'ask', jsonl(rows))
    expect(asking).toMatchObject({ state: 'running', title: '私有仓库要迁移哪些？', operation: { name: 'AskQuestion' }, terminal: false })

    // Commentary alone may still be the agent explaining while the user decides.
    expect(parseTranscript('cursor', 'ask', jsonl([...rows, assistant(text('选好后我就开始。'))])))
      .toMatchObject({ title: '私有仓库要迁移哪些？', operation: { name: 'AskQuestion' } })

    const answered = parseTranscript('cursor', 'ask', jsonl([...rows, assistant(text('选好后我就开始。')), assistant(shell('git clone a'))]))
    expect(answered).toMatchObject({ state: 'running', title: 'git clone a' })
    expect(answered?.operation?.name).not.toBe('AskQuestion')
  })

  it('still reports a real abort, even with a question or approval pending', () => {
    const abort = { type: 'turn_ended', status: 'error', error: 'User aborted request' }
    expect(parseTranscript('cursor', 'abort', jsonl([assistant(shell('npm install')), abort])))
      .toMatchObject({ state: 'error', title: 'User aborted request', terminal: true })
    expect(parseTranscript('cursor', 'abort', jsonl([assistant(question), abort])))
      .toMatchObject({ state: 'error', title: 'User aborted request', terminal: true })
    expect(parseTranscript('cursor', 'abort', jsonl([assistant(push), abort])))
      .toMatchObject({ state: 'error', terminal: true })
  })

  it('does not carry a settled turn into the next user round', () => {
    const view = parseTranscript('cursor', 'turns', jsonl([
      assistant(push),
      { type: 'turn_ended', status: 'success' },
      user('再加一个图标'),
      assistant(shell('npm run build'))
    ]))
    expect(view).toMatchObject({ state: 'running', title: 'npm run build', terminal: false })
    expect(view?.state).not.toBe('approval')
  })

  it('keeps required_permissions and smart mode off the approval path when not requested', () => {
    expect(parseTranscript('cursor', 'plain', jsonl([assistant(shell('npm test'))])))
      .toMatchObject({ state: 'running', title: 'npm test' })
    expect(parseTranscript('cursor', 'plain', jsonl([assistant(shell('npm test', { request_smart_mode_approval: false }))]))?.state)
      .toBe('running')
  })
})
