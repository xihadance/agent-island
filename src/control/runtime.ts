import type { ActivityStore } from '../shared/activity'
import { check, ControlStore } from './store'
import { ControlHub } from './hub'
import { HookController } from './hooks'
import { readRemoteConfig, saveRemoteEnabled, secret, type ChannelConfig, type RemoteConfig } from './config'
import { CodexAdapter } from './codex'
import type { ChannelAdapter } from './types'

export interface ControlStatus { enabled: boolean; running: boolean; error?: string }

export function createControlRuntime(initial: RemoteConfig, activities: ActivityStore, options: { configFile?: string; onChange?: () => void } = {}) {
  let config = initial
  const store = new ControlStore(config.stateFile)
  let group = createConnections(config, activities, store)
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
      group.start()
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
        group = createConnections(config, activities, store)
        enabled = true
        start()
      }
      return status()
    },
    close() {
      if (closed) return
      closed = true; running = false; group.close()
    }
  }
}

function createConnections(config: RemoteConfig, activities: ActivityStore, store: ControlStore) {
  const hub = new ControlHub(store)
  const hooks = new HookController(hub)
  let stop = () => {}
  const connections: CodexAdapter[] = []
  const retries = new Set<ReturnType<typeof setTimeout>>()
  let closed = false
  let started = false
  async function connectChannel(channel: ChannelConfig): Promise<void> {
    if (closed) return
    let adapter: ChannelAdapter | undefined
    try {
      const args = [channel.id, channel.destination, channel.allowedUsers] as const
      if (channel.type === 'telegram') {
        const { TelegramChannel } = await import('./channels/telegram')
        adapter = new TelegramChannel(...args, secret(channel.tokenEnv), hub.store)
      } else if (channel.type === 'discord') {
        const { DiscordChannel } = await import('./channels/discord')
        adapter = new DiscordChannel(...args, secret(channel.tokenEnv))
      } else if (channel.type === 'feishu') {
        const { FeishuChannel } = await import('./channels/feishu')
        adapter = new FeishuChannel(...args, channel.appId!, secret(channel.secretEnv))
      } else {
        const { WecomChannel } = await import('./channels/wecom')
        adapter = new WecomChannel(...args, channel.appId!, secret(channel.secretEnv))
      }
      if (closed) { adapter.close(); return }
      await hub.addChannel(adapter)
    } catch {
      adapter?.close()
      if (closed) return
      console.error(`接管渠道 ${channel.id} 启动失败，30 秒后重试；请检查凭据、网络和配置`)
      const timer = setTimeout(() => { retries.delete(timer); void connectChannel(channel) }, 30000)
      retries.add(timer)
    }
  }
  return {
    hub, hooks,
    start() {
      if (started || closed) return
      // Validate synchronous setup before starting any background connection.
      for (const connection of config.codex) connections.push(new CodexAdapter(hub, { ...connection, token: connection.tokenEnv ? secret(connection.tokenEnv) : undefined }))
      started = true
      stop = activities.subscribe(list => {
        try { hub.observe(list) } catch { console.error('远程介入记录失败，原状态服务继续运行') }
      })
      hub.observe(activities.list())
      hub.start()
      for (const channel of config.channels) void connectChannel(channel)
      for (const connection of connections) connection.start()
    },
    close() { closed = true; for (const timer of retries) clearTimeout(timer); stop(); hub.close(); for (const connection of connections) connection.close() }
  }
}
export type ControlRuntime = ReturnType<typeof createControlRuntime>
