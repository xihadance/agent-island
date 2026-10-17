import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { BaseUpdater } from 'electron-updater/out/BaseUpdater'
import { createAutoInstaller } from './auto-update'
import { UpdateChecker } from './updater'
import type { ProxySettings } from '../shared/proxy'

const fixture = vi.hoisted(() => ({ app: undefined as unknown as EventEmitter, updater: undefined as unknown as EventEmitter & {
  autoInstallOnAppQuit: boolean
  netSession: { setProxy: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> }
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
} }))
vi.mock('electron', () => ({ get app() { return fixture.app } }))
vi.mock('electron-updater', () => ({ get autoUpdater() { return fixture.updater } }))

abstract class QuitHandlerUpdater extends BaseUpdater {
  static register(updater: QuitHandlerUpdater): void { QuitHandlerUpdater.prototype.addQuitHandler.call(updater) }
}

beforeEach(() => {
  fixture.app = new EventEmitter()
  fixture.updater = Object.assign(new EventEmitter(), {
    autoInstallOnAppQuit: true, quitHandlerAdded: false, quitAndInstallCalled: false,
    app: { onQuit: (callback: (code: number) => void) => fixture.app.on('quit', (_event, code) => callback(code)) },
    _logger: { info: () => {} },
    netSession: { setProxy: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) },
    checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '0.1.18' } })),
    downloadUpdate: vi.fn(async () => { QuitHandlerUpdater.register(fixture.updater as unknown as QuitHandlerUpdater) }),
    install: vi.fn()
  })
})

it.each([
  { label: 'skipped', disable: false }, { label: 'disabled', disable: true }
])('prevents a $label staged update from installing through the real quit handler', async ({ disable }) => {
  let skipped = ''
  let enabled = true
  const installer = createAutoInstaller({ expected: () => checker.state.available?.version, proxy: () => undefined,
    installOnQuit: () => checker.installOnQuit })
  const checker = new UpdateChecker({ current: '0.1.17', enabled: () => enabled, skippedVersion: () => skipped,
    lastCheckedAt: () => 0, onCheckedAt: () => {}, onChange: () => {}, autoInstall: () => true, blockedReason: () => '', installer,
    fetchRelease: async () => ({ tag_name: 'v0.1.18', html_url: 'https://github.com/xihadance/cute-island/releases/tag/v0.1.18' }) })
  await checker.check(true)
  await checker.download()
  expect(checker.state.status).toBe('downloaded')
  if (disable) enabled = false
  else skipped = '0.1.18'
  checker.sync()
  fixture.app.emit('quit', {}, 0)
  expect(fixture.updater.install).not.toHaveBeenCalled()
})

it('installs a verified unskipped payload on normal quit', async () => {
  const installer = createAutoInstaller({ expected: () => '0.1.18', proxy: () => undefined, installOnQuit: () => true })
  await installer.download(() => {})
  fixture.app.emit('quit', {}, 0)
  expect(fixture.updater.install).toHaveBeenCalledWith(true, false)
})

it.each([
  { label: 'system default', proxy: undefined, config: { mode: 'system' } },
  { label: 'direct', proxy: { mode: 'direct' }, config: { mode: 'direct' } },
  { label: 'HTTP', proxy: { mode: 'custom', url: 'http://127.0.0.1:7890/' }, config: { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890' } },
  { label: 'HTTPS with credentials', proxy: { mode: 'custom', url: 'https://name:secret@proxy.example:8443/' }, config: { mode: 'fixed_servers', proxyRules: 'https://proxy.example:8443' } },
  { label: 'SOCKS5 remote DNS', proxy: { mode: 'custom', url: 'socks5h://127.0.0.1:1080' }, config: { mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1080' } }
])('configures the $label route before fetching installer metadata', async ({ proxy, config }) => {
  const installer = createAutoInstaller({ expected: () => '0.1.18', proxy: () => proxy as ProxySettings | undefined, installOnQuit: () => false })
  await installer.download(() => {})
  const net = fixture.updater.netSession
  expect(net.setProxy).toHaveBeenCalledWith(expect.objectContaining(config))
  expect(net.setProxy.mock.invocationCallOrder[0]).toBeLessThan(net.closeAllConnections.mock.invocationCallOrder[0])
  expect(net.closeAllConnections.mock.invocationCallOrder[0]).toBeLessThan(fixture.updater.checkForUpdates.mock.invocationCallOrder[0])
})

it('re-reads proxy changes on retry and limits authentication to the configured proxy', async () => {
  let proxy: ProxySettings = { mode: 'custom', url: 'http://name:p%40ss@proxy.example:7890' }
  const installer = createAutoInstaller({ expected: () => '0.1.18', proxy: () => proxy, installOnQuit: () => false })
  await installer.download(() => {})
  const credentials = vi.fn()
  fixture.updater.emit('login', { isProxy: true, host: 'proxy.example', port: 7890 }, credentials)
  expect(credentials).toHaveBeenLastCalledWith('name', 'p@ss')
  fixture.updater.emit('login', { isProxy: false, host: 'proxy.example', port: 7890 }, credentials)
  expect(credentials).toHaveBeenLastCalledWith('', '')
  proxy = { mode: 'direct' }
  await installer.download(() => {})
  expect(fixture.updater.netSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
  fixture.updater.emit('login', { isProxy: true, host: 'proxy.example', port: 7890 }, credentials)
  expect(credentials).toHaveBeenLastCalledWith('', '')
})
