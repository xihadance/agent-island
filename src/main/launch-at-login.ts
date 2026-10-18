import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { autostartExecutable, desktopEntry, DESKTOP_ENTRY_MARKER, launchAtLoginDetail, supportsLaunchAtLogin,
  type LaunchAtLoginStatus } from '../shared/launch-at-login'

/** The slice of Electron's login item API this module needs, so it stays testable. */
export interface LoginItemApi {
  get: () => { openAtLogin: boolean }
  set: (settings: { openAtLogin: boolean; openAsHidden?: boolean; path?: string; args?: string[] }) => void
}

export interface LaunchAtLoginOptions {
  platform: NodeJS.Platform
  packaged: boolean
  execPath: string
  loginItem: LoginItemApi
  /** Set by the AppImage runtime; a deb installation has no such path. */
  appImage?: string
  env?: NodeJS.ProcessEnv
  home?: string
}

const FILE_NAME = 'cute-island.desktop'

function autostartFile(options: LaunchAtLoginOptions): string {
  const env = options.env ?? process.env
  const config = env.XDG_CONFIG_HOME?.trim()
  const base = config && path.isAbsolute(config) ? config : path.join(options.home ?? os.homedir(), '.config')
  return path.join(base, 'autostart', FILE_NAME)
}

/** Only an entry this application wrote is read or replaced; a hand-made one is left alone. */
function ownedEntry(file: string): string | undefined {
  try {
    const text = readFileSync(file, 'utf8')
    return text.includes(DESKTOP_ENTRY_MARKER) ? text : undefined
  } catch { return undefined }
}

export function launchAtLoginStatus(options: LaunchAtLoginOptions): LaunchAtLoginStatus {
  const target = { platform: options.platform, packaged: options.packaged }
  const detail = launchAtLoginDetail(target)
  if (!supportsLaunchAtLogin(target)) return { supported: false, enabled: false, detail }
  try {
    if (options.platform === 'linux') return { supported: true, enabled: !!ownedEntry(autostartFile(options)), detail }
    return { supported: true, enabled: options.loginItem.get().openAtLogin === true, detail }
  } catch { return { supported: true, enabled: false, detail: '无法读取开机启动状态，请重新设置' } }
}

/**
 * Idempotent on purpose: an application update moves the executable and an AppImage
 * mounts somewhere new on every run, so the entry is rewritten whenever it drifted.
 */
export function setLaunchAtLogin(options: LaunchAtLoginOptions, enabled: boolean): void {
  const target = { platform: options.platform, packaged: options.packaged }
  if (!supportsLaunchAtLogin(target)) {
    if (!enabled) return
    throw new Error(launchAtLoginDetail(target))
  }
  if (options.platform !== 'linux') {
    // openAsHidden only affects macOS; the island shows a capsule, never a window.
    options.loginItem.set({ openAtLogin: enabled, openAsHidden: true, path: options.execPath, args: [] })
    return
  }
  const file = autostartFile(options)
  if (!enabled) {
    if (ownedEntry(file)) rmSync(file, { force: true })
    return
  }
  const content = desktopEntry(autostartExecutable(options.execPath, options.appImage))
  if (ownedEntry(file) === content) return
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    renameSync(temporary, file)
  } finally { if (existsSync(temporary)) rmSync(temporary, { force: true }) }
}
