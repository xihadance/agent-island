// npm run build && node scripts/smoke-update.cjs
// Real renderer, updater quit handler and proxy session; no installer is launched.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(50) }
  throw new Error('Timed out waiting for update state')
}

async function fixture() {
  const { app, BrowserWindow } = require('electron')
  const { autoUpdater, BaseUpdater } = require('electron-updater')
  const { createServer } = require('node:http')
  const current = require('../package.json').version
  const next = current.replace(/(\d+)$/, (_, patch) => String(Number(patch) + 1))
  app.getVersion = () => current
  app.getAppPath = () => path.resolve('.')
  Object.defineProperty(app, 'isPackaged', { get: () => true })
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.show = function () { this.setPosition(-10000, -10000); showInactive.call(this) }
  BrowserWindow.prototype.showInactive = BrowserWindow.prototype.show

  let proxyRequests = 0
  let installs = 0
  const proxy = createServer((request, response) => {
    assert.match(request.url, /^http:\/\/updates\.invalid\/(metadata|artifact)$/)
    proxyRequests++
    response.end('isolated update fixture')
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  const feed = createServer((_request, response) => response.end(JSON.stringify({ tag_name: `v${next}`,
    html_url: `https://github.com/xihadance/agent-island/releases/tag/v${next}` })))
  feed.listen(0, '127.0.0.1'); await once(feed, 'listening')
  process.env.CUTE_ISLAND_UPDATE_FEED = `http://127.0.0.1:${feed.address().port}`
  const proxiedRequest = route => autoUpdater.httpExecutor.request({ protocol: 'http:', hostname: 'updates.invalid', path: `/${route}`, method: 'GET' })
  autoUpdater.checkForUpdates = async () => { await proxiedRequest('metadata'); return { updateInfo: { version: next } } }
  autoUpdater.downloadUpdate = async () => { await proxiedRequest('artifact'); BaseUpdater.prototype.addQuitHandler.call(autoUpdater); return [] }
  autoUpdater.install = () => { installs++; return true }

  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().endsWith('#settings')))
  const settings = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#settings'))
  const evaluate = script => settings.webContents.executeJavaScript(script, true)
  await until(() => evaluate('!!document.querySelector(".settings-shell[data-ready]")'))
  await evaluate('window.location.hash = "settings/general"')
  const state = () => evaluate('window.island.getSettings()')
  await evaluate('window.island.settingsAction("update-check")')
  await until(async () => (await state()).update.status === 'available')
  if ((await state()).update.autoInstall) {
    const config = { mode: 'takeover', enabled: false, port: Number(process.env.CUTE_ISLAND_PORT), controlToken: 'isolated-update-control-token-123456',
      stateFile: path.join(app.getPath('userData'), 'remote-state.json'), channels: [], codex: [], proxy: { mode: 'custom', url: proxyUrl } }
    await fs.writeFile(process.env.CUTE_ISLAND_REMOTE_CONFIG, JSON.stringify(config))
    const endpoint = `http://127.0.0.1:${process.env.CUTE_ISLAND_PORT}/v1/activities`
    const post = async (url, body) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 200)
    }
    await post(endpoint, { id: 'update-smoke', state: 'running', title: '更新冒烟会话' })
    await evaluate('window.island.settingsAction("update-download")')
    assert.equal(proxyRequests, 2, 'Metadata and artifact both use the custom proxy')
    const button = 'Array.from(document.querySelectorAll("button")).find(el => el.textContent === "重启并安装")'
    await until(() => evaluate(`!!(${button}) && (${button}).disabled`))
    await post(`${endpoint}/update-smoke/end`, { result: 'success' })
    await until(() => evaluate(`!!(${button}) && !(${button}).disabled`))
    await post(endpoint, { id: 'update-smoke-2', state: 'approval', title: '更新冒烟审批' })
    await until(() => evaluate(`(${button}).disabled`))
    await post(`${endpoint}/update-smoke-2/end`, { result: 'success' })
    await until(() => evaluate(`!(${button}).disabled`))
    await evaluate('window.island.setRemoteEnabled(true)')
    const controlEndpoint = `http://127.0.0.1:${process.env.CUTE_ISLAND_PORT}/v1/control`
    const headers = { authorization: `Bearer ${config.controlToken}`, 'content-type': 'application/json' }
    const hook = await fetch(`${controlEndpoint}/hook`, { method: 'POST', headers, body: JSON.stringify({ agent: 'claude', invocationId: 'update-smoke-hook',
      event: { session_id: 'update-smoke-hook', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo fixture' } } }) })
    assert.equal(hook.status, 200)
    const { requestId } = await hook.json()
    await until(() => evaluate(`(${button}).disabled`))
    const requests = await (await fetch(controlEndpoint, { headers })).json()
    const pending = requests.requests.find(request => request.id === requestId)
    const answered = await fetch(`${controlEndpoint}/requests/${requestId}/respond`, { method: 'POST', headers,
      body: JSON.stringify({ revision: pending.revision, decision: { action: 'approve' } }) })
    assert.equal(answered.status, 200)
    await until(() => evaluate(`!(${button}).disabled`))
    await evaluate('window.island.setRemoteEnabled(false)')
    const phase = process.env.ISLAND_UPDATE_PHASE
    if (phase === 'skip') await evaluate(`window.island.updateSettings({ update: { skippedVersion: ${JSON.stringify(next)} } })`)
    if (phase === 'disable') await evaluate('window.island.updateSettings({ update: { enabled: false } })')
    if (phase !== 'install') assert.notEqual((await state()).update.status, 'downloaded')
    app.on('quit', () => {
      assert.equal(installs, phase === 'install' ? 1 : 0, 'Quit respects the current update eligibility')
      console.log(`Update proxy, live install blockers and ${phase} on quit passed`)
    })
  } else console.log('Notify-only platform update check passed')
  await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => feed.close(resolve))])
  app.quit()
}

async function main() {
  const { createServer } = require('node:net')
  for (const phase of ['skip', 'disable', 'install']) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-update-'))
    const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
    try {
      const env = { ...process.env, CUTE_ISLAND_DISABLE_GPU: '1', CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: '', CUTE_ISLAND_PORT: String(port),
        CUTE_ISLAND_REMOTE_CONFIG: path.join(profile, 'remote.json'), CLAUDE_CONFIG_DIR: path.join(profile, 'claude'), CURSOR_HOME: path.join(profile, 'cursor'),
        GEMINI_CLI_HOME: path.join(profile, 'gemini'), CODEX_HOME: path.join(profile, 'codex'), ELECTRON_RENDERER_URL: '', ISLAND_UPDATE_PHASE: phase }
      if (process.platform === 'linux') env.APPIMAGE = path.join(profile, 'fixture.AppImage')
      delete env.CUTE_ISLAND_UPDATE
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`, '--settings'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      let logs = ''
      child.stdout.on('data', value => { logs += value }); child.stderr.on('data', value => { logs += value })
      const timeout = setTimeout(() => child.kill(), 30000)
      const [code] = await once(child, 'exit'); clearTimeout(timeout)
      console.log(logs)
      assert.equal(code, 0)
    } finally {
      if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('island-update-')) throw new Error('Unexpected temporary path')
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
  }
}
(process.versions.electron ? fixture() : main()).catch(error => {
  console.error(error)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})
