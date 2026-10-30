import { ACTION_LABEL, clip, notification } from '../notification'
import type { NotificationSection } from '../notification'
import type { ControlSession, InterventionRequest } from '../types'

const COLORS = { amber: 0xf3c76a, blue: 0x78b9ff, red: 0xff8881, green: 0x78db9c, grey: 0xaaaab3 }
const TEMPLATES = { amber: 'orange', blue: 'blue', red: 'red', green: 'green', grey: 'grey' }

function markdown(text: string): string { return text.replace(/([\\`*_~|\[\]<>])/g, '\\$1') }
function code(text: string, diff = false): string {
  // A command's own fence must not escape its code block and impersonate UI copy.
  return `\`\`\`${diff ? 'diff' : ''}\n${text.replace(/```/g, '``\u200b`')}\n\`\`\``
}

function fit(text: string, size: number, render: (text: string) => string = markdown): string {
  if (render(text).length <= size) return render(text)
  let low = 0, high = text.length
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (render(clip(text, middle)).length <= size) low = middle
    else high = middle
  }
  return render(clip(text, low))
}

export function discordRequest(r: InterventionRequest, session?: ControlSession) {
  const n = notification(r, session)
  const description = `**${markdown(n.title)}**\n${n.agent}`
  const context = { name: '会话信息', value: n.context.map(item => `${item.label}：${markdown(item.text)}`).join('\n') }
  const hint = n.hint ? [{ name: '处理说明', value: fit(n.hint, 1024) }] : []
  const shortcuts = { name: '快捷命令', value: n.shortcuts.filter(s => ['完整详情', '提交回答', '补充指导', '继续会话'].includes(s.label))
    .map(s => `${s.label}\n${code(s.label === '提交回答' && s.text.length > 350 ? `/answer ${r.id} {"问题ID":["你的回答"]}` : s.text)}`).join('\n') }
  const fixed = [context, ...hint, shortcuts]
  let budget = 5800 - n.heading.length - description.length - fixed.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  const visible = n.sections.slice(0, 22)
  let truncated = n.truncated || n.sections.length > visible.length || markdown(n.hint).length > 1024
  const sections = visible.map((section, index) => {
    const size = Math.min(1024, Math.floor(budget / (visible.length - index)) - section.label.length)
    const render = section.style === 'text' ? markdown : (text: string) => code(text, section.style === 'diff')
    const value = fit(section.text, size, render)
    budget -= section.label.length + value.length
    truncated ||= render(section.text).length > size
    return { name: section.label, value }
  })
  return { title: n.heading, color: COLORS[n.tone], description, fields: [context, ...sections, ...hint, shortcuts],
    footer: { text: `请求 #${r.id}${truncated ? ' · 以上为摘要，请查看完整内容。' : ''}` } }
}

export function feishuCard(text: string, r?: InterventionRequest, session?: ControlSession): string {
  if (!r) return JSON.stringify({ config: { wide_screen_mode: true }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: text } }] })
  const n = notification(r, session)
  const div = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } })
  const actions = r.status === 'pending' ? r.actions.filter(a => a !== 'answer').map(action => ({ tag: 'button', text: { tag: 'plain_text', content: ACTION_LABEL[action] },
    type: ['approve', 'resume'].includes(action) ? 'primary' : action === 'deny' ? 'danger' : 'default', value: { requestId: r.id, revision: r.revision, action } })) : []
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: TEMPLATES[n.tone], title: { tag: 'plain_text', content: n.heading } }, elements: [
    div(n.title), { tag: 'note', elements: [{ tag: 'plain_text', content: n.agent }] },
    { tag: 'div', fields: n.context.map(item => ({ is_short: item.label !== '工作目录', text: { tag: 'plain_text', content: `${item.label}\n${item.text}` } })) },
    { tag: 'hr' },
    ...n.sections.flatMap(section => [{ tag: 'markdown', content: `**${section.label}**` }, div(section.text)]),
    ...(n.truncated ? [div('以上为摘要，请查看完整内容。')] : []),
    ...(n.hint ? [{ tag: 'hr' }, div(n.hint)] : []),
    ...(actions.length ? [{ tag: 'action', actions }] : []),
    { tag: 'hr' }, div(n.shortcuts.map(s => `${s.label}：${s.text}`).join('\n')),
    { tag: 'note', elements: [{ tag: 'plain_text', content: `请求 #${r.id}` }] }
  ] })
}

export function wecomRequest(r: InterventionRequest, session?: ControlSession): string[] {
  const n = notification(r, session)
  const blocks = [`**${n.heading}**\n**${markdown(n.title)}**\n${n.agent}\n`,
    `${n.context.map(item => `${item.label}：${markdown(item.text)}`).join('\n')}\n`,
    ...n.sections.map(section => `**${section.label}**\n${section.style === 'text' ? markdown(section.text) : code(section.text, section.style === 'diff')}\n`),
    ...(n.truncated ? ['以上为摘要，请查看完整内容。\n'] : []),
    ...(n.hint ? [`${markdown(n.hint)}\n`] : []),
    `请求 #${r.id}\n`, ...n.shortcuts.map(s => `${s.label}\n${code(s.text)}\n`)]
  const result: string[] = []
  let page = ''
  for (const raw of blocks) {
    const block = raw.replace(/<@/g, '< @')
    if (Buffer.byteLength(page + '\n' + block) > 3500 && page) { result.push(page); page = '' }
    page += `${page ? '\n' : ''}${block}`
  }
  if (page) result.push(page)
  return result
}

export function wecomActionCard(r: InterventionRequest, session?: ControlSession) {
  const n = notification(r, session)
  const preview: NotificationSection | undefined = n.sections.find(section => ['执行命令', '目标文件', '目标路径', '授权目录'].includes(section.label)) ?? n.sections[0]
  return { card_type: 'button_interaction', source: { desc: n.agent, desc_color: n.tone === 'red' ? 2 as const : n.tone === 'green' ? 3 as const : 1 as const },
    main_title: { title: n.heading, desc: clip(n.title, 60) },
    horizontal_content_list: [{ keyname: '请求编号', value: r.id }, ...n.context.filter(item => ['会话', '处理方式'].includes(item.label)).map(item => ({ keyname: item.label, value: clip(item.text, 60) }))],
    ...(preview ? { quote_area: { type: 0 as const, title: preview.label, quote_text: clip(preview.text, 200) } } : {}),
    sub_title_text: `上方消息包含操作明细。完整详情：/detail ${r.id}`,
    task_id: `${r.id}@${r.revision}`,
    button_list: r.actions.filter(a => a !== 'answer').map(action => ({ text: ACTION_LABEL[action], key: `${r.id}:${r.revision}:${action}`, style: 1 })) }
}
