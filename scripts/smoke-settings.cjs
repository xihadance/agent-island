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
  const { app, BrowserWindow, Menu, nativeTheme } = require('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.getVersion = () => require('../package.json').version
  app.getAppPath = () => path.resolve('.')
  // Update checks are packaged-only; the fixture serves its own feed on 127.0.0.1.
  Object.defineProperty(app, 'isPackaged', { get: () => process.env.ISLAND_FAKE_PACKAGED === '1' })
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
  const evaluateSettings = script => settings.webContents.executeJavaScript(script, true).catch(error => { throw new Error(`Renderer check failed: ${script}`, { cause: error }) })
  let evaluate = evaluateSettings
  await until(() => evaluate('!!document.querySelector(".automation-master")'))
  const errors = []
  settings.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message) })
  const state = () => evaluate('window.island.getSettings()')
  const launcherFile = path.join(app.getPath('userData'), 'hooks', `cute-island-remote-hook.${process.platform === 'win32' ? 'cmd' : 'sh'}`)
  if (process.env.ISLAND_SETTINGS_PHASE === 'restore') {
    const restored = await state()
    assert.equal(restored.preferences.mode, 'managed')
    assert.equal(restored.preferences.automation.enabled, false)
    assert.equal(restored.preferences.automation.fallback, 'first')
    assert.deepEqual(restored.preferences.automation.blacklist, ['git push', '.env'])
    assert.equal(await evaluate('document.querySelector("#automation-blacklist").value'), 'git push\n.env')
    assert.equal(restored.preferences.theme, 'dark')
    assert.equal(Object.hasOwn(restored.preferences.codexServer, 'profile'), false)
    assert.equal(nativeTheme.themeSource, 'dark')
    assert.equal(restored.preferences.update.skippedVersion, '', 'A cancelled skip survives the restart')
    await until(() => evaluate('document.body.dataset.theme === "dark"'))
    // An application update moves the Electron runner, so the launcher is rewritten on boot.
    assert.ok(restored.remoteHooks.claude.installed, 'The hook left installed is still registered')
    const launcher = await fs.readFile(launcherFile, 'utf8')
    assert.ok(!launcher.includes('STALE-RUNNER'), 'A stale launcher is replaced on boot')
    assert.ok(launcher.includes(process.execPath) && launcher.includes('remote hook'), launcher)
    console.log('Settings restart persistence and hook launcher refresh passed')
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
  const editBlacklist = value => evaluate(`(() => { const field = document.querySelector('#automation-blacklist'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await settled()
  await editBlacklist(' git push \n.env\nGIT PUSH\n')
  assert.ok(await evaluate('document.querySelector(".settings-save-status").textContent.includes("未保存")'))
  assert.deepEqual((await state()).preferences.automation.blacklist, [])
  await click('常规')
  await click('自动审批')
  assert.equal(await evaluate('document.querySelector("#automation-blacklist").value'), ' git push \n.env\nGIT PUSH\n')
  await click('保存黑名单')
  await settled()
  assert.deepEqual((await state()).preferences.automation.blacklist, ['git push', '.env'])
  assert.equal(await evaluate('document.querySelector("#automation-blacklist").value'), 'git push\n.env')
  const blocked = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git PUSH origin main' } }
  assert.deepEqual(await post(blocked), {})
  assert.equal((await post({ ...blocked, tool_input: { command: 'git status' } })).hookSpecificOutput.decision.behavior, 'allow')
  await editBlacklist('unsaved')
  await click('撤销修改')
  assert.equal(await evaluate('document.querySelector("#automation-blacklist").value'), 'git push\n.env')
  await editBlacklist('')
  await click('保存黑名单')
  await settled()
  assert.equal((await post(blocked)).hookSpecificOutput.decision.behavior, 'allow')
  await editBlacklist('git push\n.env')
  await click('保存黑名单')
  await settled()
  console.log('Blacklist editing, normalization, manual fallback, clearing and saved state passed')
  await capture('desktop')
  await evaluate('document.querySelector("#question-fallback").value = "first"; document.querySelector("#question-fallback").dispatchEvent(new Event("change", { bubbles: true }))')
  await until(async () => (await state()).preferences.automation.fallback === 'first')
  await click('常规')
  await evaluate('document.querySelectorAll("input[name=island-mode]")[1].click()')
  await until(async () => (await state()).preferences.mode === 'managed')
  assert.equal(trayMenu.find(item => item.label === '托管模式').checked, true)
  await capture('settings-general')
  trayMenu.find(item => item.label === '关注模式').click()
  await until(() => evaluate('document.querySelectorAll("input[name=island-mode]")[0].checked'))
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
  assert.equal(await evaluate('document.querySelector("#codex-server-profile") === null'), true)
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
  const historyCount = (await state()).history.length
  await until(() => evaluate(`document.querySelectorAll('.automation-history li').length === ${historyCount}`))
  assert.ok(await evaluate('Array.from(document.querySelectorAll(".automation-history li")).some(el => el.textContent.includes("黑名单") && el.textContent.includes("交给你处理"))'))
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
  const { WebSocketServer } = require('ws')
  const codexFixture = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(codexFixture, 'listening')
  codexFixture.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString())
    if (message.id === undefined) return
    socket.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: [] } : {} }))
  }))
  await click('添加 Codex 连接')
  await fill(4, 'codex-auto-fixture')
  await fill(5, `ws://127.0.0.1:${codexFixture.address().port}`)
  assert.equal(await evaluate('document.querySelectorAll(".remote-editor input")[6].required'), false)
  assert.equal(await evaluate('document.querySelectorAll(".remote-editor input")[6].value'), '')
  await evaluate(`document.querySelector('button[aria-label="测试 Codex 连接 1 的连通性"]').click()`)
  await until(() => evaluate('Array.from(document.querySelectorAll(".remote-test-result")).some(el => el.textContent.includes("新会话也会自动发现"))'))
  await click('保存渠道配置')
  await until(async () => (await state()).remote.channels.length === 1 && (await state()).remote.codex.length === 1)
  const savedRemote = JSON.parse(await fs.readFile(process.env.CUTE_ISLAND_REMOTE_CONFIG, 'utf8'))
  assert.deepEqual(savedRemote.channels[0].allowedUsers, ['987654', '456789'])
  assert.equal(savedRemote.enabled, false)
  assert.deepEqual(savedRemote.codex[0].threads, [])
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
  await click('移除 Codex 连接 1')
  await click('保存渠道配置')
  await until(async () => !(await state()).remote.channels.length && !(await state()).remote.codex.length)
  for (const client of codexFixture.clients) client.terminate()
  await new Promise(resolve => codexFixture.close(resolve))
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
  const controlBase = `http://127.0.0.1:${process.env.CUTE_ISLAND_PORT}/v1/control`
  const controlHeaders = { authorization: `Bearer ${savedRemote.controlToken}`, 'content-type': 'application/json' }
  const remoteHook = async (invocationId, event) => fetch(`${controlBase}/hook`, { method: 'POST', headers: controlHeaders,
    body: JSON.stringify({ agent: 'claude', invocationId, event: { session_id: 'automation-smoke', ...event } }) })
  const automatic = await remoteHook('permission', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  assert.equal(automatic.status, 200)
  const automaticReply = await automatic.json()
  assert.equal(automaticReply.output.hookSpecificOutput.decision.behavior, 'allow')
  assert.equal(automaticReply.requestId, undefined)
  assert.equal((await remoteHook('permission', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } })).status, 409)
  const answerReply = await (await remoteHook('answer', question)).json()
  assert.deepEqual(answerReply.output.hookSpecificOutput.updatedInput.answers, { '用哪个？': 'B（推荐）' })
  await evaluate('window.island.updateSettings({automation:{fallback:"manual"}})')
  const fallback = await (await remoteHook('fallback', { ...question,
    tool_input: { questions: [{ question: '请选择', options: [{ label: 'A' }, { label: 'B' }] }] } })).json()
  assert.ok(fallback.requestId)
  const pendingState = await (await fetch(controlBase, { headers: controlHeaders })).json()
  const pendingQuestion = pendingState.requests.find(request => request.id === fallback.requestId)
  assert.equal(pendingQuestion.kind, 'input')
  assert.equal(pendingQuestion.status, 'pending')
  await evaluate('window.island.updateSettings({automation:{fallback:"first"}})')
  await click('自动审批')
  assert.equal(await evaluate('document.querySelector(".automation-master").dataset.enabled'), 'true')
  assert.ok(await evaluate('document.querySelector(".automation-master-foot").textContent.includes("先自动处理，再转远程")'))
  await capture('remote-automation-priority')
  settings.setContentSize(640, 620)
  await capture('remote-automation-640')
  assert.equal(await evaluate('document.documentElement.scrollWidth > window.innerWidth'), false)
  settings.setContentSize(920, 700)
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
  // Theme controls use the same durable preferences as all other settings.
  await click('常规')
  await evaluate('document.querySelector("[data-testid=theme-light]").click()')
  await until(async () => (await state()).preferences.theme === 'light')
  assert.equal(nativeTheme.themeSource, 'light')
  assert.equal(settings.getBackgroundColor().toLowerCase(), '#eef0f3')
  await settled()
  settings.webContents.debugger.attach('1.3')
  await evaluate('document.querySelector("[data-testid=theme-light]").focus()')
  // The off-screen fixture has no OS focus; send native input directly to its renderer.
  await settings.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await settings.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await until(async () => (await state()).preferences.theme === 'dark')
  // The stored preference lands one tick before the form re-enables; a click on a
  // still-disabled radio is dropped, which a real user cannot do.
  await settled()
  await evaluate('document.querySelector("[data-testid=theme-system]").click()')
  await until(async () => (await state()).preferences.theme === 'system')
  assert.equal(nativeTheme.themeSource, 'system')
  for (const theme of ['light', 'dark']) {
    await settings.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await until(() => evaluate(`document.body.dataset.theme === '${theme}'`))
  }
  await evaluate('document.querySelector("[data-testid=theme-light]").click()')
  await until(async () => (await state()).preferences.theme === 'light')
  assert.equal(await evaluate('document.body.dataset.theme'), 'light', 'Explicit theme overrides system dark')
  settings.webContents.debugger.detach()
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.querySelector('[data-testid=theme-quick-${theme}]').click()`)
    await until(async () => (await state()).preferences.theme === theme)
    for (const [label, slug] of [['常规','general'],['自动审批','automation'],['Agent 接入','connections'],['远程接管','remote'],['处理记录','history']]) {
      await click(label)
      await evaluate('window.scrollTo(0, 0)')
      await capture(`theme-${theme}-${slug}`)
      if (slug === 'automation') {
        await editBlacklist('git push\n.env\n生产环境')
        for (const [width, height] of [[920, 700], [640, 700], [390, 844]]) {
          settings.setContentSize(width, height)
          await evaluate('document.querySelector("#blacklist-title").scrollIntoView()')
          await capture(`blacklist-${theme}-${width}`)
          assert.equal(await evaluate('document.documentElement.scrollWidth > window.innerWidth'), false)
        }
        await click('撤销修改')
        settings.setContentSize(920, 700)
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth > window.innerWidth'), false)
    }
    await click('远程接管')
    await evaluate('document.querySelector(".remote-add button").click()')
    await until(() => evaluate('!!document.querySelector(".remote-editor")'))
    await evaluate('document.querySelector(".remote-editor").scrollIntoView()')
    await capture(`theme-${theme}-remote-fields`)
    settings.setContentSize(640, 700)
    await click('常规')
    await evaluate('window.scrollTo(0, 0)')
    await capture(`theme-${theme}-general-640`)
    assert.equal(await evaluate('document.documentElement.scrollWidth > window.innerWidth'), false)
    settings.setContentSize(390, 844)
    for (const [label, slug] of [['常规','general'],['远程接管','remote']]) {
      await click(label)
      await evaluate('window.scrollTo(0, 0)')
      await capture(`theme-${theme}-${slug}-mobile`)
      assert.equal(await evaluate('document.documentElement.scrollWidth > window.innerWidth'), false)
      assert.equal(await evaluate('Array.from(document.querySelectorAll(".theme-quick svg")).every(icon => icon.getBoundingClientRect().width > 0)'), true)
    }
    await evaluate('document.querySelector(".remote-editor").scrollIntoView()')
    await capture(`theme-${theme}-remote-fields-mobile`)
    await click('移除 Telegram 渠道 1')
    settings.setContentSize(920, 700)
  }
  console.log('Theme switching, native background, system changes, explicit override, keyboard and all themed sections passed')

  // Version checks: the switch, the environment override and a newer release, all against a local feed.
  await click('常规')
  const current = require('../package.json').version
  const next = current.replace(/(\d+)$/, (_, patch) => String(Number(patch) + 1))
  assert.equal((await state()).update.status, 'disabled', 'Unpackaged builds never query a release feed')
  assert.equal(await evaluate('!!document.querySelector(".update-available")'), false)
  let feedRequests = 0
  let feedBody = JSON.stringify({ tag_name: `v${next}`, html_url: `https://github.com/xihadance/agent-island/releases/tag/v${next}`,
    body: `## v${next}\n\n- 冒烟替身版本说明`, published_at: '2026-02-01T10:00:00Z' })
  const feed = require('node:http').createServer((request, response) => {
    feedRequests++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(feedBody)
  })
  feed.listen(0, '127.0.0.1')
  await once(feed, 'listening')
  process.env.CUTE_ISLAND_UPDATE_FEED = `http://127.0.0.1:${feed.address().port}/releases/latest`
  process.env.ISLAND_FAKE_PACKAGED = '1'
  await evaluate('window.island.updateSettings({ update: { enabled: false } })')
  await until(async () => (await state()).update.status === 'disabled')
  await evaluate('window.island.settingsAction("update-check")')
  await delay(200)
  assert.equal(feedRequests, 0, 'A disabled switch suppresses the request')
  await evaluate('window.island.updateSettings({ update: { enabled: true } })')
  await until(async () => (await state()).update.status === 'idle')
  await evaluate('window.island.settingsAction("update-check")')
  await until(async () => (await state()).update.status === 'available')
  assert.equal(feedRequests, 1)
  assert.deepEqual((await state()).update.available, { version: next, tag: `v${next}`,
    url: `https://github.com/xihadance/agent-island/releases/tag/v${next}`, notes: `## v${next}\n\n- 冒烟替身版本说明`, publishedAt: Date.parse('2026-02-01T10:00:00Z') })
  await until(() => evaluate('!!document.querySelector(".update-available")'))
  assert.ok((await evaluate('document.querySelector(".update-notes").textContent')).includes('冒烟替身版本说明'))
  assert.ok((await evaluate('document.querySelector(".settings-update-link").textContent')).includes(next))
  await capture('settings-update-available')
  assert.ok((await state()).preferences.update.lastCheckedAt > 0, 'The check time is persisted')
  await click('跳过此版本')
  await until(async () => (await state()).update.status === 'idle')
  assert.equal(await evaluate('!!document.querySelector(".update-available")'), false)
  assert.equal(await evaluate('!!document.querySelector(".settings-update-link")'), false)
  assert.equal((await state()).preferences.update.skippedVersion, next)
  await click(`取消跳过 ${next}`)
  await until(async () => (await state()).update.status === 'available')
  // A malformed or hostile payload must leave the offer untouched rather than prompting.
  for (const hostile of [JSON.stringify({ tag_name: `v${next}`, html_url: 'https://github.com/attacker/cute-island/releases/tag/v9.9.9' }), '{broken']) {
    feedBody = hostile
    await evaluate('window.island.settingsAction("update-check")')
    await until(async () => (await state()).update.status !== 'checking')
    assert.equal((await state()).update.available.version, next, 'A rejected payload keeps the last valid release')
  }
  // Auto-install is offered on Windows and AppImage only, and never acts on an unstaged update.
  const expectedAutoInstall = process.platform === 'win32'
  assert.equal((await state()).update.autoInstall, expectedAutoInstall)
  assert.equal(await evaluate('!!Array.from(document.querySelectorAll("button")).find(el => el.textContent.trim() === "下载更新")'), expectedAutoInstall)
  assert.equal(await evaluate('!!Array.from(document.querySelectorAll("button")).find(el => el.textContent.trim() === "前往下载")'), !expectedAutoInstall)
  const updateActionError = async name => {
    const message = await settings.webContents.executeJavaScript(
      `window.island.settingsAction(${JSON.stringify(name)}).then(() => '', error => String(error && error.message || error))`, true)
    assert.ok(message, `${name} should have been refused`)
    return message
  }
  assert.match(await updateActionError('update-install'), /更新尚未下载完成/)
  if (expectedAutoInstall) {
    // The release feed decides what is offered; a feed without matching installer metadata must fail loudly.
    assert.match(await updateActionError('update-download'), /发布页|安装包|不一致|ENOTFOUND|404|HttpError|net::|yml/)
    await until(async () => (await state()).update.status !== 'downloading')
    assert.equal((await state()).update.available.version, next, 'A failed download keeps the offer')
    assert.match(await updateActionError('update-install'), /更新尚未下载完成/)
  }

  process.env.CUTE_ISLAND_UPDATE = '0'
  await evaluate('window.island.updateSettings({ update: { enabled: true } })')
  await until(async () => (await state()).update.status === 'disabled')
  const quiet = feedRequests
  await evaluate('window.island.settingsAction("update-check")')
  await delay(200)
  assert.equal(feedRequests, quiet, 'CUTE_ISLAND_UPDATE=0 outranks the interface switch')
  delete process.env.CUTE_ISLAND_UPDATE
  delete process.env.CUTE_ISLAND_UPDATE_FEED
  process.env.ISLAND_FAKE_PACKAGED = '0'
  await new Promise(resolve => feed.close(resolve))
  console.log('Update checking, switch precedence, skip, hostile payload rejection and persistence passed')

  await click('自动审批')
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
  evaluate = evaluateSettings
  await until(() => evaluate('!!document.querySelector(".automation-master")'))
  await island.webContents.executeJavaScript('window.island.openSettings()')
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'Settings is a singleton')
  await assert.rejects(island.webContents.executeJavaScript('window.island.updateSettings({ automation: { enabled: true } })'))
  assert.deepEqual(errors, [])
  // Leave a hook installed with a stale launcher; the restore phase checks the boot refresh.
  await evaluate('window.island.setRemoteIntegration("claude", true)')
  await until(async () => (await state()).remoteHooks.claude.installed)
  await fs.writeFile(launcherFile, 'STALE-RUNNER\n')
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
      const env = { ...process.env, CUTE_ISLAND_DISABLE_GPU: '1', CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: '',
        CUTE_ISLAND_REMOTE_CONFIG: path.join(profile, 'remote.json'), CUTE_ISLAND_PORT: String(port), ELECTRON_RENDERER_URL: '', CLAUDE_CONFIG_DIR: path.join(profile, 'claude'), CURSOR_HOME: path.join(profile, 'cursor'), GEMINI_CLI_HOME: path.join(profile, 'gemini'), CODEX_HOME: path.join(profile, 'codex'), ISLAND_SETTINGS_PHASE: phase }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`, '--settings'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env
      })
      let logs = ''
      child.stdout.on('data', value => { logs += value })
      child.stderr.on('data', value => { logs += value })
      const timeout = setTimeout(() => child.kill(), 90000)
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
