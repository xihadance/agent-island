// npm run build && node scripts/smoke-codex-command.cjs
// Real settings IPC and one persistent PowerShell session; no model or messaging calls.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(60) }
  throw new Error('Timed out waiting for command integration')
}
async function freePort() {
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port
}

async function fixture() {
  const { app, BrowserWindow } = require('electron')
  app.getVersion = () => require('../package.json').version
  app.getAppPath = () => path.resolve('.')
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () { this.setPosition(-10000, -10000); showInactive.call(this) }
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  const processes = require('node:child_process'), nativeSpawn = processes.spawn
  processes.spawn = (executable, args, options) => {
    if (args?.[0] !== 'app-server') return nativeSpawn(executable, args, options)
    const code = `const {WebSocketServer}=require('ws'); const s=new WebSocketServer({host:'127.0.0.1',port:${new URL(args.at(-1)).port}}); s.on('connection',w=>w.on('message',b=>{const m=JSON.parse(b);if(m.id===undefined)return;w.send(JSON.stringify({id:m.id,result:m.method==='initialize'?{userAgent:'fixture'}:{data:[]}}));}));`
    return nativeSpawn(process.execPath, ['-e', code], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  }
  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().endsWith('#settings')))
  const settings = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('#settings'))
  settings.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message) })
  settings.webContents.setBackgroundThrottling(false)
  const evaluate = async code => {
    try { return await settings.webContents.executeJavaScript(code, true) }
    catch (error) { throw new Error(`Settings evaluation failed: ${code}`, { cause: error }) }
  }
  const state = () => evaluate('window.island.getSettings()')
  const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`)
  await until(() => evaluate('!!document.querySelector(".automation-master")'))
  await click('Agent 接入')
  await click('安装命令接入')
  await until(async () => (await state()).codexCommand.installed)
  const profiles = (await state()).codexCommand.profiles
  assert.ok(profiles.every(p => p.startsWith(process.env.CUTE_ISLAND_POWERSHELL_DOCUMENTS)))
  const quote = s => `'${s.replace(/'/g, "''")}'`
  const script = path.join(process.env.ISLAND_COMMAND_PROFILE, 'session.ps1')
  await fs.writeFile(script, `\uFEFF
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$env:ELECTRON_RUN_AS_NODE = 'original-value'
. ${quote(profiles[0])}
while ($null -ne ($islandLine = [Console]::ReadLine())) {
  $islandArgs = @((ConvertFrom-Json -InputObject $islandLine).args)
  codex @islandArgs
}
`, 'utf8')
  const shell = nativeSpawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', diagnostic = '', resolveLaunch
  shell.stdout.on('data', bytes => {
    buffer += bytes.toString('utf8')
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1)
      if (line.startsWith('CODEX:')) { const resolve = resolveLaunch; resolveLaunch = undefined; resolve?.(JSON.parse(line.slice(6))) }
    }
  })
  shell.stderr.on('data', bytes => { diagnostic += bytes })
  const launch = async (args = ['-m', 'gpt-5'], version = 1) => {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { resolveLaunch = undefined; reject(new Error(`Codex launcher timed out: ${diagnostic}`)) }, 10000)
      resolveLaunch = value => { clearTimeout(timeout); resolve(value) }
      shell.stdin.write(JSON.stringify({ args }) + '\n')
    })
    assert.equal(result.runtime, 'original-value')
    assert.equal(result.version, version)
    assert.equal(diagnostic, '', 'Command launcher stderr')
    return result.args
  }
  const args = ['-m', 'gpt-5', '保持空格 $() `literal 和 "引号"', '']
  try {
    assert.deepEqual(await launch(args), args)
    const hostedPort = await freePort(), hostedUrl = `ws://127.0.0.1:${hostedPort}`
    await evaluate(`window.island.updateSettings({codexServer:{enabled:true,port:${hostedPort},executable:${JSON.stringify(process.execPath)}},automation:{enabled:true}})`)
    await until(async () => (await state()).codexServer.status === 'running' && (await state()).codexStatus === 'connected')
    const launchConfig = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'codex-command', 'launch.json'), 'utf8'))
    const route = await fetch(launchConfig.statusUrl, { headers: { authorization: `Bearer ${launchConfig.token}` } })
    assert.deepEqual(await route.json(), { enabled: true, url: hostedUrl })
    const planner = nativeSpawn(process.execPath, [path.join(app.getAppPath(), 'out', 'cli.cjs'), 'codex-launch', 'plan', '--config', path.join(app.getPath('userData'), 'codex-command', 'launch.json'), '--', ...args], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let planned = '', planError = ''
    planner.stdout.on('data', b => { planned += b }); planner.stderr.on('data', b => { planError += b })
    const [planCode] = await once(planner, 'exit')
    assert.equal(planCode, 0, planError)
    assert.deepEqual(JSON.parse(planned).args, ['--remote', hostedUrl, ...args], 'Bundled Electron planner')
    assert.deepEqual(await launch(args), ['--remote', hostedUrl, ...args])
    await evaluate('window.island.updateSettings({automation:{enabled:false}})')
    assert.deepEqual(await launch(args), args)
    await evaluate('window.island.updateSettings({automation:{enabled:true}})')
    assert.deepEqual(await launch(['--remote', 'ws://127.0.0.1:1']), ['--remote', 'ws://127.0.0.1:1'])
    assert.deepEqual(await launch(['--no-daemon']), ['--no-daemon'])
    assert.deepEqual(await launch(['-p', 'anyrouter']), ['-p', 'anyrouter'], 'Profiles launch natively')
    assert.deepEqual(await launch(['exec', 'prompt']), ['exec', 'prompt'])
    const captureDir = path.resolve('.impeccable/review'); await fs.mkdir(captureDir, { recursive: true })
    const capture = async (name, width, height) => {
      settings.setMinimumSize(360, 480); settings.setContentSize(width, height)
      await evaluate('Array.from(document.querySelectorAll("strong")).find(e=>e.textContent==="直接使用 codex 命令").scrollIntoView({block:"center"})')
      await delay(300)
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
      await fs.writeFile(path.join(captureDir, `${name}.png`), (await settings.webContents.capturePage()).toPNG())
    }
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.island.updateSettings({theme:${JSON.stringify(theme)}})`)
      await until(() => evaluate(`document.body.dataset.theme === ${JSON.stringify(theme)}`))
      await capture(`codex-command-${theme}-desktop`, 1040, 800)
      await capture(`codex-command-${theme}-narrow`, 640, 700)
    }
    const { WebSocketServer } = require('ws')
    const remote = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(remote, 'listening')
    remote.on('connection', w => w.on('message', b => { const m = JSON.parse(b); if (m.id !== undefined) w.send(JSON.stringify({ id: m.id, result: m.method === 'initialize' ? { userAgent: 'fixture' } : { data: [] } })) }))
    const remoteUrl = `ws://127.0.0.1:${remote.address().port}`
    const draft = { channels: [], codex: [{ id: 'auto-fixture', url: remoteUrl, threads: [] }] }
    await evaluate(`window.island.saveRemote(${JSON.stringify(draft)}, ${JSON.stringify((await state()).remote.revision)})`)
    await evaluate('window.island.setRemoteEnabled(true)')
    await until(async () => (await state()).remote.running)
    assert.deepEqual(await launch(args), ['--remote', remoteUrl, ...args], 'Takeover has priority over automation')
    await evaluate('window.island.updateSettings({automation:{enabled:false}})')
    assert.deepEqual(await launch(args), ['--remote', remoteUrl, ...args])
    await evaluate('window.island.setRemoteEnabled(false)')
    assert.deepEqual(await launch(args), args)
    await evaluate('window.island.setRemoteEnabled(true)')
    assert.deepEqual(await launch(args), ['--remote', remoteUrl, ...args])
    for (const w of remote.clients) w.terminate()
    await new Promise(resolve => remote.close(resolve))
    assert.deepEqual(await launch(args), args, 'Unavailable WebSocket restores original command')
    await evaluate('window.island.setRemoteEnabled(false)')
    await evaluate('window.island.updateSettings({automation:{enabled:true}})')
    await fs.writeFile(path.join(process.env.ISLAND_COMMAND_BIN, 'codex.ps1'), fakeCodex(2), 'utf8')
    assert.deepEqual(await launch(args, 2), ['--remote', hostedUrl, ...args])
    await click('移除命令接入')
    await until(async () => !(await state()).codexCommand.installed)
    assert.deepEqual(await launch(args, 2), args, 'Loaded function falls back after removal')
    assert.equal(await fs.readFile(profiles[0], 'utf8'), '# existing shell settings\r\n')
    const island = BrowserWindow.getAllWindows().find(w => w !== settings)
    await assert.rejects(island.webContents.executeJavaScript('window.island.setCodexCommandIntegration(true)'))
    console.log('Codex command: real UI install/remove, persistent terminal toggles, priority, exact args, dead-service fallback, CLI update and profile restoration passed')
  } finally {
    const exited = once(shell, 'exit'); shell.stdin.end(); await exited
  }
  app.quit()
}
function fakeCodex(version) { return `\uFEFF$value = @{version=${version};args=@($args);runtime=$env:ELECTRON_RUN_AS_NODE}; Write-Output ('CODEX:' + (ConvertTo-Json -InputObject $value -Compress))\n` }
async function main() {
  if (process.platform !== 'win32') { console.log('Persistent PowerShell smoke requires Windows'); return }
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-command-'))
  const bin = path.join(profile, 'bin'), documents = path.join(profile, 'Documents')
  await fs.mkdir(bin); await fs.mkdir(path.join(documents, 'PowerShell'), { recursive: true })
  await fs.writeFile(path.join(bin, 'codex.ps1'), fakeCodex(1), 'utf8')
  await fs.writeFile(path.join(documents, 'PowerShell', 'profile.ps1'), '# existing shell settings\r\n')
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_RENDERER_URL: '', CUTE_ISLAND_DISABLE_GPU: '1', CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: '',
    CUTE_ISLAND_PORT: String(await freePort()), CUTE_ISLAND_REMOTE_CONFIG: path.join(profile, 'remote.json'), CUTE_ISLAND_POWERSHELL_DOCUMENTS: documents,
    CLAUDE_CONFIG_DIR: path.join(profile, 'claude'), CURSOR_HOME: path.join(profile, 'cursor'), GEMINI_CLI_HOME: path.join(profile, 'gemini'), CODEX_HOME: path.join(profile, 'codex'),
    ISLAND_COMMAND_PROFILE: profile, ISLAND_COMMAND_BIN: bin
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`, '--settings'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    let logs = ''; child.stdout.on('data', b => { logs += b }); child.stderr.on('data', b => { logs += b })
    const timeout = setTimeout(() => child.kill(), 60000)
    const [code] = await once(child, 'exit'); clearTimeout(timeout); console.log(logs); assert.equal(code, 0)
  } finally {
    if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('island-command-')) throw new Error('Unexpected temporary path')
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}
(process.versions.electron ? fixture() : main()).catch(error => {
  console.error(error)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})
