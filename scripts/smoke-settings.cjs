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
  app.getVersion = () => require('../package.json').version
  let trayMenu = []
  const buildMenu = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = template => { if (template.some(item => item.label === '托管模式')) trayMenu = template; return buildMenu(template) }
  // Paint without covering the user's desktop or taking keyboard focus.
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.show = function () { this.setPosition(-10000, -10000); showInactive.call(this) }
  BrowserWindow.prototype.showInactive = function () { this.setPosition(-10000, -10000); showInactive.call(this) }
  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().endsWith('#settings')))
  let settings = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#settings'))
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
  const capture = async name => { await delay(220); await fs.writeFile(path.join(artifacts, `${name}.png`), (await settings.webContents.capturePage()).toPNG()) }
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
  await capture('settings-connections')
  await settled()
  await click('移除接入')
  await until(async () => !(await state()).claudeInstalled)
  await click('处理记录')
  await until(() => evaluate('document.querySelectorAll(".automation-history li").length === 2'))
  await capture('settings-history')
  await click('清空记录')
  await until(() => evaluate('!!document.querySelector(".settings-empty")'))
  await capture('settings-history-empty')
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
          CUTE_ISLAND_PORT: String(port), ELECTRON_RENDERER_URL: '', CLAUDE_CONFIG_DIR: path.join(profile, 'claude'), ISLAND_SETTINGS_PHASE: phase }
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
