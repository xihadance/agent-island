// npm run build && node scripts/smoke-input-focus.cjs [--docked]
// A topmost sibling exposes Deactivate() selecting a window other than the active input.
// Only synthetic logs, input and an isolated application profile are used.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return
    await delay(100)
  }
  throw new Error('等待输入焦点测试状态超时')
}

async function fixture() {
  const { app, BrowserWindow, Menu, screen } = require('electron')
  const processes = require('node:child_process')
  const nativeSpawn = processes.spawn
  const nativeExecFile = processes.execFile
  let residents = 0, fallbacks = 0, focusableCalls = 0, trayMenu = []
  processes.spawn = (exe, ...args) => {
    if (exe === 'powershell.exe') residents++
    return nativeSpawn(exe, ...args)
  }
  processes.execFile = (exe, ...args) => {
    if (exe === 'powershell.exe') fallbacks++
    return nativeExecFile(exe, ...args)
  }
  const setFocusable = BrowserWindow.prototype.setFocusable
  BrowserWindow.prototype.setFocusable = function (...args) {
    focusableCalls++
    return setFocusable.apply(this, args)
  }
  const buildMenu = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = template => {
    if (template.some(item => item.label === '托管模式')) trayMenu = template
    return buildMenu(template)
  }
  await app.whenReady()
  screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 })
  require('../out/main/index.js')
  const activities = async () => (await (await fetch(`http://127.0.0.1:${process.env.CUTE_ISLAND_PORT}/v1/activities`)).json()).activities
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL())
  const island = BrowserWindow.getAllWindows()[0]
  await until(() => !island.webContents.isLoading())
  await until(async () => (await activities()).some(item => item.id === 'claude-input-focus'))
  const dock = await island.webContents.executeJavaScript('document.querySelector(".island").dataset.dockEdge ?? null')
  assert.equal(dock, process.env.ISLAND_INPUT_DOCKED === '1' ? 'left' : null, '必须覆盖指定的贴边状态')

  // Neither sibling appears on the user's desktop; they still exercise real HWND activation.
  const sibling = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 200, height: 100, alwaysOnTop: true, skipTaskbar: true })
  const input = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 200, height: 100, skipTaskbar: true })
  await input.loadURL('data:text/html,<textarea></textarea><script>window.ends=0;document.addEventListener("compositionend",()=>window.ends++);document.querySelector("textarea").focus()</script>')
  input.webContents.debugger.attach('1.3')
  const evaluate = async expression => {
    const response = await input.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
    if (response.exceptionDetails) throw new Error('输入测试页面执行失败')
    return response.result.value
  }
  const results = []
  let sequence = 0
  try {
    for (const mode of ['focus', 'managed']) {
      trayMenu.find(item => item.label === (mode === 'focus' ? '关注模式' : '托管模式')).click()
      for (const hidden of [false, true]) {
        if (hidden) island.hide()
        else island.showInactive()
        sibling.showInactive()
        if (!hidden) island.moveTop()
        input.show()
        input.focus()
        await until(() => input.isFocused())
        sibling.moveTop()
        if (!hidden) island.moveTop()
        await evaluate('document.querySelector("textarea").value="";document.querySelector("textarea").focus();window.ends=0')
        await input.webContents.debugger.sendCommand('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
        assert.equal(await evaluate('document.querySelector("textarea").value'), 'nihao', '测试必须先建立尚未提交的组合输入')
        const before = focusableCalls
        const command = `echo input-focus-${++sequence}`
        await fs.appendFile(process.env.ISLAND_INPUT_TRANSCRIPT, JSON.stringify({ type: 'assistant', timestamp: Date.now(),
          message: { content: [{ type: 'tool_use', id: `tool-${sequence}`, name: 'Bash', input: { command, description: '隔离输入焦点测试' } }] } }) + '\n')
        await until(async () => (await activities()).some(item => item.operation?.command === command))
        await delay(100)
        const result = { mode, hidden, dock, focusableCalls: focusableCalls - before, inputFocused: input.isFocused(), compositionEnds: await evaluate('window.ends') }
        results.push(result)
        console.log(JSON.stringify(result))
        assert.equal(result.inputFocused, true, '会话识别刷新不能让其他窗口的输入框失焦')
        assert.equal(result.compositionEnds, 0, '会话识别刷新不能结束尚未提交的组合输入')
        assert.equal(result.focusableCalls, 0, '普通会话刷新不能重复修改原生焦点能力')
      }
    }
    assert.equal(residents, 1, '识别刷新复用同一个进程查询控制台')
    assert.equal(fallbacks, 0, '识别刷新不创建一次性备用控制台')
    console.log(JSON.stringify({ result: 'passed', results, residents, fallbacks, chrome: process.versions.chrome }))
  } finally {
    input.destroy()
    sibling.destroy()
    app.quit()
  }
}

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function smoke() {
  if (process.platform !== 'win32') { console.log('输入焦点冒烟仅适用于 Windows'); return }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'island-input-focus-'))
  let child, agent
  try {
    const profile = path.join(temporary, 'profile')
    const claude = path.join(temporary, '.claude')
    const transcript = path.join(claude, 'projects', 'fixture', 'input-focus.jsonl')
    const agentScript = path.join(temporary, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    await fs.mkdir(path.dirname(transcript), { recursive: true })
    await fs.mkdir(path.dirname(agentScript), { recursive: true })
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ mode: 'focus', watchSessions: true }))
    if (process.argv.includes('--docked')) await fs.writeFile(path.join(profile, 'window-position.json'),
      JSON.stringify({ x: 0, y: 100, dock: { edge: 'left', x: 0, y: 200 } }))
    await fs.writeFile(transcript, JSON.stringify({ type: 'assistant', timestamp: Date.now(), message: { content: [{ type: 'thinking', thinking: '隔离会话识别测试' }] } }) + '\n')
    await fs.writeFile(agentScript, 'setInterval(() => {}, 1000)')
    agent = spawn(process.execPath, [agentScript], { windowsHide: true, stdio: 'ignore' })
    const env = { ...process.env, CUTE_ISLAND_PORT: String(await freePort()), CUTE_ISLAND_TOKEN: '', CUTE_ISLAND_WATCH: '1', CUTE_ISLAND_UPDATE: '0',
      CUTE_ISLAND_REMOTE_CONFIG: path.join(temporary, 'remote.json'), ELECTRON_RENDERER_URL: '', CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: path.join(temporary, '.codex'), GEMINI_CLI_HOME: path.join(temporary, '.gemini'), CURSOR_HOME: path.join(temporary, '.cursor'),
      ISLAND_INPUT_TRANSCRIPT: transcript, ISLAND_INPUT_DOCKED: process.argv.includes('--docked') ? '1' : '0' }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data; process.stdout.write(data) })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => child.kill(), 35000)
    try {
      const [code] = await once(child, 'exit')
      assert.equal(code, 0, `输入焦点冒烟失败：${output.slice(-1800)}`)
      assert.match(output, /"result":"passed"/)
    } finally { clearTimeout(timeout) }
  } finally {
    for (const process of [child, agent]) if (process && process.exitCode === null && process.signalCode === null) {
      const exited = once(process, 'exit'); process.kill(); await exited
    }
    const resolved = path.resolve(temporary)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('island-input-focus-'))
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

(process.versions.electron ? fixture() : smoke()).catch(error => {
  console.error(error)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})
