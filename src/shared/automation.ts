import { record, type Preferences } from './preferences'

export interface Decision {
  action: 'approved' | 'answered' | 'manual'
  summary: string
  response?: Record<string, unknown>
}

const manual = (summary: string): Decision => ({ action: 'manual', summary })
const recommended = (option: Record<string, unknown>): boolean => option.recommended === true ||
  /(?:[（(\[【]\s*(?:recommended|推荐|建议)\s*[）)\]】]|\s[-—]\s*recommended\s*$)/i.test(String(option.label ?? ''))

export function chooseAnswers(questions: unknown, fallback: 'manual' | 'first', key: 'id' | 'question'): Record<string, string[]> | undefined {
  if (!Array.isArray(questions) || !questions.length || questions.length > 30) return
  const answers: Record<string, string[]> = Object.create(null)
  for (const raw of questions) {
    const question = record(raw)
    const id = question[key]
    if (typeof id !== 'string' || !id.trim() || Object.hasOwn(answers, id) || question.isSecret === true ||
        !Array.isArray(question.options) || !question.options.length) return
    const options = question.options.map(value => typeof value === 'string' ? { label: value } : record(value))
    if (options.some(option => typeof option.label !== 'string' || !option.label.trim()) ||
        new Set(options.map(option => option.label)).size !== options.length) return
    const choices = options.filter(recommended)
    if (!choices.length && fallback === 'first') choices.push(options[0])
    if (!choices.length || (choices.length > 1 && question.multiSelect !== true)) return
    answers[id] = choices.map(choice => String(choice.label))
  }
  return answers
}

export function decideClaude(payload: unknown, preferences: Preferences): Decision {
  const event = record(payload)
  const auto = preferences.automation
  const input = record(event.tool_input)
  if (!auto.enabled) return manual('自动审批已暂停')
  if (event.tool_name === 'AskUserQuestion' && ['PreToolUse', 'PermissionRequest'].includes(String(event.hook_event_name))) {
    if (!auto.answerQuestions) return manual('自动回答已关闭')
    const answers = chooseAnswers(input.questions, auto.fallback, 'question')
    if (!answers) return manual('问题缺少明确选项或唯一推荐，保留手动回答')
    const updatedInput = { ...input, answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, values.join(', ')])) }
    return {
      action: 'answered', summary: Object.values(answers).flat().join('；'),
      response: { hookSpecificOutput: event.hook_event_name === 'PreToolUse'
        ? { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput }
        : { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput } } }
    }
  }
  if (event.hook_event_name === 'PermissionRequest' && typeof event.tool_name === 'string') {
    // Plan approval is a separate product decision, not a tool permission.
    if (event.tool_name === 'ExitPlanMode') return manual('计划确认保留手动处理')
    if (!auto.approvePermissions) return manual('自动批准权限已关闭')
    return { action: 'approved', summary: `已批准 ${event.tool_name}`, response: {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
    } }
  }
  return manual('此事件不支持自动处理')
}

export function decideCodex(method: string, payload: unknown, preferences: Preferences): Decision {
  const auto = preferences.automation
  const params = record(payload)
  if (!auto.enabled) return manual('自动审批已暂停')
  if (method === 'item/tool/requestUserInput') {
    if (!auto.answerQuestions) return manual('自动回答已关闭')
    const answers = chooseAnswers(params.questions, auto.fallback, 'id')
    if (!answers) return manual('问题缺少明确选项或唯一推荐，保留手动回答')
    return { action: 'answered', summary: Object.values(answers).flat().join('；'), response: {
      answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, { answers: values }]))
    } }
  }
  if (!auto.approvePermissions) return manual('自动批准权限已关闭')
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
    if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept')) return manual('请求不允许单次批准')
    return { action: 'approved', summary: method.includes('fileChange') ? '已批准文件修改' : '已批准命令执行', response: { decision: 'accept' } }
  }
  if (method === 'item/permissions/requestApproval' && params.permissions && typeof params.permissions === 'object' && !Array.isArray(params.permissions)) {
    const permissions = Object.fromEntries(Object.entries(record(params.permissions)).filter(([key, value]) =>
      ['network', 'fileSystem'].includes(key) && value !== null))
    return { action: 'approved', summary: '已批准本轮请求的权限', response: { permissions, scope: 'turn' } }
  }
  return manual('此请求保留在原客户端处理')
}
