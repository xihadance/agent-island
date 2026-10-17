import { resolveSystemProxy } from './proxy'
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { initRemoteConfig, readRemoteConfig, type RemoteConfig } from '../control/config'
import { createControlRuntime, type ControlRuntime } from '../control/runtime'
import { SessionWatcher } from '../agents/watch'
import { ActivityError, ActivityStore } from '../shared/activity'
import { DEMO_ID, demoFrames, playDemoFrames } from '../shared/demo'
import { startStatusServer, type StatusServer } from './server'
import { TRAY_ICON } from './tray-icon'
import { constrainPosition, dockAfterDrag, dockedPosition, positionAfterDrag, type DockState, type Point, type WindowPosition } from '../shared/window-position'
import { readWindowPosition, saveWindowPosition } from './window-position'
import { AttentionTracker, isIslandMode, isPassive, islandAttention, shouldIgnoreMouse, type IslandBehavior, type IslandMode } from '../shared/island-behavior'
import { readPreferences, savePreferences } from './preferences'
import { normalizePreferences, patchPreferences, type AutomationEntry, type SettingsSnapshot } from '../shared/preferences'
import { decideClaude, type Decision } from '../shared/automation'
import { CodexAutomation } from './codex-automation'
import { hasClaudeIntegration, setClaudeIntegration } from './claude-integration'
import { remoteSettings, saveRemoteSettings } from './remote-settings'
import { testRemoteConnection } from '../control/connectivity'
import { ManagedCodexServer } from './codex-server'
import { remoteIntegrationStatus, setRemoteIntegration, writeHookLauncher, type HookAgent } from './remote-integration'
import { codexCommandStatus, setCodexCommandIntegration, writeCodexLaunchConfig, type CodexCommandOptions } from './codex-command'
import { codexLaunchRoute } from '../shared/codex-launch'
import { localQuestions } from '../control/local-questions'
import { withQuestionRequests } from '../shared/question-request'
import { UpdateChecker } from './updater'
import { createAutoInstaller } from './auto-update'
import { installBlockedReason, releaseApiUrl, releasesPageUrl, supportsAutoInstall } from '../shared/update'
import { createChannelTransport } from '../control/proxy'

const WINDOW_WIDTH = 460
const WINDOW_HEIGHT = 560

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let server: StatusServer | null = null
let store: ActivityStore | null = null
let watcher: SessionWatcher | null = null
let control: ControlRuntime | undefined
let controlLoadError: string | undefined
let testingRemoteConnection = false
let demoToken = 0
let preferredPosition: WindowPosition | undefined
let dockCollapsed = true
let islandMode: IslandMode = 'focus'
let preferences = normalizePreferences(undefined)
let codex: CodexAutomation | undefined
let claudeInstalled = false
let hostedCodex: ManagedCodexServer | undefined
let updater: UpdateChecker | undefined
let quitting = false
let historySequence = 0
const history: AutomationEntry[] = []
const recentHooks = new Set<string>()
const attention = new AttentionTracker()
const codexLaunchToken = randomBytes(32).toString('hex')
const behaviorListeners = new Set<() => void>()
let lastBehavior = ''
let lastActivities = ''

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals')
}
if (process.env.CUTE_ISLAND_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}
if (process.env.CUTE_ISLAND_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox')
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => openSettings())
  app.whenReady().then(boot).catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
}

function readPort(): number {
  const raw = process.env.CUTE_ISLAND_PORT ?? '17321'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CUTE_ISLAND_PORT 无效: ${raw}`)
  }
  return port
}

async function boot(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId('com.cuteisland.app')
  store = new ActivityStore()
  const firstLaunch = !existsSync(preferencesFile())
  preferences = readPreferences(preferencesFile())
  nativeTheme.themeSource = preferences.theme
  nativeTheme.on('updated', syncSettingsBackground)
  islandMode = preferences.mode
  hostedCodex = new ManagedCodexServer(() => { control?.syncManagedCodex(); codex?.update(); notifySettings() })
  codex = new CodexAutomation(automationPreferences, notifySettings, decision => reportDecision('Codex', decision))
  let config: RemoteConfig | undefined
  try { config = readRemoteConfig(remoteConfigFile()) }
  catch { reportControlLoadFailure() }
  const port = config?.port ?? readPort()
  try {
    server = await startStatusServer(store, {
      port,
      token: process.env.CUTE_ISLAND_TOKEN,
      codexLaunch: { token: codexLaunchToken, route: currentCodexLaunchRoute },
      control: loadControl,
      claudeHook: payload => {
        const decision = decideClaude(payload, automationPreferences())
        const key = createHash('sha256').update(JSON.stringify([payload, decision.action, decision.summary])).digest('hex')
        if (!recentHooks.has(key)) {
          recentHooks.add(key)
          if (recentHooks.size > 256) recentHooks.delete(recentHooks.values().next().value!)
          reportDecision('Claude Code', decision)
        }
        return decision.response ?? {}
      }
    })
  } catch (error) {
    dialog.showErrorBox('Cute Island', `状态服务启动失败（端口 ${port}）。\n${errorText(error)}`)
    app.quit()
    return
  }
  console.log(`Cute Island 正在监听 http://127.0.0.1:${server.port}`)
  try { writeCodexLaunchConfig(codexCommandOptions(), `http://127.0.0.1:${server.port}/v1/codex/launch`, codexLaunchToken) }
  catch { console.error('Codex 命令接入需要重新安装，请在 Agent 接入中检查') }
  refreshHookLauncher()
  syncWatcher()
  preferredPosition = readWindowPosition(positionFile())
  claudeInstalled = hasClaudeIntegration(claudeSettingsFile(), server.port)
  attention.update(store.list())
  mainWindow = createWindow(store)
  tray = createTray()
  wireIpc(store)
  if (config) { try { loadControl() } catch { /* Reported in settings and tray. */ } }
  void hostedCodex.configure(preferences.codexServer)
  codex.update()
  updater = createUpdateChecker()
  updater.start()
  if (firstLaunch || process.argv.includes('--settings')) openSettings()
  app.on('before-quit', event => {
    if (!quitting && hostedCodex) {
      event.preventDefault(); quitting = true
      void hostedCodex.close().finally(() => app.quit())
      return
    }
    watcher?.stop()
    codex?.stop()
    updater?.stop()
    control?.close()
    tray?.destroy()
    store?.dispose()
    void server?.close()
  })
  app.on('activate', () => openSettings())
  app.on('window-all-closed', () => {
    app.quit()
  })
}

function createWindow(activityStore: ActivityStore): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    backgroundColor: '#00000000',
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
  placeWindow(win)
  ignoreMouse(win, true)
  const stopTracking = trackPointer(win)
  win.on('closed', () => {
    stopTracking()
    unsubscribe()
    if (mainWindow === win) mainWindow = null
  })
  const unsubscribe = activityStore.subscribe((activities) => {
    publishActivities(activities)
  })
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([{ label: '打开配置…', accelerator: 'CmdOrCtrl+,', click: openSettings }]).popup({ window: win })
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

function defaultPosition(): Point {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
    y: workArea.y + 4
  }
}

function positionFile(): string {
  return path.join(app.getPath('userData'), 'window-position.json')
}

function preferencesFile(): string {
  return path.join(app.getPath('userData'), 'preferences.json')
}

function remoteConfigFile(): string {
  return process.env.CUTE_ISLAND_REMOTE_CONFIG ?? path.join(os.homedir(), '.cute-island', 'remote.json')
}

function loadControl(): ControlRuntime | undefined {
  if (control || !store) return control
  let config: RemoteConfig | undefined
  try { config = readRemoteConfig(remoteConfigFile()) }
  catch { throw new ActivityError(503, reportControlLoadFailure()) }
  if (!config) {
    controlLoadError = undefined
    if (tray) updateTrayMenu(tray)
    return undefined
  }
  if (server && config.port !== server.port) throw new ActivityError(503, reportControlLoadFailure('接管配置端口已修改，请重启应用后开启接管'))
  try {
    control = createControlRuntime(config, store, { configFile: remoteConfigFile(), resolveSystemProxy,
      managedCodexUrl: () => preferences.codexServer.enabled && hostedCodex?.state.status === 'running' ? hostedCodex.state.url : '',
      onRequestsChange: () => publishActivities(), onChange: () => { publishActivities(); codex?.update(); if (tray) updateTrayMenu(tray); notifySettings() } })
  } catch { throw new ActivityError(503, reportControlLoadFailure()) }
  controlLoadError = undefined
  void control.start().catch(() => console.error('远程接管启动失败，请检查配置'))
  codex?.update()
  if (tray) updateTrayMenu(tray)
  notifySettings()
  return control
}

function reportControlLoadFailure(message = '远程接管不可用，请检查配置文件和状态文件，修复后重新开启'): string {
  // JSON parse errors can contain configuration fragments, including credentials.
  if (controlLoadError !== message) console.error(message)
  controlLoadError = message
  if (tray) updateTrayMenu(tray)
  return message
}

function setRemoteEnabled(enabled: boolean): void {
  try {
    if (enabled && testingRemoteConnection) throw new Error('连接测试正在进行，请完成后再开启远程接管')
    const runtime = loadControl()
    if (!runtime) throw new Error('请先通过托盘的“配置远程接管”创建配置')
    runtime.setEnabled(enabled)
  } catch (error) {
    dialog.showErrorBox('远程接管切换失败', errorText(error))
  } finally { if (tray) updateTrayMenu(tray) }
}

async function configureRemote(): Promise<void> {
  try {
    const file = remoteConfigFile()
    if (!existsSync(file)) initRemoteConfig(file, server?.port ?? readPort())
    if (tray) updateTrayMenu(tray)
    const error = await shell.openPath(file)
    if (error) throw new Error(`无法打开配置文件：${file}\n${error}`)
  } catch (error) { dialog.showErrorBox('打开接管配置失败', errorText(error)) }
}

function currentBehavior(): IslandBehavior {
  return { mode: islandMode, attentionIds: attention.pendingIds() }
}

function visibleActivities(activities = store?.list() ?? []) {
  return withQuestionRequests(activities, control?.status().enabled ? localQuestions(control.hub.store.snapshot()) : [])
}

function publishActivities(activities = store?.list() ?? []): void {
  const next = visibleActivities(activities)
  const key = JSON.stringify(next)
  if (lastActivities === key) {
    if (updater?.state.status === 'downloaded') notifySettings()
    return
  }
  lastActivities = key
  attention.update(next)
  notifyBehavior()
  if (updater?.state.status === 'downloaded') notifySettings()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFocusable(next.some(activity => activity.questionRequest?.status === 'pending' && activity.questionRequest.connected))
    mainWindow.webContents.send('island:activities', next)
  }
}

function notifyBehavior(): void {
  const behavior = currentBehavior()
  const key = JSON.stringify(behavior)
  if (key === lastBehavior) return
  lastBehavior = key
  for (const listener of behaviorListeners) listener()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('island:behavior', behavior)
}

function setIslandMode(mode: IslandMode): void {
  if (islandMode === mode) return
  try { updatePreferences({ mode }) }
  catch (error) { dialog.showErrorBox('无法保存配置', errorText(error)) }
}

function claudeSettingsFile(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json')
}

function automationPreferences() {
  return { ...preferences, automation: { ...preferences.automation, enabled: preferences.automation.enabled && !control?.status().enabled && !quitting,
    codexUrl: preferences.codexServer.enabled ? hostedCodex?.state.status === 'running' ? hostedCodex.state.url : '' : preferences.automation.codexUrl } }
}

function remoteHookOptions(agent: HookAgent) {
  const file = agent === 'claude' ? claudeSettingsFile() : agent === 'cursor' ? path.join(process.env.CURSOR_HOME ?? path.join(os.homedir(), '.cursor'), 'hooks.json')
    : path.join(process.env.GEMINI_CLI_HOME ?? path.join(os.homedir(), '.gemini'), 'settings.json')
  return { file, agent, config: remoteConfigFile(), runner: [path.join(app.getPath('userData'), 'hooks', `cute-island-remote-hook.${process.platform === 'win32' ? 'cmd' : 'sh'}`)] }
}

function codexCommandOptions(): CodexCommandOptions {
  return { directory: path.join(app.getPath('userData'), 'codex-command'), runner: [process.execPath, path.join(app.getAppPath(), 'out', 'cli.cjs')] }
}

function currentCodexLaunchRoute() {
  if (quitting) return { enabled: false }
  const hostedUrl = preferences.codexServer.enabled && hostedCodex?.state.status === 'running' ? hostedCodex.state.url : ''
  const takeover = control?.status().enabled === true
  if (takeover) {
    if (!control?.status().running || control.status().error) return { enabled: false }
    try { return codexLaunchRoute(preferences, hostedUrl, readRemoteConfig(remoteConfigFile()), true) }
    catch { return { enabled: false } }
  }
  return codexLaunchRoute(preferences, hostedUrl)
}

function settingsSnapshot(): SettingsSnapshot {
  return { codexCommand: codexCommandStatus(codexCommandOptions()), codexServer: hostedCodex?.state ?? { status: 'stopped', url: '', detail: '' },
    remoteHooks: { claude: remoteIntegrationStatus(remoteHookOptions('claude')), cursor: remoteIntegrationStatus(remoteHookOptions('cursor')), gemini: remoteIntegrationStatus(remoteHookOptions('gemini')) },
    remote: remoteSettings(remoteConfigFile(), control?.status(), controlLoadError), preferences, version: app.getVersion(), port: server?.port ?? readPort(),
    watchDisabledByEnvironment: process.env.CUTE_ISLAND_WATCH === '0', claudeInstalled,
    codexStatus: codex?.status ?? 'disabled', codexDetail: codex?.detail ?? '', history: [...history],
    update: updater?.state ?? { status: 'disabled', current: app.getVersion(), autoInstall: false } }
}

function notifySettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('island:settings', settingsSnapshot())
}

function reportDecision(agent: string, decision: Decision): void {
  history.unshift({ id: ++historySequence, at: Date.now(), agent, action: decision.action, summary: decision.summary.slice(0, 300) })
  history.splice(50)
  notifySettings()
}

function updatesEnabled(): boolean {
  return app.isPackaged && process.env.CUTE_ISLAND_UPDATE !== '0' && preferences.update.enabled
}

/** A mirror may serve the feed, but releases still have to belong to this repository. */
function updateFeedUrl(): string {
  const custom = process.env.CUTE_ISLAND_UPDATE_FEED?.trim()
  if (!custom) return releaseApiUrl()
  let url: URL
  try { url = new URL(custom) } catch { throw new Error('CUTE_ISLAND_UPDATE_FEED 不是有效的地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('CUTE_ISLAND_UPDATE_FEED 需为不含凭据的 http/https 地址')
  return url.href
}

function updateProxy() {
  try { return readRemoteConfig(remoteConfigFile())?.proxy }
  catch { /* A damaged takeover file must not block version checks. */ }
}

/** Version lookups follow the takeover proxy so restricted networks behave the same everywhere. */
async function fetchLatestRelease(): Promise<unknown> {
  const transport = createChannelTransport(updateProxy(), undefined, resolveSystemProxy)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await transport.nodeRequest(updateFeedUrl(), { method: 'GET', signal: controller.signal as never,
      headers: { accept: 'application/vnd.github+json', 'user-agent': `cute-island/${app.getVersion()}` } })
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
    const text = (await response.text()).slice(0, 1_000_000)
    try { return JSON.parse(text) } catch { throw new Error('版本信息不是有效的 JSON') }
  } catch (error) {
    throw new Error(controller.signal.aborted ? '检查更新超时，请稍后重试' : errorText(error))
  } finally { clearTimeout(timeout); transport.close() }
}

/**
 * The installed Hook configurations point at this launcher, but the launcher itself
 * hard-codes the Electron runner it was written with. An application update moves that
 * runner, and an AppImage mounts it somewhere new on every run, so rewrite it on boot
 * exactly as the Codex command script already does. The agent configuration files are
 * untouched: only our own launcher changes.
 */
function refreshHookLauncher(): void {
  const agents: HookAgent[] = ['claude', 'cursor', 'gemini']
  if (!agents.some(agent => remoteIntegrationStatus(remoteHookOptions(agent)).installed)) return
  try { writeHookLauncher(remoteHookOptions('claude').runner[0], process.execPath, path.join(app.getAppPath(), 'out', 'cli.cjs')) }
  catch { console.error('远程接管 Hook 启动脚本刷新失败，请在远程接管中重新安装') }
}

function autoInstallSupported(): boolean {
  return supportsAutoInstall({ platform: process.platform, packaged: app.isPackaged, appImage: process.env.APPIMAGE })
}

function updateBlockedReason(): string {
  const activities = visibleActivities()
  return installBlockedReason({
    pendingRequests: control?.status().enabled ? control.hub.store.snapshot().requests.filter(request => request.status === 'pending').length : 0,
    attentionIds: attention.pendingIds(),
    activeSessions: activities.filter(activity => ['running', 'thinking', 'waiting', 'approval'].includes(activity.state)).length
  })
}

function createUpdateChecker(): UpdateChecker {
  return new UpdateChecker({
    current: app.getVersion(),
    enabled: updatesEnabled,
    skippedVersion: () => preferences.update.skippedVersion,
    fetchRelease: fetchLatestRelease,
    autoInstall: autoInstallSupported,
    installer: createAutoInstaller({ expected: () => updater?.state.available?.version, proxy: updateProxy,
      installOnQuit: () => updater?.installOnQuit === true }),
    blockedReason: updateBlockedReason,
    lastCheckedAt: () => preferences.update.lastCheckedAt,
    onCheckedAt: at => {
      // Bookkeeping only; a failed write must never interrupt the check.
      try { preferences = { ...preferences, update: { ...preferences.update, lastCheckedAt: at } }; savePreferences(preferencesFile(), preferences) }
      catch { console.error('无法保存更新检查时间') }
    },
    onChange: notifySettings
  })
}

/**
 * Close the managed Codex service before handing over to the installer. Letting
 * quitAndInstall() drive the quit would race our own two-phase before-quit handler,
 * and terminal sessions would lose their service without notice.
 */
async function installUpdate(): Promise<void> {
  if (!updater) throw new Error('更新检查未启动')
  const state = updater.state
  if (state.status !== 'downloaded') throw new Error('更新尚未下载完成')
  if (state.blockedReason) throw new Error(state.blockedReason)
  quitting = true
  codex?.stop()
  try { await hostedCodex?.close() }
  catch { console.error('托管 Codex 服务关闭失败，继续安装更新') }
  const reason = updater.install()
  if (reason) {
    // Nothing was torn down irreversibly, but this window is no longer a safe moment.
    quitting = false
    codex?.update()
    throw new Error(reason)
  }
}

function syncWatcher(): void {
  const enabled = preferences.watchSessions && process.env.CUTE_ISLAND_WATCH !== '0'
  if (enabled && !watcher && store) { watcher = new SessionWatcher(store); watcher.start() }
  else if (!enabled && watcher) { watcher.stop(); watcher = null }
}

function updatePreferences(patch: unknown): SettingsSnapshot {
  const next = patchPreferences(preferences, patch)
  savePreferences(preferencesFile(), next)
  preferences = next
  nativeTheme.themeSource = next.theme
  syncSettingsBackground()
  islandMode = next.mode
  syncWatcher()
  void hostedCodex?.configure(next.codexServer)
  codex?.update()
  updater?.sync()
  if (tray) updateTrayMenu(tray)
  notifyBehavior()
  notifySettings()
  return settingsSnapshot()
}

function resetPosition(): void {
  preferredPosition = defaultPosition()
  saveWindowPosition(positionFile(), preferredPosition)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('island:dock', currentDock())
    placeWindow(mainWindow)
  }
  reveal()
}

function openRemoteSettings(): void {
  openSettings()
  const contents = settingsWindow?.webContents
  const navigate = () => { if (contents && !contents.isDestroyed()) void contents.executeJavaScript("window.location.hash = 'settings/remote'") }
  if (contents?.isLoading()) contents.once('did-finish-load', navigate)
  else navigate()
}

function settingsBackground(): string { return nativeTheme.shouldUseDarkColors ? '#151516' : '#ffffff' }
function syncSettingsBackground(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.setBackgroundColor(settingsBackground())
}

function openSettings(): void {
  if (!app.isReady()) return
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    claudeInstalled = hasClaudeIntegration(claudeSettingsFile(), server?.port ?? readPort())
    notifySettings()
    return
  }
  const win = new BrowserWindow({
    title: 'Cute Island · 配置', width: 1040, height: 800, minWidth: 640, minHeight: 540,
    show: false, backgroundColor: settingsBackground(), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  settingsWindow = win
  win.setMenuBarVisibility(false)
  win.on('closed', () => { if (settingsWindow === win) settingsWindow = null })
  win.once('ready-to-show', () => win.show())
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.hash = 'settings'
    void win.loadURL(url.toString())
  } else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'settings' })
}

function placeWindow(win: BrowserWindow, content = { x: 167, y: 8, width: 126, height: 36 }): void {
  const desired = preferredPosition ?? defaultPosition()
  const dock = preferredPosition?.dock
  const display = screen.getDisplayNearestPoint(dock ?? { x: desired.x + WINDOW_WIDTH / 2, y: desired.y + content.y })
  const next = dock ? dockedPosition(dock, content, display.workArea, dockCollapsed && !islandAttention(currentBehavior(), dockCollapsed)) : constrainPosition(desired, content, display.workArea)
  const current = win.getBounds()
  if (current.x !== next.x || current.y !== next.y) win.setPosition(next.x, next.y)
}

function createTray(): Tray {
  const icon = nativeImage.createFromDataURL(TRAY_ICON)
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  const next = new Tray(icon)
  updateTrayMenu(next)
  next.on('click', () => reveal())
  next.on('double-click', () => openSettings())
  return next
}

function updateTrayMenu(next: Tray): void {
  const remote = control?.status()
  const configured = existsSync(remoteConfigFile())
  const remoteLabel = controlLoadError ? '不可用，请检查配置' : remote?.error ? '启动或清理失败' : remote?.enabled ? '已开启' : configured ? '已关闭' : '请先配置'
  next.setToolTip(`Cute Island · ${islandMode === 'managed' ? '托管模式' : '关注模式'}${preferences.automation.enabled ? ' · 自动审批' : ''} · 远程接管${remoteLabel}`)
  const menu = Menu.buildFromTemplate([
    { label: '打开配置…', accelerator: 'CmdOrCtrl+,', click: openSettings },
    { type: 'separator' },
    { label: '关注模式', type: 'radio', checked: islandMode === 'focus', click: () => setIslandMode('focus') },
    { label: '托管模式', type: 'radio', checked: islandMode === 'managed', click: () => setIslandMode('managed') },
    { type: 'separator' },
    { label: '自动审批', type: 'checkbox', checked: preferences.automation.enabled, click: item => {
      try { updatePreferences({ automation: { enabled: item.checked } }) }
      catch (error) { dialog.showErrorBox('无法保存配置', errorText(error)) }
    } },
    { id: 'remote-toggle', label: `远程接管（${remoteLabel}）`, type: 'checkbox', checked: remote?.enabled ?? false, enabled: configured && !testingRemoteConnection,
      click: item => setRemoteEnabled(item.checked) },
    { label: '配置远程接管…', click: openRemoteSettings },
    { type: 'separator' },
    { label: '显示灵动岛', click: () => reveal() },
    { label: '隐藏灵动岛', click: () => mainWindow?.hide() },
    { label: '恢复顶部居中', click: resetPosition },
    { label: '播放演示', click: () => void playDemo() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  next.setContextMenu(menu)
}

function ignoreMouse(win: BrowserWindow, ignore: boolean): void {
  if (win.isDestroyed()) return
  // Passing { forward: true } installs a global mouse hook. On Windows that hook
  // runs on this process, so any pause here makes the cursor stutter everywhere.
  win.setIgnoreMouseEvents(isPassive(currentBehavior()) || ignore)
}

function reveal(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.showInactive()
}

function currentDock(): DockState {
  const edge = preferredPosition?.dock?.edge ?? null
  return { edge, collapsed: edge !== null && dockCollapsed }
}

interface Interaction {
  expanded: boolean
  x: number
  y: number
  width: number
  height: number
}

function trackPointer(win: BrowserWindow): () => void {
  let interaction: Interaction = { expanded: false, x: 0, y: 0, width: 0, height: 0 }
  let ignoring = true
  let lastPointer = ''
  let drag: { start: Point; origin: Point; active: boolean } | undefined
  const applyDrag = (): void => {
    if (!drag?.active || win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const position = constrainPosition(positionAfterDrag(drag.origin, drag.start, cursor), interaction, display.workArea)
    const current = win.getBounds()
    if (current.x !== position.x || current.y !== position.y) win.setPosition(position.x, position.y)
  }
  const endDrag = (): void => {
    const moved = drag?.active
    if (drag?.active && !win.isDestroyed()) {
      applyDrag()
      const { x, y } = win.getBounds()
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
      const dock = dockAfterDrag({ x, y }, interaction, area)
      preferredPosition = { x, y, ...(dock ? { dock } : {}) }
      dockCollapsed = !!dock
      saveWindowPosition(positionFile(), preferredPosition)
      win.webContents.send('island:dock', currentDock())
    }
    drag = undefined
    if (moved && !win.isDestroyed()) placeWindow(win, interaction)
  }
  const onDrag = (event: Electron.IpcMainEvent, phase: unknown): void => {
    if (win.isDestroyed() || event.sender !== win.webContents) return
    if (isPassive(currentBehavior())) { endDrag(); return }
    if (phase === 'start') {
      const { x, y } = win.getBounds()
      drag = { start: screen.getCursorScreenPoint(), origin: { x, y }, active: false }
      ignoring = false
      ignoreMouse(win, false)
    } else if (phase === 'move' && drag) {
      drag.active = true
      applyDrag()
    } else if (phase === 'end') endDrag()
  }
  const onInteraction = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!isInteraction(payload) || win.isDestroyed() || _event.sender !== win.webContents) return
    interaction = payload
    if (!drag && interaction.width > 0) placeWindow(win, interaction)
  }
  const reposition = (): void => {
    if (!win.isDestroyed() && !drag) placeWindow(win, interaction)
  }
  const onDockExpanded = (event: Electron.IpcMainEvent, expanded: unknown): void => {
    if (event.sender !== win.webContents || win.isDestroyed() || typeof expanded !== 'boolean' || !preferredPosition?.dock) return
    if (isPassive(currentBehavior())) return
    dockCollapsed = !expanded
    win.webContents.send('island:dock', currentDock())
    placeWindow(win, interaction)
  }
  ipcMain.on('island:drag', onDrag)
  ipcMain.on('island:set-dock-expanded', onDockExpanded)
  ipcMain.on('island:interaction', onInteraction)
  screen.on('display-metrics-changed', reposition)
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  win.on('hide', endDrag)
  win.webContents.on('render-process-gone', endDrag)
  let lastPolicy = `${islandMode}:${islandAttention(currentBehavior(), currentDock().collapsed)}`
  const syncBehavior = (): void => {
    if (win.isDestroyed()) return
    const policy = `${islandMode}:${islandAttention(currentBehavior(), currentDock().collapsed)}`
    if (policy === lastPolicy) return
    lastPolicy = policy
    if (isPassive(currentBehavior())) endDrag()
    // Never leave an expanded focus window intercepting the desktop on mode change.
    ignoring = true
    ignoreMouse(win, true)
    lastPointer = ''
    if (!drag) placeWindow(win, interaction)
  }
  behaviorListeners.add(syncBehavior)
  const timer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return
    applyDrag()
    const point = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    const localX = point.x - bounds.x
    const localY = point.y - bounds.y
    const overWindow = localX >= 0 && localY >= 0 && localX <= bounds.width && localY <= bounds.height
    const overIsland =
      interaction.width > 0 &&
      localX >= interaction.x &&
      localY >= interaction.y &&
      localX <= interaction.x + interaction.width &&
      localY <= interaction.y + interaction.height
    const ignore = shouldIgnoreMouse(currentBehavior(), overIsland, interaction.expanded, !!drag, currentDock().collapsed)
    if (ignore !== ignoring) {
      ignoring = ignore
      ignoreMouse(win, ignore)
    }
    // The renderer only uses proximity to the top edge, not every global movement.
    const nearTop = overWindow && localY <= 72
    const pointerKey = `${nearTop}:${overIsland}`
    if (pointerKey === lastPointer || win.webContents.isDestroyed()) return
    lastPointer = pointerKey
    win.webContents.send('island:pointer', { x: localX, y: localY, overWindow, overIsland })
  }, 32)
  return () => {
    clearInterval(timer)
    behaviorListeners.delete(syncBehavior)
    ipcMain.removeListener('island:drag', onDrag)
    ipcMain.removeListener('island:set-dock-expanded', onDockExpanded)
    ipcMain.removeListener('island:interaction', onInteraction)
    screen.off('display-metrics-changed', reposition)
    screen.off('display-added', reposition)
    screen.off('display-removed', reposition)
  }
}

function isInteraction(value: unknown): value is Interaction {
  if (!value || typeof value !== 'object') return false
  const hit = value as Partial<Interaction>
  return (
    typeof hit.expanded === 'boolean' &&
    Number.isFinite(hit.x) && Number.isFinite(hit.y) &&
    typeof hit.width === 'number' && Number.isFinite(hit.width) && hit.width >= 0 &&
    typeof hit.height === 'number' && Number.isFinite(hit.height) && hit.height >= 0
  )
}

function wireIpc(activityStore: ActivityStore): void {
  ipcMain.handle('island:open-settings', openSettings)
  ipcMain.handle('island:get-settings', () => settingsSnapshot())
  ipcMain.handle('island:update-settings', (event, patch: unknown) => {
    if (event.sender !== settingsWindow?.webContents) throw new Error('请从配置窗口修改设置')
    return updatePreferences(patch)
  })
  ipcMain.handle('island:save-remote', (event, draft: unknown, revision: unknown) => {
    if (event.sender !== settingsWindow?.webContents) throw new Error('请从配置窗口修改设置')
    if (control?.status().enabled) throw new Error('请先关闭远程接管，再保存配置')
    saveRemoteSettings(remoteConfigFile(), draft, revision, server?.port ?? readPort())
    controlLoadError = undefined
    if (tray) updateTrayMenu(tray)
    notifySettings()
    return settingsSnapshot()
  })
  ipcMain.handle('island:test-remote-connection', async (event, target: unknown) => {
    if (event.sender !== settingsWindow?.webContents) throw new Error('请从配置窗口测试连接')
    if (control?.status().enabled) throw new Error('请先关闭远程接管，再测试连接')
    if (testingRemoteConnection) throw new Error('连接测试正在进行，请稍后重试')
    testingRemoteConnection = true
    if (tray) updateTrayMenu(tray)
    try { return await testRemoteConnection(target, { resolveSystemProxy }) }
    finally { testingRemoteConnection = false; if (tray) updateTrayMenu(tray) }
  })
  ipcMain.handle('island:remote-enabled', (event, enabled: unknown) => {
    if (event.sender !== settingsWindow?.webContents || typeof enabled !== 'boolean') throw new Error('无效的远程接管操作')
    if (enabled && testingRemoteConnection) throw new Error('连接测试正在进行，请完成后再开启远程接管')
    const runtime = loadControl()
    if (!runtime) throw new Error('请先添加并保存远程渠道')
    runtime.setEnabled(enabled)
    return settingsSnapshot()
  })
  ipcMain.handle('island:remote-integration', (event, agent: unknown, installed: unknown) => {
    if (event.sender !== settingsWindow?.webContents || !['claude', 'cursor', 'gemini'].includes(String(agent)) || typeof installed !== 'boolean') throw new Error('无效的接管安装操作')
    if (installed && !existsSync(remoteConfigFile())) initRemoteConfig(remoteConfigFile(), server?.port ?? readPort())
    const options = remoteHookOptions(agent as HookAgent)
    if (installed) writeHookLauncher(options.runner[0], process.execPath, path.join(app.getAppPath(), 'out', 'cli.cjs'))
    setRemoteIntegration(options, installed)
    if (tray) updateTrayMenu(tray)
    notifySettings()
    return settingsSnapshot()
  })
  ipcMain.handle('island:claude-integration', (event, installed: unknown) => {
    if (event.sender !== settingsWindow?.webContents || typeof installed !== 'boolean') throw new Error('无效的接入操作')
    setClaudeIntegration(claudeSettingsFile(), installed, server?.port ?? readPort(), process.env.CUTE_ISLAND_TOKEN)
    claudeInstalled = hasClaudeIntegration(claudeSettingsFile(), server?.port ?? readPort())
    notifySettings()
    return settingsSnapshot()
  })
  ipcMain.handle('island:codex-command-integration', (event, installed: unknown) => {
    if (event.sender !== settingsWindow?.webContents || typeof installed !== 'boolean') throw new Error('请从配置窗口修改 Codex 命令接入')
    const options = codexCommandOptions()
    setCodexCommandIntegration(options, installed)
    if (installed) writeCodexLaunchConfig(options, `http://127.0.0.1:${server!.port}/v1/codex/launch`, codexLaunchToken)
    notifySettings()
    return settingsSnapshot()
  })
  ipcMain.handle('island:settings-action', (event, action: unknown) => {
    if (event.sender !== settingsWindow?.webContents) throw new Error('请从配置窗口操作')
    if (action === 'show') reveal()
    else if (action === 'hide') mainWindow?.hide()
    else if (action === 'reset-position') resetPosition()
    else if (action === 'remote-file') return configureRemote()
    else if (action === 'remote-docs') return shell.openExternal('https://github.com/xihadance/cute-island/blob/main/REMOTE_CONTROL.md')
    else if (action === 'update-check') void updater?.check(true)
    // Only a URL that already passed release validation is opened; otherwise the plain releases page.
    else if (action === 'update-page') return shell.openExternal(updater?.state.available?.url ?? releasesPageUrl())
    else if (action === 'update-download') return updater?.download()
    else if (action === 'update-install') return installUpdate()
    else if (action === 'clear-history') { history.length = 0; notifySettings() }
    else throw new Error('无法识别的操作')
  })
  ipcMain.handle('island:get-behavior', () => currentBehavior())
  ipcMain.on('island:set-mode', (event, mode: unknown) => {
    if (event.sender === mainWindow?.webContents && isIslandMode(mode)) setIslandMode(mode)
  })
  ipcMain.on('island:acknowledge', (event, id: unknown) => {
    if (event.sender !== mainWindow?.webContents || typeof id !== 'string') return
    attention.acknowledge(id)
    notifyBehavior()
  })
  ipcMain.handle('island:get-dock', () => currentDock())
  ipcMain.on('island:set-ignore-mouse', (event, ignore: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win !== mainWindow) return
    if (ignore === true || ignore === false) ignoreMouse(win, ignore)
  })
  ipcMain.handle('island:get-activities', () => visibleActivities(activityStore.list()))
  ipcMain.handle('island:answer-question', async (event, id: unknown, revision: unknown, answers: unknown) => {
    if (event.sender !== mainWindow?.webContents || typeof id !== 'string' || typeof revision !== 'number') throw new Error('请从灵动岛回答问题')
    if (!control?.status().enabled) throw new Error('接管已关闭，请在原 Agent 中回答')
    const request = control.hub.store.get(id)
    if (request.kind !== 'input' || request.origin === 'observation') throw new Error('此请求没有可用的问题控制关联')
    await control.hub.respond(id, revision, { action: 'answer', answers: answers as Record<string, string[]> }, 'local')
    void control.hub.flush()
  })
  ipcMain.handle('island:dismiss', (_event, id: unknown) => {
    if (typeof id === 'string') activityStore.dismiss(id)
  })
  ipcMain.handle('island:play-demo', () => {
    void playDemo()
  })
}

async function playDemo(): Promise<void> {
  if (!store) return
  const token = ++demoToken
  store.dismiss(DEMO_ID)
  await playDemoFrames(
    demoFrames,
    (frame) => {
      if (!store) return
      if (frame.upsert) store.upsert(frame.upsert)
      if (frame.end) {
        try {
          store.end(frame.end.id, frame.end)
        } catch {
          // The activity can disappear if a newer demo replaced it.
        }
      }
    },
    () => token !== demoToken
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}
