import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { launchAtLoginStatus, setLaunchAtLogin, type LaunchAtLoginOptions } from './launch-at-login'
import { DESKTOP_ENTRY_MARKER, supportsLaunchAtLogin } from '../shared/launch-at-login'

function temporary<T>(use: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'island-autostart-'))
  try { return use(directory) } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('island-autostart-')) throw new Error('Unexpected temporary path')
    rmSync(directory, { recursive: true, force: true })
  }
}

function options(overrides: Partial<LaunchAtLoginOptions> = {}): { options: LaunchAtLoginOptions; calls: unknown[] } {
  const calls: unknown[] = []
  let openAtLogin = false
  return {
    calls,
    options: {
      platform: 'win32', packaged: true, execPath: 'C:\\Program Files\\Cute Island\\Cute Island.exe',
      loginItem: { get: () => ({ openAtLogin }), set: settings => { calls.push(settings); openAtLogin = settings.openAtLogin } },
      ...overrides
    }
  }
}

it.each([
  { label: '开发运行', target: { platform: 'win32' as NodeJS.Platform, packaged: false }, supported: false },
  { label: '打包 Windows', target: { platform: 'win32' as NodeJS.Platform, packaged: true }, supported: true },
  { label: '打包 macOS', target: { platform: 'darwin' as NodeJS.Platform, packaged: true }, supported: true },
  { label: '打包 Linux', target: { platform: 'linux' as NodeJS.Platform, packaged: true }, supported: true },
  { label: '未知系统', target: { platform: 'aix' as NodeJS.Platform, packaged: true }, supported: false }
])('只在可注册的环境开放开机启动：$label', ({ target, supported }) => {
  expect(supportsLaunchAtLogin(target)).toBe(supported)
  const { options: current } = options(target)
  const status = launchAtLoginStatus(current)
  expect(status.supported).toBe(supported)
  expect(status.detail).not.toBe('')
  // An unsupported environment reports nothing enabled and refuses only the enabling call.
  if (!supported) {
    expect(status.enabled).toBe(false)
    expect(() => setLaunchAtLogin(current, false)).not.toThrow()
    expect(() => setLaunchAtLogin(current, true)).toThrow()
  }
})

it.each(['win32', 'darwin'] as const)('%s 通过系统登录项登记当前可执行文件', platform => {
  const { options: current, calls } = options({ platform })
  setLaunchAtLogin(current, true)
  expect(calls).toEqual([{ openAtLogin: true, openAsHidden: true, path: current.execPath, args: [] }])
  expect(launchAtLoginStatus(current).enabled).toBe(true)
  setLaunchAtLogin(current, false)
  expect(calls.at(-1)).toMatchObject({ openAtLogin: false })
  expect(launchAtLoginStatus(current).enabled).toBe(false)
})

it('Linux 写入 XDG 自启动文件，并在路径变化时重写', () => {
  temporary(directory => {
    const { options: base, calls } = options({ platform: 'linux', execPath: '/opt/cute island/cute-island',
      env: { XDG_CONFIG_HOME: directory } })
    const file = path.join(directory, 'autostart', 'cute-island.desktop')
    expect(launchAtLoginStatus(base).enabled).toBe(false)
    setLaunchAtLogin(base, true)
    const written = readFileSync(file, 'utf8')
    expect(written).toContain(DESKTOP_ENTRY_MARKER)
    expect(written).toContain('Exec="/opt/cute island/cute-island"')
    expect(launchAtLoginStatus(base).enabled).toBe(true)
    // Repeating the request must not rewrite an identical entry.
    setLaunchAtLogin(base, true)
    expect(readFileSync(file, 'utf8')).toBe(written)
    // An AppImage mounts elsewhere on every run, so its own image path is registered.
    const { options: appImage } = options({ platform: 'linux', execPath: '/tmp/.mount_abc/cute-island',
      appImage: '/home/user/Apps/cute-island.AppImage', env: { XDG_CONFIG_HOME: directory } })
    setLaunchAtLogin(appImage, true)
    expect(readFileSync(file, 'utf8')).toContain('Exec="/home/user/Apps/cute-island.AppImage"')
    setLaunchAtLogin(base, false)
    expect(existsSync(file)).toBe(false)
    // Linux never touches the Electron login item API.
    expect(calls).toEqual([])
  })
})

it('不接管用户自己写的同名自启动文件', () => {
  temporary(directory => {
    const { options: current } = options({ platform: 'linux', execPath: '/usr/bin/cute-island', env: { XDG_CONFIG_HOME: directory } })
    const file = path.join(directory, 'autostart', 'cute-island.desktop')
    mkdirSync(path.dirname(file), { recursive: true })
    const manual = '[Desktop Entry]\nType=Application\nExec=/usr/bin/cute-island --custom\n'
    writeFileSync(file, manual)
    expect(launchAtLoginStatus(current).enabled).toBe(false)
    setLaunchAtLogin(current, false)
    expect(readFileSync(file, 'utf8')).toBe(manual)
  })
})

it('XDG_CONFIG_HOME 为相对路径时回落到家目录', () => {
  temporary(directory => {
    const { options: current } = options({ platform: 'linux', execPath: '/usr/bin/cute-island',
      env: { XDG_CONFIG_HOME: 'relative/config' }, home: directory })
    setLaunchAtLogin(current, true)
    expect(existsSync(path.join(directory, '.config', 'autostart', 'cute-island.desktop'))).toBe(true)
  })
})
