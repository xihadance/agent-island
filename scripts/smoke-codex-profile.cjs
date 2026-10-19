// node scripts/smoke-codex-profile.cjs <native-codex-executable>
// Read isolated native app-server configuration without starting a model turn.
require('tsx/cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { readCodexProfile } = require('../src/control/codex-profile.ts')
const { ManagedCodexPool } = require('../src/main/codex-pool.ts')
const WebSocket = require('ws')
const net = require('node:net')

async function readConfig(url) {
  const socket = new WebSocket(url)
  try {
    await once(socket, 'open')
    let id = 0
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id
      const finish = () => { clearTimeout(timer); socket.off('message', receive) }
      const receive = bytes => {
        const response = JSON.parse(bytes)
        if (response.id !== requestId) return
        finish()
        if (response.error) reject(new Error(response.error.message))
        else resolve(response.result)
      }
      const timer = setTimeout(() => { finish(); reject(new Error(`等待 ${method} 超时`)) }, 10000)
      socket.on('message', receive)
      socket.send(JSON.stringify({ id: requestId, method, params }))
    })
    await rpc('initialize', { clientInfo: { name: 'island_pool_smoke', version: '1' }, capabilities: { experimentalApi: true } })
    return (await rpc('config/read', { includeLayers: true })).config
  } finally { socket.terminate() }
}

async function main() {
  const executable = process.argv[2]
  assert.ok(executable && path.isAbsolute(executable), '请提供 Codex 原生程序的绝对路径')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'island-native-profile-'))
  let child
  let pool
  const originalHome = process.env.CODEX_HOME, originalCwd = process.cwd()
  try {
    const base = 'model = "base-model"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local probe"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n'
    const selected = 'model = "profile-model"\nmodel_reasoning_effort = "high"\n[model_providers.probe]\nbase_url = "http://127.0.0.1:2/v1"\nenv_key = "ISLAND_PROFILE_FIXTURE_KEY"\n'
    await fs.writeFile(path.join(directory, 'config.toml'), base)
    await fs.writeFile(path.join(directory, 'fixture.config.toml'), selected)
    const profile = readCodexProfile('fixture', directory)
    child = spawn(executable, ['app-server', ...profile.args], { windowsHide: true,
      env: { ...process.env, CODEX_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    const calls = new Map()
    let sequence = 0
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const call = calls.get(message.id)
      if (!call) return
      calls.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) call.reject(new Error(message.error.message))
      else call.resolve(message.result)
    })
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { calls.delete(id); reject(new Error(`等待 ${method} 超时`)) }, 10000)
      calls.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    await rpc('initialize', { clientInfo: { name: 'island_profile_smoke', version: '1' }, capabilities: { experimentalApi: true } })
    const result = await rpc('config/read', { includeLayers: true })
    assert.equal(result.config.model, 'profile-model')
    assert.equal(result.config.model_reasoning_effort, 'high')
    assert.equal(result.config.model_providers.probe.base_url, 'http://127.0.0.1:2/v1')
    assert.equal(result.config.model_providers.probe.env_key, 'ISLAND_PROFILE_FIXTURE_KEY')
    assert.equal(result.config.model_providers.probe.wire_api, 'responses')
    assert.equal(await fs.readFile(path.join(directory, 'config.toml'), 'utf8'), base)
    assert.equal(await fs.readFile(path.join(directory, 'fixture.config.toml'), 'utf8'), selected)
    process.env.CODEX_HOME = directory
    process.chdir(directory)
    const listener = net.createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    pool = new ManagedCodexPool(() => {})
    await pool.configure({ enabled: true, port, executable })
    const request = { cwd: directory, overrides: [], env: { ...process.env, ISLAND_PROFILE_FIXTURE_KEY: 'synthetic-key' } }
    const [defaultUrl, profileUrl, sameUrl] = await Promise.all([pool.ensure(request), pool.ensure({ ...request, profile: 'fixture' }), pool.ensure({ ...request, profile: 'fixture' })])
    assert.equal(profileUrl, sameUrl)
    assert.notEqual(defaultUrl, profileUrl)
    assert.equal((await readConfig(defaultUrl)).model, 'base-model')
    const profileConfig = await readConfig(profileUrl)
    assert.equal(profileConfig.model, 'profile-model')
    assert.equal(profileConfig.model_providers.probe.base_url, 'http://127.0.0.1:2/v1')
    assert.equal(profileConfig.model_providers.probe.env_key, 'ISLAND_PROFILE_FIXTURE_KEY')
    await fs.writeFile(path.join(directory, 'fixture.config.toml'), selected.replace('profile-model', 'updated-model'))
    const updatedUrl = await pool.ensure({ ...request, profile: 'fixture' })
    assert.notEqual(updatedUrl, profileUrl)
    assert.equal((await readConfig(updatedUrl)).model, 'updated-model')
    assert.equal((await readConfig(profileUrl)).model, 'profile-model')
    const overriddenUrl = await pool.ensure({ ...request, profile: 'fixture', overrides: ['model="command-model"'] })
    assert.equal((await readConfig(overriddenUrl)).model, 'command-model')
    assert.equal(await fs.readFile(path.join(directory, 'config.toml'), 'utf8'), base)
    assert.equal(await fs.readFile(path.join(directory, 'fixture.config.toml'), 'utf8'), selected.replace('profile-model', 'updated-model'))
    console.log('原生 Codex 自动服务冒烟通过：默认配置与 profile 隔离、并发复用、完整供应商配置、命令覆盖、配置更新及旧会话保留均正确，未调用模型。')
  } finally {
    await pool?.close()
    process.chdir(originalCwd)
    if (originalHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalHome
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('island-native-profile-'))
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
