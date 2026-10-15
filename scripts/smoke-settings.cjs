// npm run build && node scripts/smoke-settings.cjs
// Real Electron IPC, renderer, persistence and native hooks in an isolated profile.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(60) }
  throw new Error('Timed out waiting for settings')
}

async function fixture() {
  const { app, BrowserWindow, Menu } = require('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.getVersion = () => require('../package.json').version
  app.getAppPath = () => path.resolve('.')
  let trayMenu = []
  const buildMenu = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = template => { if (template.some(item => item.label === '托管模式')) trayMenu = template; return buildMenu(template) }
  // Paint without covering the user's desktop or taking keyboard focus.
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.show = function () { this.setPosition(-10000, -10000); showInactive.call(this) }
  BrowserWindow.prototype.showInactive = function () { this.setPosition(-10000, -10000); showInactive.call(this) }
  const processes = require('node:child_process')
  const nativeSpawn = processes.spawn
  processes.spawn = (executable, args, options) => {
    if (args?.[0] !== 'app-server') return nativeSpawn(executable, args, options)
    const port = new URL(args.at(-1)).port
    const code = `const {WebSocketServer}=require('ws'); const s=new WebSocketServer({host:'127.0.0.1',port:${port}}); s.on('connection',ws=>ws.on('message',b=>{const m=JSON.parse(b); if(!m.id)return; ws.send(JSON.stringify({id:m.id,result:m.method==='initialize'?{userAgent:'fixture'}:{data:[]}}));}));`
    return nativeSpawn(process.execPath, ['-e', code], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  }
  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().endsWith('#settings')))
  let settings = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#settings'))
  settings.webContents.setBackgroundThrottling(false)
  let evaluate = script => settings.webContents.executeJavaScript(script, true)
  await until(() => evaluate('!!document.querySelector(".automation-master")'))
  const errors = []
  settings.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message) })
  const state = () => evaluate('window.island.getSettings()')
  if (process.env.ISLAND_SETTINGS_PHASE === 'restore') {
    const restored = await state()
    assert.equal(restored.preferences.mode, 'managed')
    assert.equal(restored.preferences.automation.enabled, false)
    assert.equal(restored.preferences.automation.fallback, 'first')
    console.log('Settings restart persistence passed')
    app.quit()
    return
  }
  const artifacts = path.resolve('.impeccable/review')
  await fs.mkdir(artifacts, { recursive: true })
  const capture = async name => { await delay(350); for (let attempt = 0; ; attempt++) { try { await fs.writeFile(path.join(artifacts, `${name}.png`), (await settings.webContents.capturePage()).toPNG()); break } catch (error) { if (attempt >= 2) throw new Error(`Capture ${name}: ${error}`); await delay(300) } } }
  const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(text)}).click()`)
  const settled = () => until(() => evaluate('!document.querySelector(".settings-save-status").textContent.includes("正在")'))
  await capture('settings-paused')
  await evaluate('document.querySelector("[role=switch]").click()')
  await until(async () => (await state()).preferences.automation.enabled)
  assert.equal(trayMenu.find(item => item.label === '自动审批').checked, true)
  const post = async body => (await fetch(`http://127.0.0.1:${process.env.CUTE_ISLAND_PORT}/v1/hooks/claude`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  })).json()
  assert.equal((await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'smoke-1' })).hookSpecificOutput.decision.behavior, 'allow')
  const question = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '用哪个？', options: [{ label: 'A' }, { label: 'B（推荐）' }] }] } }
  assert.deepEqual((await post(question)).hookSpecificOutput.updatedInput.answers, { '用哪个？': 'B（推荐）' })
  await capture('desktop')
  await evaluate('document.querySelector("#question-fallback").value = "first"; document.querySelector("#question-fallback").dispatchEvent(new Event("change", { bubbles: true }))')
  await until(async () => (await state()).preferences.automation.fallback === 'first')
  await click('常规')
  await evaluate('document.querySelectorAll("input[type=radio]")[1].click()')
  await until(async () => (await state()).preferences.mode === 'managed')
  assert.equal(trayMenu.find(item => item.label === '托管模式').checked, true)
  await capture('settings-general')
  trayMenu.find(item => item.label === '关注模式').click()
  await until(() => evaluate('document.querySelectorAll("input[type=radio]")[0].checked'))
  trayMenu.find(item => item.label === '托管模式').click()
  await click('Agent 接入')
  await click('安装接入')
  await until(async () => (await state()).claudeInstalled)
  const installed = JSON.parse(await fs.readFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'))
  assert.ok(installed.hooks.PermissionRequest.length)
  const portListener = net.createServer().listen(0, '127.0.0.1'); await once(portListener, 'listening')
  const hostedPort = portListener.address().port; await new Promise(resolve => portListener.close(resolve))
  await evaluate(`window.island.updateSettings({codexServer:{port:${hostedPort},executable:${JSON.stringify(process.execPath)}}})`)
  await until(() => evaluate("!Array.from(document.querySelectorAll('button')).find(el=>el.textContent==='启动托管服务').disabled"))
  await click('启动托管服务')
  await until(async () => (await state()).codexServer.status === 'running' && (await state()).codexStatus === 'connected')
  assert.equal(await evaluate('document.querySelector("#codex-connect-command").value'), `codex --remote ws://127.0.0.1:${hostedPort}`)
  await evaluate('window.scrollTo(0, document.body.scrollHeight)')
  await capture('connections-server-running')
  await click('停止托管服务')
  await until(async () => (await state()).codexServer.status === 'stopped' && (await state()).codexStatus === 'disabled')
  await evaluate('window.scrollTo(0, 0)')
  await capture('settings-connections')
  settings.setContentSize(640, 700)
  await capture('connections-640')
  settings.setMinimumSize(360, 480)
  settings.setContentSize(390, 844)
  await capture('connections-mobile')
  settings.setContentSize(920, 700)
  await settled()
  await click('移除接入')
  await until(async () => !(await state()).claudeInstalled)
  await click('处理记录')
  await until(() => evaluate('document.querySelectorAll(".automation-history li").length === 2'))
  await capture('settings-history')
  await click('清空记录')
  await until(() => evaluate('!!document.querySelector(".settings-empty")'))
  await capture('settings-history-empty')
  await click('远程接管')
  await capture('remote-empty')
  for (const [agent, label] of [['cursor', 'Cursor'], ['gemini', 'Gemini CLI'], ['claude', 'Claude Code']]) {
    await click(`安装 ${label} 接管`)
    await until(async () => (await state()).remoteHooks[agent].installed)
    const installedHook = JSON.parse(await fs.readFile((await state()).remoteHooks[agent].file, 'utf8'))
    assert.ok(JSON.stringify(installedHook).includes('cute-island-remote-hook'))
  }
  await capture('remote-hooks-installed')
  await evaluate('document.querySelectorAll(".hook-integration")[1].scrollIntoView()')
  await capture('remote-hooks-lower')
  await evaluate('window.scrollTo(0, 0)')
  // The headless Hook path bypasses the desktop singleton and prints only native JSON.
  for (const [agent, event] of [['cursor', 'beforeShellExecution'], ['gemini', 'BeforeTool']]) {
    const launcher = path.join(app.getPath('userData'), 'hooks', `cute-island-remote-hook.${process.platform === 'win32' ? 'cmd' : 'sh'}`)
    const child = spawn(`"${launcher}" --agent ${agent} --event ${event} --config "${process.env.CUTE_ISLAND_REMOTE_CONFIG}"`, [], {
      shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'ISLAND_SETTINGS_PHASE'].includes(key)))
    })
    const exited = once(child, 'exit'); let output = '', diagnostic = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { diagnostic += bytes })
    child.stdin.end(JSON.stringify({ session_id: 'fixture', conversation_id: 'fixture', tool_name: 'run_shell_command', tool_input: { command: 'echo fixture' } }))
    const [code] = await exited
    assert.equal(code, 0, diagnostic)
    assert.deepEqual(JSON.parse(output), agent === 'cursor' ? { permission: 'allow' } : {})
    assert.equal(BrowserWindow.getAllWindows().length, 2)
  }
  for (const [agent, label] of [['cursor', 'Cursor'], ['gemini', 'Gemini CLI'], ['claude', 'Claude Code']]) {
    await click(`移除 ${label} 接管`)
    await until(async () => !(await state()).remoteHooks[agent].installed)
  }

  await evaluate('document.querySelector(".remote-add button").click()')
  const fill = (index, value) => evaluate(`(() => { const input = document.querySelectorAll('.remote-editor input')[${index}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await fill(0, 'telegram-fixture')
  await fill(1, '123456')
  await fill(2, 'ISLAND_SMOKE_FAKE_BOT_TOKEN')
  await fill(3, '987654,456789')
  await click('保存渠道配置')
  await until(async () => (await state()).remote.channels.length === 1)
  const savedRemote = JSON.parse(await fs.readFile(process.env.CUTE_ISLAND_REMOTE_CONFIG, 'utf8'))
  assert.deepEqual(savedRemote.channels[0].allowedUsers, ['987654', '456789'])
  assert.equal(savedRemote.enabled, false)
  assert.ok(!(JSON.stringify(await state())).includes(savedRemote.controlToken))
  await capture('remote-desktop')
  await evaluate('window.scrollTo(0, document.body.scrollHeight)')
  await capture('remote-desktop-bottom')
  await evaluate('window.scrollTo(0, 0)')
  settings.setContentSize(640, 700)
  await capture('remote-640')
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
  settings.setMinimumSize(360, 480)
  settings.setContentSize(390, 844)
  await capture('remote-mobile')
  await evaluate('window.scrollTo(0, document.body.scrollHeight)')
  await capture('remote-mobile-bottom')
  await evaluate('window.scrollTo(0, 0)')
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
  settings.setContentSize(920, 700)
  // Empty connections keep this fixture entirely offline when exercising takeover.
  await click('移除 Telegram 渠道 1')
  await click('保存渠道配置')
  await until(async () => !(await state()).remote.channels.length)
  await evaluate('document.querySelector("#remote-switch").click()')
  await until(async () => (await state()).remote.enabled)
  assert.equal(trayMenu.find(item => item.id === 'remote-toggle').checked, true)
  for (const [agent, event] of [['cursor', 'beforeShellExecution'], ['gemini', 'BeforeTool']]) {
    const launcher = path.join(app.getPath('userData'), 'hooks', `cute-island-remote-hook.${process.platform === 'win32' ? 'cmd' : 'sh'}`)
    const child = spawn(`"${launcher}" --agent ${agent} --event ${event} --config "${process.env.CUTE_ISLAND_REMOTE_CONFIG}"`, [], { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = once(child, 'exit'); let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.resume()
    child.stdin.end(JSON.stringify({ session_id: `active-${agent}`, conversation_id: `active-${agent}`, tool_name: 'run_shell_command', tool_input: { command: 'echo fixture' } }))
    const base = `http://127.0.0.1:${process.env.CUTE_ISLAND_PORT}/v1/control`
    const headers = { authorization: `Bearer ${savedRemote.controlToken}`, 'content-type': 'application/json' }
    let request
    await until(async () => { const data = await (await fetch(base, { headers })).json(); request = data.requests.find(r => r.status === 'pending' && r.origin === 'hook'); return !!request })
    const response = await fetch(`${base}/requests/${request.id}/respond`, { method: 'POST', headers, body: JSON.stringify({ revision: request.revision, decision: { action: 'approve' } }) })
    assert.equal(response.status, 200)
    assert.equal((await exited)[0], 0)
    assert.deepEqual(JSON.parse(output), agent === 'cursor' ? { permission: 'allow', user_message: '远程确认已收到' } : {})
  }

  assert.deepEqual(await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'during-remote' }), {}, 'Remote takeover suppresses automatic native approvals')
  await click('自动审批')
  await capture('remote-automation-priority')
  trayMenu.find(item => item.id === 'remote-toggle').click({ checked: false })
  await until(async () => !(await state()).remote.enabled)
  assert.equal((await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'after-remote' })).hookSpecificOutput.decision.behavior, 'allow')
  await evaluate('window.island.settingsAction("clear-history")')
  trayMenu.find(item => item.label === '配置远程接管…').click()
  await until(() => evaluate('document.querySelector("h1").textContent === "远程接管"'))
  await click('自动审批')
  settings.setMinimumSize(360, 480)
  settings.setContentSize(640, 620)
  await capture('settings-640')
  settings.setContentSize(390, 844)
  await capture('mobile')
  assert.equal(await evaluate('document.documentElement.scrollWidth > window.innerWidth'), false)
  settings.setContentSize(920, 700)
  console.log('Verified settings pages and responsive captures')
  await evaluate('document.querySelector("[role=switch]").click()')
  await until(async () => !(await state()).preferences.automation.enabled)
  assert.deepEqual(await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }), {})
  console.log('Verified pause')
  settings.close()
  await until(() => BrowserWindow.getAllWindows().length === 1)
  const island = BrowserWindow.getAllWindows()[0]
  assert.ok(island && !island.isDestroyed(), 'Closing settings keeps the island running')
  await island.webContents.executeJavaScript('window.island.openSettings()')
  await until(() => BrowserWindow.getAllWindows().length === 2)
  settings = BrowserWindow.getAllWindows().find(win => win !== island)
  evaluate = script => settings.webContents.executeJavaScript(script, true)
  await until(() => evaluate('!!document.querySelector(".automation-master")'))
  await island.webContents.executeJavaScript('window.island.openSettings()')
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'Settings is a singleton')
  await assert.rejects(island.webContents.executeJavaScript('window.island.updateSettings({ automation: { enabled: true } })'))
  assert.deepEqual(errors, [])
  console.log('Settings, tray sync, Claude native approval/answer, pause, integration, history, window lifecycle and responsive layout passed')
  app.quit()
}

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-settings-'))
  const listener = net.createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  try {
    for (const phase of ['main', 'restore']) {
      const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`, '--settings'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CUTE_ISLAND_DISABLE_GPU: '1', CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: '',
          CUTE_ISLAND_REMOTE_CONFIG: path.join(profile, 'remote.json'), CUTE_ISLAND_PORT: String(port), ELECTRON_RENDERER_URL: '', CLAUDE_CONFIG_DIR: path.join(profile, 'claude'), CURSOR_HOME: path.join(profile, 'cursor'), GEMINI_CLI_HOME: path.join(profile, 'gemini'), CODEX_HOME: path.join(profile, 'codex'), ISLAND_SETTINGS_PHASE: phase }
      })
      let logs = ''
      child.stdout.on('data', value => { logs += value })
      child.stderr.on('data', value => { logs += value })
      const timeout = setTimeout(() => child.kill(), 45000)
      const [code] = await once(child, 'exit')
      clearTimeout(timeout)
      console.log(logs)
      assert.equal(code, 0)
    }
  } finally {
    if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('island-settings-')) throw new Error('Unexpected temporary path')
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

(process.versions.electron ? fixture() : main()).catch(error => {
  console.error(error)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})
