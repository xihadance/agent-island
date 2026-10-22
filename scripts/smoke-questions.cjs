// npm run build && node scripts/smoke-questions.cjs
// Native Claude Hook round trips through the real Electron question form, without a model or message channel.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const WebSocket = require('ws')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture() {
  const { app, BrowserWindow, screen } = require('electron')
  await app.whenReady()
  screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 })
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.showInactive = function () {
    this.setPosition(-10000, -10000)
    this.webContents.setBackgroundThrottling(false)
    showInactive.call(this)
  }
  require('../out/main/index.js')
}

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function until(check) {
  let last
  for (let i = 0; i < 100; i++) {
    try { const value = await check(); if (value) return value } catch (error) { last = error }
    await delay(100)
  }
  throw new Error(`问题冒烟等待超时：${last?.message ?? '状态未就绪'}`)
}

async function smoke() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-questions-'))
  const [port, debugPort] = await Promise.all([freePort(), freePort()])
  const configFile = path.join(profile, 'remote.json')
  const controlToken = 'isolated-question-smoke-token-'.repeat(3)
  await fs.writeFile(configFile, JSON.stringify({ mode: 'takeover', enabled: true, port, controlToken, stateFile: 'state.json', channels: [], codex: [] }))
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ mode: 'managed', automation: { enabled: true, answerQuestions: true } }))
  const headers = { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' }
  const control = async (route = '', body) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/control${route}`, { headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) })
    return { status: response.status, value: await response.json() }
  }
  const env = { ...process.env, CUTE_ISLAND_REMOTE_CONFIG: configFile, CUTE_ISLAND_PORT: String(port), CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: '', ELECTRON_RENDERER_URL: '' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
  let logs = '', socket, hook
  child.stdout.on('data', value => { logs += value })
  child.stderr.on('data', value => { logs += value })
  const errors = []
  try {
    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(page => page.type === 'page' && !page.url.includes('#settings')))
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await once(socket, 'open')
    let next = 0
    const pending = new Map()
    socket.on('message', raw => {
      const message = JSON.parse(String(raw))
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
      const request = pending.get(message.id)
      if (request) { pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result) }
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
    await send('Runtime.enable')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    }
    await until(() => evaluate('!!window.island'))
    const questions = [
      { question: '选择部署环境', options: [{ label: '开发（推荐）', description: '仅在本机运行，保留现有配置。' }, { label: '生产', description: '部署到生产环境。' }], multiSelect: false },
      { question: '需要哪些模块？', options: [{ label: '登录' }, { label: '注册', description: '包含新用户注册与校验。' }], multiSelect: true }
    ]
    hook = spawn(process.execPath, [path.resolve('out/cli.cjs'), 'remote', 'hook', '--agent', 'claude', '--config', configFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const hookExit = once(hook, 'exit')
    let output = ''
    hook.stdout.on('data', value => { output += value })
    hook.stderr.on('data', value => { logs += value })
    hook.stdin.end(JSON.stringify({ session_id: 'question-smoke', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions, untouched: 'preserve' } }))
    const request = await until(async () => (await control()).value.requests.find(r => r.status === 'pending'))
    await until(() => evaluate('document.querySelectorAll(".question-option").length === 4'))
    assert.equal(await evaluate('document.querySelector(".island").dataset.attentionKind'), 'input')
    assert.match(await evaluate('document.querySelector(".question-answers").textContent'), /仅在本机运行/)
    assert.equal(await evaluate('document.querySelector(".question-submit").disabled'), true)
    await evaluate('document.querySelectorAll(".question-option input")[0].click(); document.querySelectorAll(".question-option input")[2].click(); document.querySelectorAll(".question-option input")[3].click()')
    assert.equal(await evaluate('document.querySelector(".question-submit").disabled'), false)
    const reviewDir = path.resolve('.impeccable/review')
    await fs.mkdir(reviewDir, { recursive: true })
    await delay(500)
    const capture = async name => {
      const rect = await until(async () => {
        const bounds = await evaluate('(() => { const r = document.querySelector(".island").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } })()')
        return bounds.width >= 330 && bounds.height >= 300 && bounds
      })
      const result = await send('Page.captureScreenshot', { format: 'png', clip: rect })
      await fs.writeFile(path.join(reviewDir, name), Buffer.from(result.data, 'base64'))
    }
    await capture('question-multiple.png')
    await evaluate('document.querySelector(".question-submit").scrollIntoView({ block: "center" })')
    await capture('question-submit.png')
    await evaluate('document.querySelector(".question-submit").click()')
    await until(() => hook.exitCode !== null)
    assert.equal((await hookExit)[0], 0)
    const native = JSON.parse(output).hookSpecificOutput
    assert.equal(native.permissionDecision, 'allow')
    assert.deepEqual(native.updatedInput, { questions, untouched: 'preserve', answers: { '选择部署环境': '开发（推荐）', '需要哪些模块？': '登录, 注册' } })
    assert.equal((await control(`/requests/${request.id}/respond`, { revision: request.revision, decision: { action: 'answer', answers: { q1: ['生产'], q2: ['注册'] } } })).status, 409)
    await until(() => evaluate('document.querySelector(".island").dataset.passive === "true" && !document.querySelector(".question-answers")'))
    assert.equal((await evaluate('window.island.getActivities()'))[0].questionRequest.status, 'submitted')
    await evaluate('window.island.setMode("focus")')
    await until(() => evaluate('document.querySelector(".island").dataset.behavior === "focus"'))
    await evaluate('document.querySelector(".island").click()')
    await until(() => evaluate('document.querySelector(".question-answers")?.textContent.includes("已提交")'))
    await delay(400)
    await capture('question-submitted.png')

    await control('/hook', { agent: 'claude', invocationId: 'complete', event: { session_id: 'question-smoke', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions, untouched: 'preserve' } } })
    await until(() => evaluate('!document.querySelector(".question-answers")'))
    // No recommended option: automation answers those before a remote request or island prompt exists.
    const longQuestions = [{ question: '请选择本次需要处理的功能范围', options: [
      { label: '保留现有流程', description: '沿用现有接入方式，补齐选择题选项、说明和回答后的同步状态。'.repeat(4) },
      { label: '自定义范围', description: '在下方输入你的回答。' }
    ], multiSelect: false }]
    const remote = await control('/hook', { agent: 'claude', invocationId: 'remote', event: { session_id: 'question-smoke', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: longQuestions } } })
    await until(() => evaluate('document.querySelectorAll(".question-option").length === 2'))
    await delay(400)
    await capture('question-long.png')
    await evaluate('document.querySelector("textarea").focus()')
    await send('Input.insertText', { text: '增加回答选项' })
    assert.equal(await evaluate('document.querySelector("textarea").value'), '增加回答选项')
    await control(`/requests/${remote.value.requestId}/respond`, { revision: 1, decision: { action: 'answer', answers: { q1: ['自定义范围'] } } })
    await until(() => evaluate('document.querySelector(".question-answers")?.textContent.includes("已提交：自定义范围")'))
    assert.equal(await evaluate('document.querySelector(".question-submit") === null'), true)
    await control('/enabled', { enabled: false })
    await until(() => evaluate('!document.querySelector(".question-answers")'))
    assert.deepEqual(errors, [])
    console.log('通过：本地选择、多选、说明、输入、Claude 原生回传、跨端重复提交和远程关闭。截图位于 .impeccable/review/question-*.png')
  } catch (error) { console.error(logs); throw error }
  finally {
    socket?.close()
    if (hook && hook.exitCode === null) hook.kill()
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    const resolved = path.resolve(profile)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('island-questions-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
}

if (process.versions.electron) void fixture()
else smoke().catch(error => { console.error(error); process.exitCode = 1 })
