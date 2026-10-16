import { createChannelTransport, type ChannelTransport, type SystemProxyResolver } from './proxy'
import WebSocket from 'ws'
import AiBot from '@wecom/aibot-node-sdk'
import { parseRemoteConfig, secret, validateCodexUrl, validateCredentialName, type ChannelConfig, type RemoteConfig } from './config'
import { redact } from './hub'
import { check, record } from './store'
import type { RemoteConnectionTestResult } from '../shared/remote-settings'

export const CONNECTION_TEST_MESSAGE = 'Cute Island 连通性测试：这是一条测试消息。\n保存配置并开启远程接管后，可发送 /sessions 验证双向通信。'
const TIMEOUT_MESSAGE = '连接测试超时，请检查网络、代理或服务地址后重试。'

interface TestOptions {
  resolveSystemProxy?: SystemProxyResolver
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  timeoutMs?: number
  wecomUrl?: string
}

/** Test a single draft without persisting it or starting a message receiver. */
export async function testRemoteConnection(input: unknown, options: TestOptions = {}): Promise<RemoteConnectionTestResult> {
  const credentials: string[] = []
  let transport: ChannelTransport | undefined
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error(TIMEOUT_MESSAGE)), options.timeoutMs ?? 15000)
  try {
    const target = record(input)
    check(target.kind === 'channel' || target.kind === 'codex', '无效的连接测试')
    const config = parseRemoteConfig({ mode: 'takeover', enabled: false, controlToken: 'connection-test-'.repeat(3),
      proxy: target.proxy, channels: target.kind === 'channel' ? [target.config] : [], codex: target.kind === 'codex' ? [target.config] : [] }, 'remote.json')
    const connection = target.kind === 'codex' ? config.codex[0] : config.channels[0]
    transport = createChannelTransport(config.proxy, connection.proxy, options.resolveSystemProxy)
    for (const proxy of [config.proxy, connection.proxy]) {
      if (proxy?.url) {
        credentials.push(proxy.url)
        const parsed = new URL(proxy.url)
        if (parsed.username) credentials.push(parsed.username, decodeURIComponent(parsed.username))
        if (parsed.password) credentials.push(parsed.password, decodeURIComponent(parsed.password))
      }
    }
    const credential = (name: string | undefined): string => {
      validateCredentialName(name)
      const value = secret(name, options.env ?? process.env)
      credentials.push(value)
      return value
    }
    if (target.kind === 'codex') {
      const connection = config.codex[0]
      validateCodexUrl(connection.url)
      const token = connection.tokenEnv ? credential(connection.tokenEnv) : undefined
      const loaded = await testCodex(connection, token, abort.signal, transport)
      return { ok: true, message: connection.threads.length ? `Codex 服务已连接，${connection.threads.length} 个指定线程已加载。`
        : `Codex 服务已连接，当前有 ${loaded} 个已加载会话。开启远程接管后会自动接入，新会话也会自动发现。` }
    }
    const channel = config.channels[0]
    const token = credential(channel.type === 'feishu' || channel.type === 'wecom' ? channel.secretEnv : channel.tokenEnv)
    if (channel.type === 'wecom') await testWecom(channel, token, abort.signal, options.wecomUrl, transport)
    else await testHttpChannel(channel, token, abort.signal, options.fetchImpl ?? transport.fetch, credentials)
    return { ok: true, message: '测试消息已发送到目标会话。' }
  } catch (error) {
    let message = abort.signal.aborted ? TIMEOUT_MESSAGE : error instanceof TypeError ? '无法连接服务，请检查网络、代理或服务地址。'
      : error instanceof SyntaxError ? '服务返回了无效响应，请检查网络、代理或服务地址。' : error instanceof Error ? error.message : '连接测试失败，请检查配置后重试。'
    for (const value of credentials) for (const encoded of [value, encodeURIComponent(value)]) message = message.split(encoded).join('[REDACTED]')
    return { ok: false, message: redact(message).slice(0, 800) }
  } finally { clearTimeout(timer); transport?.close() }
}

async function testHttpChannel(channel: ChannelConfig, token: string, signal: AbortSignal, fetchImpl: typeof fetch, credentials: string[]): Promise<void> {
  const request = async (url: string, data: unknown, label: string, authorization?: string): Promise<Record<string, any>> => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(data), signal, redirect: 'error' })
    check(response.ok, `${label}失败（HTTP ${response.status}），请检查凭据、目标会话和机器人发送权限。`)
    return record(await response.json())
  }
  if (channel.type === 'telegram') {
    const base = `https://api.telegram.org/bot${token}`
    const webhook = await request(`${base}/getWebhookInfo`, {}, 'Telegram 验证凭据')
    check(webhook.ok === true && webhook.result && typeof webhook.result === 'object', `Telegram 验证凭据失败（${webhook.error_code ?? '无效响应'}），请检查 Bot Token。`)
    check(!webhook.result.url, 'Telegram Bot 已设置 Webhook，无法使用长轮询接管；请换用专用 Bot 或移除 Webhook 后重试。')
    const sent = await request(`${base}/sendMessage`, { chat_id: channel.destination, text: CONNECTION_TEST_MESSAGE, link_preview_options: { is_disabled: true } }, 'Telegram 发送测试消息')
    check(sent.ok === true && sent.result?.message_id, `Telegram 发送测试消息失败（${sent.error_code ?? '无效响应'}），请检查目标会话 ID、发送权限，并先向机器人发送消息。`)
  } else if (channel.type === 'feishu') {
    const auth = await request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: channel.appId, app_secret: token }, '飞书验证凭据')
    check(auth.code === 0 && typeof auth.tenant_access_token === 'string' && auth.tenant_access_token, `飞书验证凭据失败（${auth.code ?? '无效响应'}），请检查 App ID 和 App Secret。`)
    credentials.push(auth.tenant_access_token)
    const sent = await request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      receive_id: channel.destination, msg_type: 'text', content: JSON.stringify({ text: CONNECTION_TEST_MESSAGE })
    }, '飞书发送测试消息', `Bearer ${auth.tenant_access_token}`)
    check(sent.code === 0 && sent.data?.message_id, `飞书发送测试消息失败（${sent.code ?? '无效响应'}），请检查目标会话 ID、机器人发送权限和应用发布状态。`)
  } else {
    const sent = await request(`https://discord.com/api/v10/channels/${encodeURIComponent(channel.destination)}/messages`, {
      content: CONNECTION_TEST_MESSAGE, allowed_mentions: { parse: [] }
    }, 'Discord 发送测试消息', `Bot ${token}`)
    check(typeof sent.id === 'string' && sent.id, 'Discord 未确认测试消息，请检查目标频道及机器人发送权限。')
  }
}

function testWecom(channel: ChannelConfig, token: string, signal: AbortSignal, wsUrl?: string, transport?: ChannelTransport): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new AiBot.WSClient({ botId: channel.appId!, secret: token, wsUrl, wsOptions: { agent: transport?.agent }, maxReconnectAttempts: 0, maxAuthFailureAttempts: 1,
      logger: { debug() {}, info() {}, warn() {}, error() {} } })
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      client.disconnect()
      if (error) reject(error); else resolve()
    }
    const onAbort = () => finish(signal.reason)
    client.on('error', error => finish(new Error(`企业微信连接失败：${error.message}。请检查 Bot ID、Secret 和网络。`)))
    client.on('disconnected', () => finish(new Error('企业微信连接已断开，请检查网络和机器人配置。')))
    client.once('authenticated', () => {
      if (settled) return
      void client.sendMessage(channel.destination, { msgtype: 'markdown', markdown: { content: CONNECTION_TEST_MESSAGE } })
        .then(result => {
          if (result.errcode || !result.headers?.req_id) finish(new Error(`企业微信发送测试消息失败（${result.errcode ?? '无效响应'}），请检查目标会话 ID 和机器人发送权限。`))
          else finish()
        }).catch(error => finish(new Error(`企业微信发送测试消息失败：${error instanceof Error ? error.message : '未知错误'}。请检查目标会话 ID 和机器人发送权限。`)))
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort(); else client.connect()
  })
}

function testCodex(connection: RemoteConfig['codex'][number], token: string | undefined, signal: AbortSignal, transport: ChannelTransport): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(connection.url, { agent: transport.agent, headers: token ? { authorization: `Bearer ${token}` } : {}, handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024 })
    let settled = false
    let expectedId = 1
    const loadedThreads = new Set<string>()
    const cursors = new Set<string>()
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      socket.terminate()
      if (error) reject(error); else resolve(loadedThreads.size)
    }
    const onAbort = () => finish(signal.reason)
    const send = (message: unknown) => socket.send(JSON.stringify(message), error => { if (error) finish(error) })
    socket.on('error', error => finish(new Error(`Codex 连接失败：${error.message}。请检查服务地址和认证配置。`)))
    socket.on('close', () => finish(new Error('Codex 服务在完成测试前断开连接，请检查服务状态。')))
    socket.on('open', () => {
      if (!settled) send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cute_island_connection_test', version: '1.0.0' }, capabilities: { experimentalApi: true } } })
    })
    socket.on('message', bytes => {
      if (settled) return
      try {
        const message = JSON.parse(bytes.toString())
        if (message.id !== expectedId) return
        check(!message.error, `Codex 协议请求失败：${message.error?.message ?? '未知错误'}`)
        check(message.result && typeof message.result === 'object', 'Codex 服务返回了无效响应。')
        if (expectedId === 1) {
          expectedId = 2
          send({ method: 'initialized' })
          send({ id: 2, method: 'thread/loaded/list', params: {} })
        } else {
          const loaded = message.result.data
          check(Array.isArray(loaded) && loaded.every(id => typeof id === 'string'), 'Codex 服务返回了无效线程列表。')
          for (const id of loaded) loadedThreads.add(id)
          const cursor = message.result.nextCursor
          check(cursor == null || typeof cursor === 'string', 'Codex 服务返回了无效分页信息。')
          if (cursor) {
            check(!cursors.has(cursor), 'Codex 服务重复返回同一分页，请检查服务版本后重试。')
            cursors.add(cursor)
            send({ id: ++expectedId, method: 'thread/loaded/list', params: { cursor } })
            return
          }
          const missing = connection.threads.filter(id => !loadedThreads.has(id))
          check(!missing.length, `Codex 服务已连接，但指定线程尚未加载：${missing.join('、')}。请先在同一服务中打开目标会话，再重新测试。`)
          finish()
        }
      } catch (error) { finish(error) }
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}
