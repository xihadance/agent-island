// npm run build && node scripts/smoke-connectivity.cjs
// Real Electron IPC and UI with synthetic credentials, mocked HTTP APIs and a local Codex server.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let attempt = 0; attempt < 120; attempt++) { if (await check()) return; await delay(50) }
  throw new Error('Timed out waiting for connectivity UI')
}

async function fixture() {
  const { app, BrowserWindow, Menu } = require('electron')
  const { WebSocketServer } = require('ws')
  app.getAppPath = () => path.resolve('.')
  app.getVersion = () => require('../package.json').version
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  const rendererRoot = path.resolve('out/renderer')
  const rendererServer = require('node:http').createServer(async (request, response) => {
    const file = path.resolve(rendererRoot, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname))
    if (file !== rendererRoot && !file.startsWith(rendererRoot + path.sep)) { response.writeHead(403).end(); return }
    try {
      response.setHeader('content-type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream')
      response.end(await fs.readFile(file))
    } catch { response.writeHead(404).end() }
  }).listen(Number(process.env.ISLAND_TEST_RENDERER_PORT), '127.0.0.1')
  process.env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${process.env.ISLAND_TEST_RENDERER_PORT}`
  let trayMenu
  const buildMenu = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = template => { const menu = buildMenu(template); if (template.some(item => item.id === 'remote-toggle')) trayMenu = menu; return menu }
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () { this.setPosition(-10000, -10000); showInactive.call(this) }
  const calls = []
  let holdTelegram = true, releaseTelegram
  const fetchFixture = async (url, options) => {
    const target = String(url), data = JSON.parse(options.body)
    calls.push({ url: target.replace(process.env.TEST_TELEGRAM_TOKEN, '[fixture-token]'), data })
    const reply = value => new Response(JSON.stringify(value), { status: 200 })
    if (target.endsWith('/getWebhookInfo')) {
      if (holdTelegram) { holdTelegram = false; await new Promise(resolve => { releaseTelegram = resolve }) }
      return reply({ ok: true, result: { url: '' } })
    }
    if (target.endsWith('/sendMessage')) return reply(data.chat_id === 'blocked' ? { ok: false, error_code: 403 } : { ok: true, result: { message_id: 1 } })
    if (target.includes('/auth/v3/tenant_access_token/internal')) return reply({ code: 0, tenant_access_token: 'synthetic-tenant-token' })
    if (target.includes('/im/v1/messages')) return reply({ code: 0, data: { message_id: 'synthetic-feishu-message' } })
    if (target.startsWith('https://discord.com/api/v10/')) return reply({ id: 'synthetic-discord-message' })
    throw new Error('Unexpected external API in isolated smoke test')
  }
  // Replace the production fetch dependency before the main bundle loads. Every
  // synthetic request stays in-process, even after proxy transport changes.
  const fetchModule = require.resolve('node-fetch')
  require(fetchModule)
  require.cache[fetchModule].exports = fetchFixture
  const codexMessages = []
  const codexServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const codexReady = once(codexServer, 'listening')
  const initial = require('node:fs').readFileSync(process.env.CUTE_ISLAND_REMOTE_CONFIG, 'utf8')
  require('../out/main/index.js')
  await codexReady
  const codexUrl = `ws://127.0.0.1:${codexServer.address().port}`
  codexServer.on('connection', peer => peer.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); codexMessages.push(message)
    if (message.id) peer.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: ['live-thread'] } : {} }))
  }))
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('#settings')))
  const settings = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('#settings'))
  settings.webContents.setBackgroundThrottling(false)
  const errors = []
  settings.webContents.on('console-message', details => { if (details.level === 'error' || details.level === 3) { errors.push(details.message); console.error('Renderer:', details.message) } })
  const evaluate = async script => {
    try { return await settings.webContents.executeJavaScript(script, true) }
    catch (error) { console.error('Failed UI expression:', script); throw error }
  }
  await until(() => evaluate('!!document.querySelector(".settings-sidebar")'))
  const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`)
  const fill = (index, label, value) => evaluate(`(() => {
    const group = document.querySelectorAll('.remote-editor')[${index}];
    const field = Array.from(group.querySelectorAll('.remote-field')).find(field => field.querySelector('label').textContent === ${JSON.stringify(label)});
    if (!field) throw new Error('Missing field; available labels: ' + Array.from(group.querySelectorAll('label')).map(label=>label.textContent).join(' / '));
    const input = field.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  const test = index => evaluate(`document.querySelectorAll('.remote-editor')[${index}].querySelector('.remote-editor-actions button').click()`)
  const outcome = index => evaluate(`document.querySelectorAll('.remote-test-result')[${index}]?.dataset.state`)
  const settled = index => until(async () => ['success', 'error'].includes(await outcome(index)))
  const capture = async (name, width) => {
    settings.setMinimumSize(360, 480)
    settings.setContentSize(width, 800)
    await delay(100)
    const height = await evaluate('document.documentElement.scrollHeight')
    settings.setContentSize(width, height)
    await evaluate('window.scrollTo(0, 0)')
    await delay(150)
    assert.equal(await evaluate('document.documentElement.scrollWidth > window.innerWidth'), false, name)
    assert.equal(await evaluate('document.querySelectorAll(".remote-editor-actions button").length'), 10)
    await fs.writeFile(path.resolve('.impeccable/review', `${name}.png`), (await settings.webContents.capturePage()).toPNG())
  }
  await fs.mkdir(path.resolve('.impeccable/review'), { recursive: true })
  await click('远程接管')
  for (const [type, name] of [['telegram', 'Telegram'], ['feishu', '飞书'], ['wecom', '企业微信'], ['discord', 'Discord']]) {
    await evaluate(`(() => { const select=document.querySelector('#remote-channel-type'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(type)}); select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
    await click('添加渠道')
    await until(() => evaluate(`Array.from(document.querySelectorAll('.remote-editor legend')).some(legend => legend.textContent.includes(${JSON.stringify(name)}))`))
  }
  await click('添加 Codex 连接')
  await until(() => evaluate('document.querySelectorAll(".remote-editor").length === 5'))
  for (const index of [0, 1, 2, 3]) {
    await fill(index, index === 3 ? '目标频道 ID' : '目标会话 ID', 'target')
    await fill(index, '允许操作的用户 ID（逗号分隔）', 'owner')
    await fill(index, '凭据环境变量名', ['TEST_TELEGRAM_TOKEN', 'TEST_FEISHU_SECRET', 'MISSING_WECOM_SECRET', 'TEST_DISCORD_TOKEN'][index])
  }
  await fill(1, '应用 App ID', 'app')
  await fill(2, '机器人 Bot ID', 'bot')
  await fill(4, 'WebSocket 地址', codexUrl)
  await fill(4, '会话 ID（可选，逗号分隔）', 'missing-thread')
  const selectProxy = (index, mode) => evaluate(`(() => {
    const scope = ${index < 0 ? 'document.querySelector("#remote-proxy-title").parentElement' : 'document.querySelectorAll(".remote-editor")['+index+']'};
    const select = scope.querySelector('select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(mode)});
    select.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  const fillGlobalProxy = value => evaluate(`(() => {
    const input=document.querySelector('#remote-proxy-title').parentElement.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  assert.equal(await evaluate('document.querySelectorAll(".remote-editor select").length'), 5)
  await selectProxy(-1, 'custom'); await fillGlobalProxy('invalid-proxy')
  await test(0); await settled(0); assert.equal(await outcome(0), 'error')
  assert.equal(calls.length, 0, 'Invalid proxy must be rejected before contacting APIs')
  await fillGlobalProxy('http://127.0.0.1:7890')
  await selectProxy(1, 'direct'); await selectProxy(3, 'custom'); await fill(3, '代理地址', 'socks5://127.0.0.1:1080')
  await test(0)
  await until(() => outcome(0).then(state => state === 'testing'))
  assert.equal(trayMenu.getMenuItemById('remote-toggle').enabled, false)
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".remote-field input")).every(input => input.matches(":disabled"))'), true)
  await assert.rejects(evaluate(`window.island.testRemoteConnection({kind:'codex',config:{id:'duplicate',url:${JSON.stringify(codexUrl)},threads:['live-thread']}})`))
  await assert.rejects(evaluate('window.island.setRemoteEnabled(true)'))
  await capture('connectivity-pending-desktop', 1040)
  releaseTelegram()
  await settled(0)
  assert.equal(await outcome(0), 'success')
  assert.equal(trayMenu.getMenuItemById('remote-toggle').enabled, true)
  await fill(0, '目标会话 ID', 'blocked')
  await until(() => outcome(0).then(state => state === undefined))
  await test(0); await settled(0)
  assert.equal(await outcome(0), 'error')
  await fill(0, '目标会话 ID', 'target')
  await test(0); await settled(0)
  for (const index of [1, 2, 3, 4]) { await test(index); await settled(index) }
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".remote-test-result")).map(result=>result.dataset.state)'), ['success', 'success', 'error', 'success', 'error'])
  assert.equal(await fs.readFile(process.env.CUTE_ISLAND_REMOTE_CONFIG, 'utf8'), initial, 'Testing drafts must not save configuration')
  assert.equal(await evaluate('document.body.textContent.includes("MISSING_WECOM_SECRET")'), true)
  for (const theme of ['light', 'dark']) {
    await evaluate(`window.island.updateSettings({theme:${JSON.stringify(theme)}})`)
    await until(() => evaluate(`document.body.dataset.theme === ${JSON.stringify(theme)}`))
    for (const width of [1040, 640, 390]) await capture(`connectivity-${theme}-${width}`, width)
  }
  await fill(4, '会话 ID（可选，逗号分隔）', 'live-thread')
  await test(4); await settled(4)
  assert.equal(await outcome(4), 'success')
  assert.equal(codexMessages.some(message => /thread\/(start|resume)|turn\//.test(message.method)), false)
  const island = BrowserWindow.getAllWindows().find(win => win !== settings)
  await assert.rejects(island.webContents.executeJavaScript(`window.island.testRemoteConnection({kind:'codex',config:{id:'wrong-window',url:${JSON.stringify(codexUrl)},threads:['live-thread']}})`))
  await click('保存渠道配置')
  await until(() => evaluate('document.body.textContent.includes("渠道配置已保存")'))
  const saved=JSON.parse(await fs.readFile(process.env.CUTE_ISLAND_REMOTE_CONFIG,'utf8'))
  assert.equal(saved.proxy.mode,'custom'); assert.equal(saved.channels[1].proxy.mode,'direct')
  assert.equal(saved.channels[3].proxy.url,'socks5://127.0.0.1:1080')
  await selectProxy(3,'inherit'); await selectProxy(-1,'system')
  await click('重新读取')
  await until(() => evaluate('document.querySelector("#remote-proxy-title").parentElement.querySelector("select").value === "custom"'))
  assert.equal(await evaluate('document.querySelectorAll(".remote-editor")[3].querySelector("select").value'),'custom')
  assert.deepEqual(errors, [])
  assert.equal(calls.some(call => call.url.includes('getUpdates')), false)
  console.log('Connectivity UI passed: five editors, unsaved drafts, real IPC, success/failure/reset/loading, sender and concurrency guards, and both themes at 1040/640/390px. No real external messages sent.')
  for (const peer of codexServer.clients) peer.terminate()
  await new Promise(resolve => codexServer.close(resolve))
  await new Promise(resolve => rendererServer.close(resolve))
  app.quit()
}

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-connectivity-'))
  const listener = net.createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  const rendererListener = net.createServer().listen(0, '127.0.0.1')
  await once(rendererListener, 'listening')
  const rendererPort = rendererListener.address().port
  await new Promise(resolve => listener.close(resolve))
  await new Promise(resolve => rendererListener.close(resolve))
  const config = path.join(profile, 'remote.json')
  await fs.writeFile(config, JSON.stringify({ mode: 'takeover', enabled: false, port, controlToken: 'isolated-test-token-'.repeat(3), stateFile: 'state.json', channels: [], codex: [] }))
  const env = { ...process.env, CUTE_ISLAND_DISABLE_GPU: '1', CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_REMOTE_CONFIG: config, CUTE_ISLAND_PORT: String(port),
    CUTE_ISLAND_TOKEN: '', ELECTRON_RENDERER_URL: '', CODEX_HOME: path.join(profile, 'codex'), TEST_TELEGRAM_TOKEN: 'synthetic-telegram-token',
    ISLAND_TEST_RENDERER_PORT: String(rendererPort),
    TEST_FEISHU_SECRET: 'synthetic-feishu-secret', TEST_DISCORD_TOKEN: 'synthetic-discord-token' }
  delete env.ELECTRON_RUN_AS_NODE
  let child
  try {
    child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`, '--settings'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    let logs = ''
    child.stdout.on('data', value => { logs += value })
    child.stderr.on('data', value => { logs += value })
    const timeout = setTimeout(() => child.kill(), 60000)
    const [code] = await once(child, 'exit')
    clearTimeout(timeout)
    console.log(logs)
    assert.equal(code, 0)
  } finally {
    if (child && child.exitCode === null) child.kill()
    if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('island-connectivity-')) throw new Error('Unexpected temporary path')
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

(process.versions.electron ? fixture() : main()).catch(error => {
  console.error(error)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})
