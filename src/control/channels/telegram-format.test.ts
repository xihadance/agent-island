import { expect, it } from 'vitest'
import type { ControlSession, InterventionRequest } from '../types'
import { telegramReply, telegramRequest } from './telegram-format'

const session: ControlSession = { id: 'codex-live', nativeId: 'native', agent: 'codex', label: 'Codex', adapter: 'codex', connected: true, capabilities: ['approve', 'answer', 'message'], lastSeenAt: 1 }
const request: InterventionRequest = { id: 'request123', sessionId: session.id, sourceKey: 'source', origin: 'codex', kind: 'approval', title: 'Codex 请求审批', detail: 'Get-Location', questions: [], actions: ['approve', 'deny', 'cancel'], status: 'pending', createdAt: 1, expiresAt: Date.now() + 60000, revision: 1 }

// Small independent checker for the subset emitted by the renderer. Escaped user
// content must never become a tag, and every outgoing message must stand alone.
function plain(html: string): string {
  const stack: string[] = []
  const text = html.replace(/<([^>]+)>/g, (_match, raw: string) => {
    if (raw.startsWith('/')) expect(stack.pop()).toBe(raw.slice(1))
    else {
      expect(['b', 'code', 'pre', 'blockquote', 'blockquote expandable']).toContain(raw)
      expect(stack).toHaveLength(0)
      stack.push(raw.split(' ')[0])
    }
    return ''
  })
  expect(stack).toHaveLength(0)
  expect(text).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/)
  const decoded = text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  expect(decoded.length).toBeLessThanOrEqual(4096)
  expect(Buffer.from(decoded).toString('utf8')).toBe(decoded)
  return decoded
}

it('renders readable approval content without turning command text into HTML or exposing credentials', () => {
  const detail = JSON.stringify({ command: 'echo "<b>test</b>" && npm test', cwd: 'D:/a&b', reason: 'Authorization: Bearer hidden-credential' })
  const html = telegramRequest({ ...request, detail }, session)
  expect(html).toContain('<b>审批请求 · 等待处理</b>')
  expect(html).toContain('<pre>echo &quot;&lt;b&gt;test&lt;/b&gt;&quot; &amp;&amp; npm test</pre>')
  expect(html).not.toContain('hidden-credential')
  expect(plain(html)).toContain('/send codex-live 内容')
})

it('makes observation limits explicit, removes duplicate commands, and hides unavailable guidance', () => {
  const html = telegramRequest({ ...request, origin: 'observation', title: 'Get-Location', detail: 'Get-Location\n仅通知；此事件没有可用的原生控制请求。', actions: ['ack'] }, { ...session, adapter: 'observation', connected: false, capabilities: [] })
  const text = plain(html)
  expect(html).toContain('<b>仅提醒 · 待查看</b>')
  expect(text.match(/Get-Location/g)).toHaveLength(1)
  expect(text).toContain('“知道了”只关闭提醒')
  expect(text).not.toContain('/send')
  expect(text).not.toContain('/approve')
  expect(text).not.toContain('codex · Codex')
  expect(plain(telegramRequest({ ...request, origin: 'observation', status: 'resolved' }, session))).toContain('已知悉')
})

it('keeps long notifications within one message with intact detail and guidance commands', () => {
  const html = telegramRequest({ ...request, title: '长标题🧪'.repeat(300), detail: JSON.stringify({ command: '<&>🧪'.repeat(1000), reason: '长说明'.repeat(1000) }), actions: ['answer'], questions: [
    { id: 'q1', text: '问题'.repeat(1000), options: ['<&>🧪'.repeat(45)], multi: true, freeText: true },
    { id: 'q2', text: '问题二', options: ['选项'], multi: false, freeText: false }
  ] }, { ...session, label: '项目'.repeat(100), id: 's'.repeat(200) })
  const text = plain(html)
  expect(html).toContain('<blockquote expandable>')
  expect(text).toContain(`/detail ${request.id}`)
  expect(text).toContain('/send codex-live 内容')
  expect(text).toContain('以上为摘要')
})

it('shows native questions once without repeating protocol JSON or advertising missing option buttons', () => {
  const questions = [{ id: 'q1', text: '描述期望结果', options: [], multi: false, freeText: true }]
  const text = plain(telegramRequest({ ...request, kind: 'input', actions: ['answer'], questions, detail: JSON.stringify({ threadId: 'internal-thread', questions }) }, session))
  expect(text.match(/描述期望结果/g)).toHaveLength(1)
  expect(text).not.toContain('internal-thread')
  expect(text).not.toContain('点击选项')
  expect(text).toContain('引用此消息直接回答')
})

it('splits full detail replies before HTML escaping without losing whitespace, entities, or emoji', () => {
  const body = '  <tag> & "value" 🧪\n'.repeat(1200)
  const result = telegramReply(`#request123\n完整命令\n${body}`, '/detail request123')
  expect(result.length).toBeGreaterThan(1)
  const reconstructed = result.map(plain).join('')
  expect(reconstructed).toBe(`完整命令\n请求 request123\n\n${body}`)
  expect(result[0]).toContain('<b>完整命令</b>')
  expect(result.every(page => page.includes('<pre>'))).toBe(true)
})

it('escapes ordinary replies and rejected commands without inventing successful details', () => {
  expect(plain(telegramReply('请求 <missing> & unavailable', '/detail unknown')[0])).toBe('请求 <missing> & unavailable')
  const text = '🧪'.repeat(5000) + '\n/answer request123 {"q1":["A&B"]}'
  expect(telegramReply(text).map(plain).join('')).toBe(text)
})
