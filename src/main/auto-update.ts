import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInstaller } from './updater'
import type { ProxySettings } from '../shared/proxy'

// Every progress event would otherwise serialize and push the whole settings snapshot.
const PROGRESS_MIN_INTERVAL_MS = 400

interface AutoInstallerOptions {
  expected: () => string | undefined
  proxy: () => ProxySettings | undefined
  installOnQuit: () => boolean
}

/**
 * The release feed in shared/update.ts decides what is offered; electron-updater only
 * fetches the artifact for the version already validated there. A mismatch is reported
 * back to UpdateChecker, which refuses to stage it.
 */
export function createAutoInstaller(options: AutoInstallerOptions): UpdateInstaller {
  let configured = false
  let proxyUrl: URL | undefined
  function configure(): void {
    if (configured) return
    configured = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = { info: () => {}, warn: () => {}, error: message => console.error(`更新下载失败：${message}`) }
    // Register before electron-updater's quit listener: skipped or unverified payloads must not install.
    app.on('quit', () => { autoUpdater.autoInstallOnAppQuit = options.installOnQuit() })
    autoUpdater.on('login', (info, callback) => {
      const port = proxyUrl?.port || (proxyUrl?.protocol === 'https:' ? '443' : '80')
      if (info.isProxy && proxyUrl?.username && info.host === proxyUrl.hostname && info.port === Number(port)) {
        callback(decodeURIComponent(proxyUrl.username), decodeURIComponent(proxyUrl.password))
      } else callback('', '')
    })
  }

  async function configureProxy(): Promise<void> {
    const proxy = options.proxy() ?? { mode: 'system' }
    proxyUrl = proxy.mode === 'custom' ? new URL(proxy.url!) : undefined
    const netSession = autoUpdater.netSession
    if (proxyUrl) {
      const protocol = proxyUrl.protocol.replace(/^socks5h:/, 'socks5:')
      await netSession.setProxy({ mode: 'fixed_servers', proxyRules: `${protocol}//${proxyUrl.host}`,
        proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' })
    } else await netSession.setProxy({ mode: proxy.mode === 'direct' ? 'direct' : 'system' })
    // Retrying after a proxy change must not reuse connections from the previous route.
    await netSession.closeAllConnections()
  }

  return {
    async download(onProgress) {
      configure()
      let version: string | undefined
      try {
        await configureProxy()
        version = (await autoUpdater.checkForUpdates())?.updateInfo.version
      }
      catch (error) {
        // Paths and provider internals must not reach the settings window.
        console.error(`更新下载失败：${error instanceof Error ? error.message : error}`)
        throw new Error('发布源没有提供此安装方式的更新信息，请前往发布页手动下载')
      }
      if (!version) throw new Error('未找到可下载的安装包，请前往发布页手动下载')
      if (version !== options.expected()) throw new Error(`发布源的安装包版本为 ${version}，与提示不一致，请前往发布页下载`)
      let last = 0
      let reported = -1
      const listener = (progress: { percent: number }): void => {
        const percent = Math.min(100, Math.max(0, Math.round(progress.percent)))
        const now = Date.now()
        if (percent === reported || (percent < 100 && now - last < PROGRESS_MIN_INTERVAL_MS)) return
        last = now
        reported = percent
        onProgress(percent)
      }
      autoUpdater.on('download-progress', listener)
      try { await autoUpdater.downloadUpdate() }
      catch (error) {
        console.error(`更新下载失败：${error instanceof Error ? error.message : error}`)
        throw new Error('下载安装包失败，请检查网络或代理后重试，也可前往发布页手动下载')
      }
      finally { autoUpdater.off('download-progress', listener) }
      return version
    },
    install() {
      // isSilent false keeps the assisted NSIS installer visible, as the user chose this moment.
      autoUpdater.quitAndInstall(false, true)
    }
  }
}
