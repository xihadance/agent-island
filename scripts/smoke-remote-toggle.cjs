// npm run build && node scripts/smoke-remote-toggle.cjs
// Real Electron tray callbacks and compiled CLI, with an isolated profile and no channels.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture() {
  const { app, Menu, BrowserWindow, dialog, shell } = require('electron')
  await app.whenReady()
  const errors = []
  const opened = []
  dialog.showErrorBox = (title, message) => errors.push({ title, message })
  shell.openPath = async file => { opened.push(file); return '' }
  let template = [], menu
  const build = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = items => {
    const result = build(items)
    if (items.some(item => item.id === 'remote-toggle')) { template = items; menu = result }
    return result
  }
  // The menu is native; no need to show or focus a window for this fixture.
  BrowserWindow.prototype.showInactive = function () {}
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.focus = function () {}
  const server = require('node:http').createServer(async (request, response) => {
    if (request.method === 'POST') {
      if (request.url.startsWith('/toggle/')) template.find(item => item.id === 'remote-toggle').click({ checked: request.url.endsWith('/true') })
      else if (request.url === '/managed') template.find(item => item.label === '托管模式').click()
      else if (request.url === '/configure') template.find(item => item.label === '配置远程接管…').click()
    }
    const toggle = menu?.getMenuItemById('remote-toggle')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ toggle: toggle && { checked: toggle.checked, enabled: toggle.enabled, label: toggle.label },
      mode: menu?.items.find(item => item.type === 'radio' && item.checked)?.label, windows: BrowserWindow.getAllWindows().length, settings: BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('#settings')), opened, errors }))
  }).listen(Number(process.env.ISLAND_FIXTURE_PORT), '127.0.0.1')
  app.on('will-quit', () => server.close())
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
  for (let i = 0; i < 100; i++) {
    try { const result = await check(); if (result) return result } catch {}
    await delay(100)
  }
  throw new Error('Timed out waiting for the desktop control service')
}

async function smoke() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-remote-smoke-'))
  const [port, fixturePort] = await Promise.all([freePort(), freePort()])
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ mode: 'focus' }))
  const file = path.join(profile, 'remote.json')
  const config = { mode: 'takeover', enabled: false, port, controlToken: 'isolated-smoke-token-'.repeat(3), stateFile: 'state.json', channels: [], codex: [] }
  await fs.writeFile(file, JSON.stringify(config))
  const base = `http://127.0.0.1:${port}/v1/control`
  const headers = { authorization: `Bearer ${config.controlToken}`, 'content-type': 'application/json' }
  const ui = (route = '', method = 'GET') => fetch(`http://127.0.0.1:${fixturePort}${route}`, { method }).then(r => r.json())
  const status = () => fetch(base, { headers }).then(r => r.json())
  let child, hook, logs = ''
  const start = () => {
    const env = { ...process.env, CUTE_ISLAND_REMOTE_CONFIG: file, CUTE_ISLAND_PORT: String(port), ISLAND_FIXTURE_PORT: String(fixturePort),
      CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: '', ELECTRON_RENDERER_URL: '' }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    child.stdout.on('data', value => { logs += value })
    child.stderr.on('data', value => { logs += value })
  }
  const stop = async () => {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  }
  try {
    start()
    await until(async () => (await ui()).toggle)
    assert.equal((await ui()).toggle.checked, false)
    assert.deepEqual((await status()).control, { enabled: false, running: false })
    await ui('/managed', 'POST')
    await ui('/toggle/true', 'POST')
    assert.equal((await ui()).toggle.checked, true)
    assert.equal((await ui()).mode, '托管模式')
    assert.deepEqual((await status()).control, { enabled: true, running: true })

    hook = spawn(process.execPath, [path.resolve('out/cli.cjs'), 'remote', 'hook', '--agent', 'claude', '--config', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const hookExit = once(hook, 'exit')
    let output = ''
    hook.stdout.on('data', value => { output += value })
    hook.stderr.on('data', value => { logs += value })
    hook.stdin.end(JSON.stringify({ session_id: 'smoke', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    const request = await until(async () => (await status()).requests.find(r => r.status === 'pending'))
    await ui('/toggle/false', 'POST')
    await until(() => hook.exitCode !== null)
    assert.equal((await hookExit)[0], 0)
    assert.deepEqual(JSON.parse(output), {})
    assert.equal((await ui()).toggle.checked, false)
    assert.equal((await ui()).mode, '托管模式')
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).enabled, false)

    await fetch(`${base}/enabled`, { method: 'POST', headers, body: JSON.stringify({ enabled: true }) })
    assert.equal((await ui()).toggle.checked, true, 'HTTP and tray share the same switch')
    const stale = await fetch(`${base}/requests/${request.id}/respond`, { method: 'POST', headers, body: JSON.stringify({ revision: request.revision, decision: { action: 'approve' } }) })
    assert.equal(stale.status, 409)
    await ui('/toggle/false', 'POST')
    await stop(); start()
    await until(async () => (await ui()).toggle)
    assert.equal((await ui()).toggle.checked, false)
    assert.equal((await ui()).mode, '托管模式')
    assert.deepEqual((await status()).control, { enabled: false, running: false })
    assert.deepEqual((await ui()).errors, [])

    const stateFile = path.join(profile, 'state.json')
    const healthyState = await fs.readFile(stateFile, 'utf8')
    const failures = [
      { name: 'malformed config', config: '{"controlToken":"must-not-leak-to-logs",', state: healthyState },
      { name: 'incomplete disabled config', config: JSON.stringify({ mode: 'takeover', enabled: false }), state: healthyState },
      { name: 'damaged disabled state', config: JSON.stringify(config), state: '{broken' },
      { name: 'damaged enabled state', config: JSON.stringify({ ...config, enabled: true }), state: '{"version":1}' }
    ]
    for (const failure of failures) {
      await stop()
      await fs.writeFile(file, failure.config)
      await fs.writeFile(stateFile, failure.state)
      start()
      const current = await until(async () => { const state = await ui(); return state.toggle && state.windows ? state : undefined })
      assert.equal(current.windows, 1, `${failure.name}: desktop window starts`)
      assert.match(current.toggle.label, /不可用/, `${failure.name}: tray reports unavailable control`)
      assert.equal(current.toggle.checked, false)
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/activities`)).status, 200, `${failure.name}: public API remains available`)
      assert.equal((await fetch(base, { headers })).status, 503)
      await ui('/configure', 'POST')
      await until(async () => (await ui()).settings)
      assert.equal((await ui()).settings, true, `${failure.name}: configuration window remains available`)
      assert.equal(await fs.readFile(file, 'utf8'), failure.config, 'Opening configuration must not overwrite it')
      assert.equal(await fs.readFile(stateFile, 'utf8'), failure.state, 'Damaged state must not be silently reset')
      await fs.writeFile(file, JSON.stringify(config))
      await fs.writeFile(stateFile, healthyState)
      await ui('/toggle/true', 'POST')
      assert.equal((await ui()).toggle.checked, true, `${failure.name}: recovery works without restarting the desktop`)
      assert.doesNotMatch((await ui()).toggle.label, /不可用/)
      assert.deepEqual((await status()).control, { enabled: true, running: true })
      assert.deepEqual((await ui()).errors, [])
    }
    assert.ok(!logs.includes('must-not-leak-to-logs'), 'Parse errors must not log configuration contents')
    console.log(JSON.stringify({ result: 'passed', trayToggle: true, compiledHookRelease: true, staleApprovalRejected: true, displayModeIndependent: true, restartPersistence: true,
      badConfigIsolation: true, badStateIsolation: true, configurationRecovery: true }))
  } catch (error) { console.error(logs.slice(-2500)); throw error }
  finally {
    if (hook && hook.exitCode === null) { const exited = once(hook, 'exit'); hook.kill(); await exited }
    await stop()
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()))
    assert.ok(path.basename(profile).startsWith('island-remote-smoke-'))
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

(process.versions.electron ? fixture() : smoke()).catch(error => { console.error(error); process.exitCode = 1 })
