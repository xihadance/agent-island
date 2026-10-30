import { clip, notification, redact } from '../notification'
import type { ControlSession, InterventionRequest } from '../types'

type Tag = 'b' | 'code' | 'pre' | 'blockquote' | 'blockquote expandable'
interface Part { text: string; tag?: Tag }
const LIMIT = 3900 // Telegram allows 4096 characters after parsing entities.

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function prefix(text: string, size: number): string {
  // Never split an emoji's UTF-16 surrogate pair.
  const end = size < text.length && /[\uD800-\uDBFF]/.test(text[size - 1] ?? '') ? size - 1 : size
  return text.slice(0, end)
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

export function telegramRequest(request: InterventionRequest, session?: ControlSession): string {
  const n = notification(request, session)
  const label = n.context.find(item => item.label === '会话')?.text
  const parts: Part[] = [part(n.heading, 'b'), part(`\n${n.agent}${label ? ` · ${label}` : ''}\n\n`)]
  if (!n.sections.some(section => section.text === n.title)) parts.push(part(n.title, 'b'), part('\n\n'))
  for (const item of n.context.filter(item => item.label !== '会话')) parts.push(part(`${item.label}：${item.text}\n`))
  parts.push(part('\n'))
  let hint = n.hint
  if (request.origin !== 'observation' && request.status === 'pending' && request.actions.includes('answer')) {
    const single = request.questions.length === 1 && !request.questions[0].multi
    hint = single ? request.questions[0].options.length ? `点击选项${request.questions[0].freeText ? '，或引用此消息回答' : ''}。也可在本地灵动岛回答。`
      : '引用此消息直接回答，也可在本地灵动岛输入。'
      : request.questions.some(q => q.options.length) ? '逐题点击选项后按“提交回答”；多选可再次点击取消。自由回答或补充内容使用下方 JSON 命令，也可在本地灵动岛回答。'
        : '请使用下方 JSON 命令逐题回答，也可在本地灵动岛输入。'
  }
  const footer: Part[] = []
  if (hint) footer.push(part(hint, 'blockquote'), part('\n\n'))
  footer.push(part('请求 '), part(request.id, 'code'))
  for (const shortcut of n.shortcuts.filter(s => ['完整详情', '提交回答', '补充指导', '继续会话'].includes(s.label))) footer.push(part(`\n${shortcut.label} `), part(shortcut.text, 'code'))
  const summary = '以上为摘要，请查看完整内容。\n'
  let budget = LIMIT - [...parts, ...footer].reduce((sum, p) => sum + p.text.length, 0) - summary.length
  let truncated = n.truncated
  for (const section of n.sections) {
    const limit = Math.max(0, Math.min(section.text.length, budget - section.label.length - 4))
    if (limit < 1) { truncated = true; continue }
    parts.push(part(section.label, 'b'), part('\n'), part(clip(section.text, limit), section.style === 'text' ? 'blockquote expandable' : 'pre'), part('\n\n'))
    budget -= section.label.length + limit + 3
    truncated ||= limit < section.text.length
  }
  if (truncated) parts.push(part(summary))
  return pages([...parts, ...footer])[0]
}

/** Replies are formatted only from the hub's authorized, redacted result. */
export function telegramReply(text: string, incoming?: string): string[] {
  const safe = redact(text)
  const detail = /^\/detail(?:@\w+)?\s+(\S+)\s*$/.exec(incoming ?? '')
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
