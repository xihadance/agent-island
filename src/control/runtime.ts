import { createChannelTransport, type ChannelTransport, type SystemProxyResolver } from './proxy'
import type { ActivityStore } from '../shared/activity'
import { check, ControlStore } from './store'
import { ControlHub } from './hub'
import { HookController } from './hooks'
import { readRemoteConfig, saveRemoteEnabled, secret, type ChannelConfig, type RemoteConfig } from './config'
import { CodexAdapter } from './codex'
import { NativeSessionResumer } from './resume'
import type { ChannelAdapter } from './types'

export interface ControlStatus { enabled: boolean; running: boolean; error?: string }

export function createControlRuntime(initial: RemoteConfig, activities: ActivityStore, options: { configFile?: string; resolveSystemProxy?: SystemProxyResolver; onChange?: () => void; onRequestsChange?: () => void; managedCodexUrl?: () => string } = {}) {
  let config = initial
  const store = new ControlStore(config.stateFile)
  const stopRequests = store.subscribe(() => options.onRequestsChange?.())
  let group = createConnections(config, activities, store, options.resolveSystemProxy, options.configFile)
  let enabled = config.enabled !== false
  let running = false
  let closed = false
  let error: string | undefined
  if (!enabled) { group.close(); store.releaseControl() }
  const status = (): ControlStatus => ({ enabled, running, ...(error ? { error } : {}) })
  const persist = (value: boolean): void => { if (options.configFile) saveRemoteEnabled(options.configFile, value) }
  function start(): void {
    if (closed || !enabled || running) return
    try {
      group.start(options.managedCodexUrl?.() ?? '')
      running = true
      error = undefined
    } catch {
      group.close()
      error = '接管启动失败，请检查配置、凭据环境变量及状态文件后重新开启'
      throw new Error(error)
    } finally { options.onChange?.() }
  }
  return {
    token: initial.controlToken,
    get hub() { return group.hub },
    get hooks() { return group.hooks },
    status,
    syncManagedCodex() { if (enabled && running && !closed) group.syncCodex(options.managedCodexUrl?.() ?? '') },
    async start() { start() },
    setEnabled(value: boolean): ControlStatus {
      check(!closed, '接管服务已退出', 409)
      if (!value) {
        // Make off visible to already-running Hook subprocesses before closing connections.
        persist(false)
        enabled = false
        running = false
        group.close()
        try { store.releaseControl(); error = undefined }
        catch { error = '接管已停止，但清理待办失败，请检查状态文件后重试'; throw new Error(error) }
        finally { options.onChange?.() }
      } else {
        if (enabled && running) return status()
        if (options.configFile) {
          const next = readRemoteConfig(options.configFile)
          check(next, '接管配置不存在')
          check(next.port === initial.port && next.controlToken === initial.controlToken && next.stateFile === initial.stateFile,
            '端口、令牌或状态文件路径已修改，请重启应用后开启接管', 409)
          config = next
        }
        // Never resurrect queued work, including work left by an offline disable.
        store.releaseControl()
        persist(true)
        group.close()
        group = createConnections(config, activities, store, options.resolveSystemProxy, options.configFile)
        enabled = true
        start()
      }
      return status()
    },
    close() {
      if (closed) return
      closed = true; running = false; stopRequests(); group.close()
    }
  }
}

function createConnections(config: RemoteConfig, activities: ActivityStore, store: ControlStore, resolveSystemProxy?: SystemProxyResolver, configFile?: string) {
  const hub = new ControlHub(store)
  const hooks = new HookController(hub)
  let stop = () => {}
  const connections: CodexAdapter[] = []
  const codexEntries = new Map<string, { key: string; adapter: CodexAdapter; transport: ChannelTransport }>()
  hub.setResumer(new NativeSessionResumer(hub, activities, connections, configFile), id => activities.sessionSource(id))
  const transports = new Set<ChannelTransport>()
  const retries = new Set<ReturnType<typeof setTimeout>>()
  let closed = false
  let started = false
  function syncCodex(hostedUrl: string): void {
    if (closed) return
    const desired = managedCodexConnections(config.codex, config.channels.length ? hostedUrl : '')
    for (const [id, entry] of codexEntries) if (!desired.some(connection => connection.id === id && JSON.stringify(connection) === entry.key)) {
      entry.adapter.close()
      for (const session of store.snapshot().sessions) if (session.connectionId === id) store.settleSession(session.id, 'uncertain')
      connections.splice(connections.indexOf(entry.adapter), 1)
      entry.transport.close(); transports.delete(entry.transport); codexEntries.delete(id)
    }
    for (const connection of desired) {
      if (codexEntries.has(connection.id)) continue
      const transport = createChannelTransport(config.proxy, connection.proxy, resolveSystemProxy)
      transports.add(transport)
      const adapter = new CodexAdapter(hub, { ...connection, agent: transport.agent, token: connection.tokenEnv ? secret(connection.tokenEnv) : undefined }, created => {
        if (created) hub.observe(activities.list())
        void hub.flush()
      })
      codexEntries.set(connection.id, { key: JSON.stringify(connection), adapter, transport })
      connections.push(adapter)
      if (started) adapter.start()
    }
  }
  async function connectChannel(channel: ChannelConfig): Promise<void> {
    if (closed) return
    let adapter: ChannelAdapter | undefined
    const transport = createChannelTransport(config.proxy, channel.proxy, resolveSystemProxy)
    transports.add(transport)
    try {
      const args = [channel.id, channel.destination, channel.allowedUsers] as const
      if (channel.type === 'telegram') {
        const { TelegramChannel } = await import('./channels/telegram')
        adapter = new TelegramChannel(...args, secret(channel.tokenEnv), hub.store, transport.fetch)
      } else if (channel.type === 'discord') {
        const { DiscordChannel } = await import('./channels/discord')
        adapter = new DiscordChannel(...args, secret(channel.tokenEnv), transport)
      } else if (channel.type === 'feishu') {
        const { FeishuChannel } = await import('./channels/feishu')
        adapter = new FeishuChannel(...args, channel.appId!, secret(channel.secretEnv), transport)
      } else {
        const { WecomChannel } = await import('./channels/wecom')
        adapter = new WecomChannel(...args, channel.appId!, secret(channel.secretEnv), transport)
      }
      if (closed) { adapter.close(); return }
      await hub.addChannel(adapter)
    } catch {
      adapter?.close()
      transport.close(); transports.delete(transport)
      if (closed) return
      console.error(`接管渠道 ${channel.id} 启动失败，30 秒后重试；请检查凭据、网络和配置`)
      const timer = setTimeout(() => { retries.delete(timer); void connectChannel(channel) }, 30000)
      retries.add(timer)
    }
  }
  return {
    hub, hooks, syncCodex,
    start(hostedUrl: string) {
      if (started || closed) return
      // Validate synchronous setup before starting any background connection.
      syncCodex(hostedUrl)
      started = true
      stop = activities.subscribe(list => {
        try { hub.observe(list) } catch { console.error('远程介入记录失败，原状态服务继续运行') }
      })
      hub.observe(activities.list())
      hub.start()
      for (const channel of config.channels) void connectChannel(channel)
      for (const connection of connections) connection.start()
    },
    close() { closed = true; for (const timer of retries) clearTimeout(timer); stop(); hub.close(); for (const connection of connections) connection.close(); for (const transport of transports) transport.close(); transports.clear() }
  }
}
export function managedCodexConnections(configured: RemoteConfig['codex'], hostedUrl: string): RemoteConfig['codex'] {
  if (!hostedUrl) return configured
  const hosted = new URL(hostedUrl)
  const matches = (url: string) => {
    const candidate = new URL(url)
    return candidate.protocol === hosted.protocol && candidate.port === hosted.port && candidate.pathname === hosted.pathname &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname)
  }
  const previous = configured.find(connection => matches(connection.url))
  let id = previous?.id ?? 'island-hosted'
  while (!previous && configured.some(connection => connection.id === id)) id += '-local'
  return [...configured.filter(connection => !matches(connection.url)), { id, url: hostedUrl, threads: [], proxy: { mode: 'direct' } }]
}
export type ControlRuntime = ReturnType<typeof createControlRuntime>
