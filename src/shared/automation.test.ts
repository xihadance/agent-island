import { describe, expect, it } from 'vitest'
import { chooseAnswers, decideClaude, decideCodex } from './automation'
import { normalizePreferences, patchPreferences } from './preferences'

const enabled = patchPreferences(normalizePreferences(undefined), { automation: { enabled: true } })
const question = { id: 'framework', question: '使用哪种框架？', options: [{ label: 'Vue' }, { label: 'React (Recommended)' }] }
const claude = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [question], metadata: 'keep' } }

describe('automatic answers', () => {
  it('selects the marked option instead of assuming that the first is recommended', () => {
    expect(chooseAnswers([question], 'manual', 'id')).toEqual({ framework: ['React (Recommended)'] })
    expect(chooseAnswers([{ ...question, options: ['A', 'B（推荐）'] }], 'manual', 'id')).toEqual({ framework: ['B（推荐）'] })
    expect(chooseAnswers([{ ...question, options: [{ label: 'A' }, { label: 'B', recommended: true }] }], 'manual', 'id')).toEqual({ framework: ['B'] })
  })
  it('makes the fallback explicit and never invents free text or secrets', () => {
    const plain = { ...question, options: ['A', 'B'] }
    expect(chooseAnswers([plain], 'manual', 'id')).toBeUndefined()
    expect(chooseAnswers([plain], 'first', 'id')).toEqual({ framework: ['A'] })
    for (const options of [[], null, [''], [{ label: 3 }], ['A', 'A']]) {
      expect(chooseAnswers([{ ...question, options }], 'first', 'id')).toBeUndefined()
    }
    expect(chooseAnswers([{ ...question, isSecret: true }], 'first', 'id')).toBeUndefined()
  })
  it('submits a complete answer set only, with unique question ids', () => {
    expect(chooseAnswers([question, { id: 'free' }], 'first', 'id')).toBeUndefined()
    expect(chooseAnswers([question, question], 'first', 'id')).toBeUndefined()
    expect(chooseAnswers([], 'first', 'id')).toBeUndefined()
    expect(chooseAnswers([{ ...question, id: '__proto__' }], 'manual', 'id')).toEqual({ ['__proto__']: ['React (Recommended)'] })
  })
  it('rejects ambiguous recommendations for a single-choice question and honors multi-select', () => {
    const multi = { ...question, options: ['A（推荐）', 'B（推荐）'] }
    expect(chooseAnswers([multi], 'first', 'id')).toBeUndefined()
    expect(chooseAnswers([{ ...multi, multiSelect: true }], 'manual', 'id')).toEqual({ framework: multi.options })
  })
  it('does not read recommendations from descriptions or negative phrases', () => {
    expect(chooseAnswers([{ ...question, options: [{ label: 'Not recommended', description: 'Recommended' }] }], 'manual', 'id')).toBeUndefined()
  })
})

describe('native automation responses', () => {
  it.each([
    ['tool name', { tool_name: 'mcp__deploy__Publish' }, 'DEPLOY'],
    ['command', { tool_input: { command: 'git PUSH origin main' } }, 'git push'],
    ['Windows path', { tool_input: { file_path: 'C:\\Project\\.env.local' } }, 'c:\\project\\.env'],
    ['working directory', { cwd: '/srv/Production' }, 'production'],
    ['description', { tool_input: { description: '更新生产环境' } }, '生产环境'],
    ['nested arguments', { tool_input: { operations: [{ target: '/app/.env' }] } }, '.env']
  ])('keeps Claude %s matches manual without returning an allow or deny', (_label, payload, keyword) => {
    const preferences = patchPreferences(enabled, { automation: { blacklist: ['unrelated', keyword] } })
    const decision = decideClaude({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', ...payload }, preferences)
    expect(decision).toEqual({ action: 'manual', summary: '命中自动审批黑名单，保留手动处理' })
  })

  it.each([
    ['item/commandExecution/requestApproval', { command: 'git PUSH origin main' }, 'git push'],
    ['item/commandExecution/requestApproval', { command: ['git', 'status'], cwd: 'C:\\Production' }, 'c:\\production'],
    ['item/commandExecution/requestApproval', { commandActions: [{ type: 'read', path: '/app/.env' }] }, '.env'],
    ['item/commandExecution/requestApproval', { networkApprovalContext: { host: 'API.example.com' } }, 'api.example'],
    ['item/commandExecution/requestApproval', { additionalPermissions: { fileSystem: { write: ['/app/secret'] } } }, 'secret'],
    ['item/fileChange/requestApproval', { grantRoot: '/app/Production' }, 'production'],
    ['item/fileChange/requestApproval', { reason: '更新生产环境' }, '生产环境'],
    ['item/permissions/requestApproval', { permissions: { fileSystem: { write: ['/app/.env'] } } }, '.env'],
    ['item/commandExecution/requestApproval', {}, 'commandexecution']
  ])('keeps matching Codex %s content manual', (method, payload, keyword) => {
    const preferences = patchPreferences(enabled, { automation: { blacklist: [keyword] } })
    expect(decideCodex(method, payload, preferences)).toEqual({ action: 'manual', summary: '命中自动审批黑名单，保留手动处理' })
  })

  it('applies the blacklist before recommended answers and first-option fallback', () => {
    const preferences = patchPreferences(enabled, { automation: { blacklist: ['框架'], fallback: 'first' } })
    for (const hook_event_name of ['PreToolUse', 'PermissionRequest']) {
      expect(decideClaude({ ...claude, hook_event_name }, preferences).response).toBeUndefined()
    }
    for (const method of ['item/tool/requestUserInput', 'tool/requestUserInput']) {
      expect(decideCodex(method, { questions: [question] }, preferences).response).toBeUndefined()
      expect(decideCodex(method, { questions: [{ ...question, options: ['A', 'B'] }] }, preferences).response).toBeUndefined()
    }
  })

  it('ignores empty entries and treats keywords literally without matching routing metadata', () => {
    const preferences = patchPreferences(enabled, { automation: { blacklist: [' ', 'secret', '.*', 'a+b', 'decline'] } })
    expect(decideClaude({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: 'secret', transcript_path: '/secret/log',
      tool_input: { command: 'git status' } }, preferences).action).toBe('approved')
    expect(decideCodex('item/commandExecution/requestApproval', { threadId: 'secret', turnId: 'secret', itemId: 'secret',
      approvalId: 'secret', environmentId: 'secret', availableDecisions: ['accept', 'decline'], command: 'git status' }, preferences).action).toBe('approved')
    expect(decideCodex('item/commandExecution/requestApproval', { command: 'echo a+b' }, preferences).response).toBeUndefined()
    const cleared = patchPreferences(preferences, { automation: { blacklist: [] } })
    expect(decideCodex('item/commandExecution/requestApproval', { command: 'echo secret' }, cleared).action).toBe('approved')
  })

  it.each(['item/tool/requestUserInput', 'tool/requestUserInput'])('answers %s only when question automation is enabled', method => {
    expect(decideCodex(method, { questions: [question] }, enabled).response)
      .toEqual({ answers: { framework: { answers: ['React (Recommended)'] } } })
    for (const preferences of [normalizePreferences(undefined), patchPreferences(enabled, { automation: { answerQuestions: false } })]) {
      expect(decideCodex(method, { questions: [question] }, preferences).response).toBeUndefined()
    }
    expect(decideCodex(method, { questions: [{ ...question, isSecret: true }] }, enabled).response).toBeUndefined()
    expect(decideCodex(method, { questions: [{ id: 'free', question: '请输入路径' }] }, enabled).response).toBeUndefined()
  })
  it('uses Claude question text as keys and preserves all other tool arguments', () => {
    expect(decideClaude(claude, enabled)).toMatchObject({ action: 'answered', response: { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { metadata: 'keep', questions: [question], answers: { '使用哪种框架？': 'React (Recommended)' } }
    } } })
    expect(decideClaude({ ...claude, hook_event_name: 'PermissionRequest' }, enabled)).toMatchObject({ response: {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { answers: { '使用哪种框架？': 'React (Recommended)' } } } }
    } })
  })
  it('responds to real permissions, retaining plan decisions and disabled controls', () => {
    const approval = { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }
    expect(decideClaude(approval, enabled).response).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(decideClaude({ ...approval, tool_name: 'ExitPlanMode' }, enabled).action).toBe('manual')
    for (const preferences of [normalizePreferences(undefined), patchPreferences(enabled, { automation: { approvePermissions: false } })]) {
      expect(decideClaude(approval, preferences).response).toBeUndefined()
    }
    expect(decideClaude(claude, patchPreferences(enabled, { automation: { answerQuestions: false } })).response).toBeUndefined()
    expect(decideClaude({ ...approval, hook_event_name: 'PostToolUse' }, enabled).response).toBeUndefined()
  })
  it('returns Codex answers and single-request approvals in their native shapes', () => {
    expect(decideCodex('item/tool/requestUserInput', { questions: [question] }, enabled).response).toEqual({ answers: { framework: { answers: ['React (Recommended)'] } } })
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      expect(decideCodex(method, {}, enabled).response).toEqual({ decision: 'accept' })
      expect(decideCodex(method, { availableDecisions: ['decline'] }, enabled).response).toBeUndefined()
      expect(decideCodex(method, {}, normalizePreferences(undefined)).response).toBeUndefined()
    }
    expect(decideCodex('item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: null } }, enabled).response)
      .toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' })
    expect(decideCodex('account/chatgptAuthTokens/refresh', {}, enabled).response).toBeUndefined()
  })
})
