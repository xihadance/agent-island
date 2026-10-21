// npm run build && node scripts/smoke-claude-terminal.cjs
// Compiled CLI and MCP transport, with isolated state and no model or messaging service.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await check().catch(() => undefined)
    if (value) return value
    await delay(50)
  }
  throw new Error('等待原生终端通道超时')
}

async function smoke() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'island-terminal-smoke-'))
  const children = []
  let logs = ''
  try {
    const listener = net.createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    const file = path.join(temporary, 'remote.json')
    const nativeId = '01234567-89ab-cdef-0123-456789abcdef'
    const config = { mode: 'takeover', enabled: true, port, controlToken: 'isolated-terminal-smoke-token-'.repeat(2), stateFile: 'state.json', channels: [], codex: [] }
    await fs.writeFile(file, JSON.stringify(config))
    const env = { ...process.env, CUTE_ISLAND_REMOTE_CONFIG: file, CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: 'isolated-status-only', ELECTRON_RUN_AS_NODE: '1' }
    const launch = args => {
      const child = spawn(process.execPath, ['bin/cute-island.js', ...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-3000) })
      return child
    }
    const stop = async child => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    const base = `http://127.0.0.1:${port}/v1/control`
    const request = async (route = '', body) => {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${config.controlToken}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000) })
      const result = await response.json()
      assert.equal(response.status, 200, result.error)
      return result
    }
    const channel = async () => {
      const child = launch(['remote', 'claude-channel', '--session', nativeId, '--cwd', process.cwd()])
      const messages = []
      let buffer = ''
      child.stdout.on('data', bytes => {
        buffer += bytes
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          messages.push(JSON.parse(buffer.slice(0, newline)))
          buffer = buffer.slice(newline + 1)
        }
      })
      const rpc = (id, method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) + '\n')
      rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
      const initialized = await until(async () => messages.find(message => message.id === 1))
      assert.deepEqual(initialized.result.capabilities.experimental, { 'claude/channel': {} })
      rpc(undefined, 'notifications/initialized')
      await until(async () => (await request()).sessions.find(session => session.nativeId === nativeId && session.connected))
      return { child, messages, rpc }
    }
    const server = launch(['remote', 'serve'])
    await until(async () => (await request()).control.running)
    const first = await channel()
    const session = (await request()).sessions.find(session => session.nativeId === nativeId)
    assert.equal(session.terminal, true)
    const message = await request('/messages', { sessionId: session.id, text: '核对已有结果后继续' })
    assert.equal(message.status, 'submitted')
    const notification = await until(async () => first.messages.find(row => row.method === 'notifications/claude/channel'))
    assert.deepEqual(notification.params, { content: '核对已有结果后继续', meta: { message_id: message.id } })
    assert.equal((await request()).guidance[0].status, 'submitted')
    first.rpc(2, 'tools/call', { name: 'confirm_receipt', arguments: { message_id: 'unknown' } })
    assert.ok((await until(async () => first.messages.find(row => row.id === 2))).error)
    const hook = await request('/hook', { agent: 'claude', invocationId: 'approval', event: {
      session_id: nativeId, cwd: process.cwd(), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }
    } })
    const approval = (await request()).requests.find(row => row.id === hook.requestId)
    await request(`/requests/${approval.id}/respond`, { revision: approval.revision, decision: { action: 'approve' } })
    assert.deepEqual((await request(`/requests/${approval.id}?invocation=approval`)).decision, { action: 'approve' })
    first.rpc(3, 'tools/call', { name: 'confirm_receipt', arguments: { message_id: message.id } })
    await until(async () => (await request()).guidance[0].status === 'resolved')
    const failure = await request('/hook', { agent: 'claude', invocationId: 'failure', event: { session_id: nativeId, cwd: process.cwd(), hook_event_name: 'StopFailure', error: 'api_error' } })
    assert.deepEqual(failure.output, {})
    const recovery = (await request()).requests.find(row => row.kind === 'error')
    assert.ok(recovery.actions.includes('resume'))
    await request(`/requests/${recovery.id}/respond`, { revision: recovery.revision, decision: { action: 'resume' } })
    await until(async () => first.messages.some(row => row.method === 'notifications/claude/channel' && row.params.meta.message_id === recovery.id))
    first.rpc(4, 'tools/call', { name: 'confirm_receipt', arguments: { message_id: recovery.id } })
    await until(async () => (await request()).requests.find(row => row.id === recovery.id).status === 'resolved')
    const uncertain = await request('/messages', { sessionId: session.id, text: '只能执行一次' })
    await until(async () => first.messages.some(row => row.params?.meta?.message_id === uncertain.id))
    await request('/enabled', { enabled: false })
    await until(async () => first.child.exitCode !== null)
    assert.equal((await request()).guidance.find(row => row.id === uncertain.id).status, 'uncertain')
    await request('/enabled', { enabled: true })
    await stop(server)
    const restarted = launch(['remote', 'serve'])
    await until(async () => (await request()).control.running)
    const second = await channel()
    second.rpc(2, 'tools/list')
    await until(async () => second.messages.some(row => row.id === 2))
    assert.equal(second.messages.some(row => row.method === 'notifications/claude/channel'), false)
    assert.equal((await request()).guidance.find(row => row.id === uncertain.id).status, 'uncertain')
    await stop(restarted)
    console.log('通过：打包 CLI、原生 MCP 消息投递与确认、审批回传、同会话继续、启停和重启不重放。')
  } catch (error) { console.error(logs); throw error }
  finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited
    }
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temporary).startsWith('island-terminal-smoke-'))
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

smoke().catch(error => { console.error(error); process.exitCode = 1 })
