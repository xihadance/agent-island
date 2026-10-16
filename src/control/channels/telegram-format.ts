import { redact } from '../hub'
import { STATUS_LABEL, type ControlSession, type InterventionRequest } from '../types'

type Tag = 'b' | 'code' | 'pre' | 'blockquote' | 'blockquote expandable'
interface Part { text: string; tag?: Tag }
const LIMIT = 3900 // Telegram allows 4096 characters after parsing entities.
const observationSuffix = '\n仅通知；此事件没有可用的原生控制请求。'
const names = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' }
const kinds = { approval: '审批请求', plan: '方案确认', input: '需要回答', error: '执行异常', authentication: '需要认证', terminal: '终端提醒' }

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function prefix(text: string, size: number): string {
  // Never split an emoji's UTF-16 surrogate pair.
  const end = size < text.length && /[\uD800-\uDBFF]/.test(text[size - 1] ?? '') ? size - 1 : size
  return text.slice(0, end)
}
function clip(text: string, size: number): string {
  return text.length > size ? `${prefix(text, size - 1)}…` : text
}
function part(text: string, tag?: Tag): Part { return { text: redact(text), tag } }

/** Split plain content before escaping, then close every tag within its own message. */
function pages(parts: Part[]): string[] {
  const result: string[] = []
  let page = '', length = 0
  for (const { text, tag } of parts) {
    let remaining = text
    while (remaining) {
      let chunk = prefix(remaining, LIMIT - length)
      if (!chunk) { result.push(page); page = ''; length = 0; continue }
      if (chunk.length < remaining.length) {
        const newline = chunk.lastIndexOf('\n')
        if (newline > chunk.length / 2) chunk = chunk.slice(0, newline + 1)
      }
      const escaped = escape(chunk)
      page += tag ? `<${tag}>${escaped}</${tag.split(' ')[0]}>` : escaped
      length += chunk.length
      remaining = remaining.slice(chunk.length)
      if (remaining) { result.push(page); page = ''; length = 0 }
    }
  }
  if (page) result.push(page)
  return result
}

function requestBody(request: InterventionRequest): { command?: string; detail: string } {
  const raw = request.detail.endsWith(observationSuffix) ? request.detail.slice(0, -observationSuffix.length).trim() : request.detail.trim()
  const detail = redact(raw)
  try {
    const value = JSON.parse(raw)
    if (request.kind === 'input' && request.questions.length && (value?.questions || value?.requestedSchema)) return { detail: '' }
    if (request.kind !== 'approval') return { detail }
    const command = value?.command ?? value?.tool_input?.command
    if (typeof command === 'string') {
      const context = [value.cwd ? `目录：${value.cwd}` : '', value.reason ?? value.justification ?? ''].filter(Boolean).join('\n')
      return { command: redact(command), detail: redact(context) }
    }
  } catch { /* Plain hook and observation commands are already readable. */ }
  return request.kind !== 'approval' || detail.startsWith('{') ? { detail } : { command: detail, detail: '' }
}

export function telegramRequest(request: InterventionRequest, session?: ControlSession): string {
  const recovery = request.actions.includes('resume')
  const observation = request.origin === 'observation' && !recovery
  const status = observation && request.status === 'pending' ? '待查看'
    : observation && request.status === 'resolved' ? '已知悉' : STATUS_LABEL[request.status]
  const agent = session ? names[session.agent] : 'Agent'
  const label = session && ![agent.toLowerCase(), session.agent].includes(session.label.toLowerCase()) ? ` · ${clip(redact(session.label), 120)}` : ''
  const parts: Part[] = [part(`${observation ? '仅提醒' : kinds[request.kind]} · ${status}`, 'b'), part(`\n${agent}${label}\n\n`)]
  const body = requestBody(request)
  const title = redact(request.title)
  if (title !== body.command && title !== body.detail) parts.push(part(clip(title, 180), 'b'), part('\n\n'))
  if (body.command) parts.push(part(clip(body.command, 1100), 'pre'), part('\n\n'))
  if (body.detail) parts.push(part(clip(body.detail, body.command ? 300 : 1100), body.detail.length > 240 ? 'blockquote expandable' : 'blockquote'), part('\n\n'))
  let questionsTruncated = false
  if (request.questions.length) {
    const questions = request.questions.map(q => `${q.id} · ${q.text}${q.multi ? '（多选）' : ''}\n${q.options.map((option, i) => `${i + 1}. ${option}${q.descriptions?.[i] ? ` — ${q.descriptions[i]}` : ''}`).join('\n')}`).join('\n\n')
    questionsTruncated = redact(questions).length > 900
    parts.push(part(clip(redact(questions), 900), 'blockquote expandable'), part('\n\n'))
  }
  if (recovery) {
    parts.push(part(request.status === 'pending' ? '选择“继续会话”将恢复原会话并继续未完成的任务；“知道了”只关闭提醒。' : request.decision?.action === 'resume' ? '已请求恢复原会话；结果待确认时请检查原会话，系统不会自动重试。' : '已关闭提醒。', 'blockquote'), part('\n\n'))
    if (request.status === 'pending') parts.push(part(`/resume ${request.id}`, 'code'), part('\n\n'))
  } else if (observation) {
    parts.push(part('此事件仅用于提醒，无法在这里批准或回答。请回到原会话处理；“知道了”只关闭提醒。', 'blockquote'), part('\n\n'))
  } else if (request.status === 'pending' && request.actions.includes('answer')) {
    const single = request.questions.length === 1 && !request.questions[0].multi
    parts.push(part(single ? request.questions[0].options.length ? '点击选项，或引用此消息回答。也可在本地灵动岛回答。\n\n' : '引用此消息直接回答，也可在本地灵动岛输入。\n\n' : '逐题点击选项后按“提交回答”；多选可再次点击取消。也可在本地灵动岛回答，或用 JSON 补充其他内容。\n'))
    if (!single) {
      const example = `/answer ${request.id} ${JSON.stringify(Object.fromEntries(request.questions.map(q => [q.id, [q.options[0] ?? '你的回答']])) )}`
      if (example.length <= 600) parts.push(part(example, 'pre'), part('\n\n'))
    }
  } else if (request.status === 'pending' && request.actions.includes('approve')) {
    parts.push(part('确认完整内容后，使用下方按钮处理本次请求。\n\n'))
  }
  if (request.decision?.answers) {
    const summary = request.questions.map(q => `${q.id}: ${request.decision!.answers![q.id]?.join('、') ?? ''}`).join('\n')
    parts.push(part('已提交回答\n', 'b'), part(clip(redact(summary), 600), 'blockquote'), part('\n\n'))
  }
  if ((body.command && body.command.length > 1100) || body.detail.length > (body.command ? 300 : 1100) || questionsTruncated) {
    parts.push(part('以上为摘要，请查看完整内容。\n'))
  }
  parts.push(part('请求 '), part(request.id, 'code'), part('\n详情 '), part(`/detail ${request.id}`, 'code'))
  if (session?.connected && session.capabilities.includes('message') && request.sessionId.length <= 200) {
    parts.push(part('\n补充指导 '), part(`/send ${request.sessionId} 内容`, 'code'))
  }
  // Each section has a display budget; a notification stays one editable message.
  return pages(parts)[0]
}

/** Replies are formatted only from the hub's authorized, redacted result. */
export function telegramReply(text: string, incoming?: string): string[] {
  const safe = redact(text)
  const detail = /^\/detail(?:@\w+)?\s+(\S+)\s*$/.exec(incoming?.trim() ?? '')
  if (detail && safe.startsWith(`#${detail[1]}\n`)) {
    const [, title, ...body] = safe.split('\n')
    return pages([part(title, 'b'), part('\n请求 '), part(detail[1], 'code'), part('\n\n'), part(body.join('\n'), 'pre')])
  }
  const parts: Part[] = []
  const lines = safe.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const command = /^(.*?)(\/(?:detail|status|approve|deny|cancel|ack|answer|send|resume|interrupt)\s+\S+.*)$/.exec(line)
    if (command) parts.push(part(command[1]), part(command[2], 'code'))
    else parts.push(part(line, index === 0 || /^#\S+ · /.test(line) ? 'b' : undefined))
    if (index < lines.length - 1) parts.push(part('\n'))
  }
  return pages(parts)
}
