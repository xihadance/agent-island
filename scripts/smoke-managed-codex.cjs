// npm run build && node scripts/smoke-managed-codex.cjs
// Real Electron lifecycle and Telegram callbacks with a synthetic native server.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let attempt = 0; attempt < 160; attempt++) { const value = await check(); if (value) return value; await delay(50) }
  throw new Error('等待托管 Codex 审批同步超时')
}
async function freePort() {
  const listener = net.createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

async function fixture() {
  const { app, BrowserWindow } = require('electron')
  const WebSocket = require('ws')
  app.getAppPath = () => path.resolve('.')
  app.getVersion = () => require('../package.json').version
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () { this.setPosition(-10000, -10000); showInactive.call(this) }
  const processes = require('node:child_process'), nativeSpawn = processes.spawn
  processes.spawn = (executable, args, options) => {
    if (args?.[0] !== 'app-server') return nativeSpawn(executable, args, options)
    const port = new URL(args.at(-1)).port
    const code = `
const {WebSocketServer}=require('ws')
const server=new WebSocketServer({host:'127.0.0.1',port:${port}})
const subscribers=new Set(), replies=[]
server.on('connection', peer=>{
  peer.on('close',()=>subscribers.delete(peer))
  peer.on('message',bytes=>{
    const message=JSON.parse(bytes)
    if(!message.method){
      replies.push(message)
      for(const client of subscribers) client.send(JSON.stringify({method:'serverRequest/resolved',params:{threadId:'hosted-thread',requestId:message.id}}))
      return
    }
    if(message.method==='fixture/approval') for(const client of subscribers) client.send(JSON.stringify({id:message.params.id,method:'item/commandExecution/requestApproval',params:{threadId:'hosted-thread',turnId:'turn',itemId:'tool-'+message.params.id,command:'npm test',availableDecisions:['accept','decline']}}))
    if(message.method==='fixture/question') for(const client of subscribers) client.send(JSON.stringify({id:message.params.id,method:'tool/requestUserInput',params:{threadId:'hosted-thread',turnId:'turn',questions:[{id:'choice',question:'选择方案',options:[{label:'方案 A（推荐）'},{label:'方案 B'}]}]}}))
    if(message.method==='fixture/reset') replies.length=0
    if(message.method==='thread/resume') subscribers.add(peer)
    if(message.id!==undefined) peer.send(JSON.stringify({id:message.id,result:message.method==='fixture/stats'?{subscribers:subscribers.size,replies}:message.method==='thread/loaded/list'?{data:['hosted-thread']}:message.method==='thread/resume'?{thread:{name:'托管审批测试',turns:[{id:'turn',status:'inProgress'}]}}:{}}))
  })
})`
    return nativeSpawn(process.execPath, ['-e', code], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  }
  const updates = [], sent = [], edits = []
  let messageId = 0, updateId = 0
  const fetchModule = require.resolve('node-fetch')
  require(fetchModule)
  require.cache[fetchModule].exports = async (url, options) => {
    const body = JSON.parse(options.body)
    let result = {}
    if (String(url).endsWith('/getUpdates')) { await delay(40); result = updates.splice(0) }
    else if (String(url).endsWith('/getWebhookInfo')) result = { url: '' }
    else if (String(url).endsWith('/sendMessage')) { sent.push(body); result = { message_id: ++messageId } }
    else if (String(url).endsWith('/editMessageText')) edits.push(body)
    else if (!String(url).endsWith('/deleteWebhook') && !String(url).endsWith('/answerCallbackQuery')) throw new Error('测试不允许调用真实渠道')
    return { ok: true, json: async () => ({ ok: true, result }) }
  }
  // Seed an isolated installation record; no real shell startup file is changed.
  const integration = path.join(app.getPath('userData'), 'codex-command')
  const syncFiles = require('node:fs')
  syncFiles.mkdirSync(integration, { recursive: true })
  const shellProfile = path.join(integration, 'fixture-profile')
  const wrapper = path.join(integration, process.platform === 'win32' ? 'codex.ps1' : 'codex.sh')
  syncFiles.writeFileSync(shellProfile, `# >>> Cute Island Codex >>>\n. '${wrapper.replace(/'/g, "''")}'\n# <<< Cute Island Codex <<<\n`)
  syncFiles.writeFileSync(path.join(integration, 'installation.json'), JSON.stringify({ version: 1, executable: process.execPath, profiles: [shellProfile] }))
  require('../out/main/index.js')
  await app.whenReady()
  const settings = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#settings')))
  settings.webContents.setBackgroundThrottling(false)
  const evaluate = script => settings.webContents.executeJavaScript(script, true)
  await until(() => evaluate('!!document.querySelector(".settings-shell[data-ready]")'))
  const state = () => evaluate('window.island.getSettings()')
  const hostedPort = await freePort(), hostedUrl = `ws://127.0.0.1:${hostedPort}`
  const draft = { channels: [{ id: 'phone', type: 'telegram', destination: 'chat', allowedUsers: ['owner'], tokenEnv: 'ISLAND_SMOKE_TELEGRAM_TOKEN' }], codex: [] }
  await evaluate(`window.island.saveRemote(${JSON.stringify(draft)}, ${JSON.stringify((await state()).remote.revision)})`)
  await evaluate('window.island.setRemoteEnabled(true)')
  await evaluate(`window.island.updateSettings({codexServer:{enabled:true,port:${hostedPort},executable:${JSON.stringify(process.execPath)}},automation:{enabled:true}})`)
  await until(async () => (await state()).codexServer.status === 'running')
  const control = JSON.parse(await fs.readFile(process.env.CUTE_ISLAND_REMOTE_CONFIG, 'utf8'))
  const snapshot = () => fetch(`http://127.0.0.1:${process.env.CUTE_ISLAND_PORT}/v1/control`, { headers: { authorization: `Bearer ${control.controlToken}` } }).then(response => response.json())
  await until(async () => (await snapshot()).sessions.some(session => session.nativeId === 'hosted-thread' && session.connected))
  assert.deepEqual((await state()).remote.codex, [])
  const island = BrowserWindow.getAllWindows().find(win => win !== settings)
  await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Codex").click()')
  await until(() => evaluate('!!document.querySelector(".hosted-codex")'))
  const review = path.resolve('.impeccable/review')
  await fs.mkdir(review, { recursive: true })
  for (const theme of ['light', 'dark']) {
    await evaluate(`window.island.updateSettings({theme:${JSON.stringify(theme)}})`)
    await until(() => evaluate(`document.body.dataset.theme === ${JSON.stringify(theme)}`))
    await evaluate('document.querySelector(".hosted-codex").scrollIntoView({block:"center"})')
    await delay(150)
    await fs.writeFile(path.join(review, `managed-codex-${theme}.png`), (await settings.webContents.capturePage()).toPNG())
    await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "远程接管").click()')
    await evaluate('document.querySelector("#remote-codex-title").scrollIntoView({block:"center"})')
    await delay(150)
    await fs.writeFile(path.join(review, `managed-codex-${theme}-remote.png`), (await settings.webContents.capturePage()).toPNG())
    await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Codex").click()')
  }
  const launch = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'codex-command', 'launch.json'), 'utf8'))
  const prepared = await fetch(launch.statusUrl, { method: 'POST', headers: { authorization: `Bearer ${launch.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'agentrouter', cwd: process.cwd(), overrides: [], env: process.env }) }).then(response => response.json())
  assert.equal(prepared.enabled, true)
  assert.notEqual(prepared.url, hostedUrl)
  await until(async () => (await snapshot()).sessions.filter(session => session.nativeId === 'hosted-thread' && session.connected).length === 2)
  const terminal = new WebSocket(prepared.url), messages = [], pending = new Map()
  let sequence = 0
  await once(terminal, 'open')
  terminal.on('message', bytes => {
    const message = JSON.parse(bytes)
    if (message.method) messages.push(message)
    else { pending.get(message.id)?.(message.result); pending.delete(message.id) }
  })
  const rpc = (method, params = {}) => new Promise(resolve => { const id = `terminal-${++sequence}`; pending.set(id, resolve); terminal.send(JSON.stringify({ id, method, params })) })
  const callback = (request, id) => updates.push({ update_id: ++updateId, callback_query: { id: `callback-${updateId}`, from: { id: 'owner' },
    data: `${request.id}:${request.revision}:approve`, message: { message_id: id, chat: { id: 'chat' } } } })
  try {
    await rpc('initialize'); await rpc('thread/resume', { threadId: 'hosted-thread' })
    assert.equal((await rpc('fixture/stats')).subscribers, 2)
    await rpc('fixture/approval', { id: 898 })
    await rpc('fixture/question', { id: 899 })
    await until(async () => (await rpc('fixture/stats')).replies.length === 2)
    assert.deepEqual((await rpc('fixture/stats')).replies, [
      { id: 898, result: { decision: 'accept' } },
      { id: 899, result: { answers: { choice: { answers: ['方案 A（推荐）'] } } } }
    ], '接管通道统一回传自动审批和推荐回答')
    assert.equal((await snapshot()).requests.some(request => [898, 899].includes(request.nativeRequestId)), false)
    assert.equal(sent.length, 0, '自动处理的请求不再发到消息渠道')
    await evaluate('window.island.updateSettings({automation:{enabled:false}})')
    await rpc('fixture/reset')
    await rpc('fixture/approval', { id: 900 })
    const first = await until(async () => (await snapshot()).requests.find(request => request.nativeRequestId === 900))
    const notification = await until(() => sent.find(message => message.text.includes(first.id)))
    assert.ok(notification.reply_markup.inline_keyboard.flat().some(button => button.callback_data.endsWith(':approve')))
    assert.equal(notification.text.includes('仅提醒'), false)
    assert.ok(messages.some(message => message.id === 900))
    assert.deepEqual((await rpc('fixture/stats')).replies, [], '自动审批关闭后保留远程处理')
    callback(first, 1)
    await until(async () => (await snapshot()).requests.find(request => request.id === first.id)?.status === 'resolved')
    assert.deepEqual((await rpc('fixture/stats')).replies, [{ id: 900, result: { decision: 'accept' } }])
    assert.ok(messages.some(message => message.method === 'serverRequest/resolved' && message.params.requestId === 900))
    await rpc('fixture/approval', { id: 901 })
    const second = await until(async () => (await snapshot()).requests.find(request => request.nativeRequestId === 901))
    await until(() => sent.some(message => message.text.includes(second.id)))
    terminal.send(JSON.stringify({ id: 901, result: { decision: 'decline' } }))
    await until(() => edits.some(message => message.text.includes(second.id) && message.reply_markup.inline_keyboard.flat().every(button => !button.callback_data.endsWith(':approve'))))
    callback(second, 2)
    await until(() => sent.some(message => message.text.includes('已处理')))
    assert.equal((await rpc('fixture/stats')).replies.length, 2)
    await evaluate('window.island.updateSettings({automation:{enabled:false}})')
    await evaluate('window.island.setRemoteEnabled(false)')
    await until(async () => (await rpc('fixture/stats')).subscribers === 1)
    await evaluate('window.island.updateSettings({automation:{enabled:true}})')
    await until(async () => (await rpc('fixture/stats')).subscribers === 2)
    await rpc('fixture/reset')
    await rpc('fixture/approval', { id: 903 })
    await rpc('fixture/question', { id: 904 })
    await until(async () => (await rpc('fixture/stats')).replies.length === 2)
    assert.deepEqual((await rpc('fixture/stats')).replies, [
      { id: 903, result: { decision: 'accept' } },
      { id: 904, result: { answers: { choice: { answers: ['方案 A（推荐）'] } } } }
    ], '关闭远程接管后自动审批通道接管同一 profile 实例')
    await evaluate('window.island.setRemoteEnabled(true)')
    await until(async () => (await rpc('fixture/stats')).subscribers === 2)
    await rpc('fixture/reset')
    await rpc('fixture/approval', { id: 905 })
    await until(async () => (await rpc('fixture/stats')).replies.length === 1)
    await delay(100)
    assert.deepEqual((await rpc('fixture/stats')).replies, [{ id: 905, result: { decision: 'accept' } }], '切换回远程接管后无重复回复')
    assert.deepEqual(JSON.parse(await fs.readFile(process.env.CUTE_ISLAND_REMOTE_CONFIG, 'utf8')).codex, [])
    assert.ok(island && !island.isDestroyed())
    console.log('通过：接管通道自动审批及推荐回答、消息渠道审批按钮、终端同步、任一端处理、重复拦截、启停恢复及无额外连接配置。')
  } finally { terminal.terminate() }
  await evaluate('window.island.updateSettings({codexServer:{enabled:false}})')
  await until(async () => (await state()).codexServer.status === 'stopped')
  await until(async () => (await snapshot()).sessions.filter(session => session.nativeId === 'hosted-thread').every(session => !session.connected))
  await evaluate('window.island.updateSettings({codexServer:{enabled:true}})')
  await until(async () => (await state()).codexServer.status === 'running')
  await until(async () => (await snapshot()).sessions.some(session => session.nativeId === 'hosted-thread' && session.connected))
  assert.deepEqual(JSON.parse(await fs.readFile(process.env.CUTE_ISLAND_REMOTE_CONFIG, 'utf8')).codex, [])
  console.log('通过：停止及重启托管服务自动断开和恢复转发关联。')
  app.quit()
}

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-managed-codex-'))
  await fs.mkdir(path.join(profile, 'codex'))
  await fs.writeFile(path.join(profile, 'codex', 'agentrouter.config.toml'), 'model = "profile-fixture"\n')
  const env = { ...process.env, CUTE_ISLAND_PORT: String(await freePort()), CUTE_ISLAND_REMOTE_CONFIG: path.join(profile, 'remote.json'),
    CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: '', CUTE_ISLAND_DISABLE_GPU: '1', ELECTRON_RENDERER_URL: '', ISLAND_SMOKE_TELEGRAM_TOKEN: 'synthetic-token',
    CODEX_HOME: path.join(profile, 'codex'), CLAUDE_CONFIG_DIR: path.join(profile, 'claude'), CURSOR_HOME: path.join(profile, 'cursor'), GEMINI_CLI_HOME: path.join(profile, 'gemini') }
  delete env.ELECTRON_RUN_AS_NODE
  let child
  try {
    child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`, '--settings'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    child.stdout.on('data', bytes => process.stdout.write(bytes)); child.stderr.on('data', bytes => process.stderr.write(bytes))
    const timeout = setTimeout(() => child.kill(), 45000)
    const [code] = await once(child, 'exit'); clearTimeout(timeout)
    assert.equal(code, 0)
  } finally {
    if (child?.exitCode === null) child.kill()
    const resolved = path.resolve(profile)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('island-managed-codex-'))
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}
(process.versions.electron ? fixture() : main()).catch(error => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1 })
