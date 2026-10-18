export interface LaunchAtLoginStatus {
  /** False keeps the switch visible but disabled, with `detail` explaining why. */
  supported: boolean
  /** What the operating system reports, not what the preference asks for. */
  enabled: boolean
  detail: string
}

export interface LaunchTarget {
  platform: NodeJS.Platform
  packaged: boolean
}

/**
 * A development run points at the Electron binary in node_modules, and a Linux
 * package manager owns its own autostart entries. Only a packaged application
 * may register itself, so an unpacked run never writes a login item it cannot honour.
 */
export function supportsLaunchAtLogin(target: LaunchTarget): boolean {
  return target.packaged && ['win32', 'darwin', 'linux'].includes(target.platform)
}

export function launchAtLoginDetail(target: LaunchTarget): string {
  if (!target.packaged) return '开发运行不注册开机启动，打包安装后可用'
  if (!supportsLaunchAtLogin(target)) return '当前系统不支持由应用注册开机启动'
  return target.platform === 'linux' ? '写入 XDG 自启动目录，登录桌面后随灵动岛启动' : '登录系统后自动启动灵动岛，不打开配置窗口'
}

/** Desktop entry string values take a literal backslash as an escape. */
function entryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[\r\n]+/g, ' ')
}

/**
 * Exec is reparsed by the launcher, so a path with spaces or shell characters has
 * to survive both the desktop entry escape above and that second parse.
 */
function execArgument(value: string): string {
  return `"${value.replace(/[\\"`$]/g, character => `\\${character}`)}"`
}

export const DESKTOP_ENTRY_MARKER = 'X-Cute-Island-Autostart=1'

/** The AppImage runtime remounts elsewhere on every run, so the real image path wins. */
export function autostartExecutable(execPath: string, appImage?: string): string {
  return appImage?.trim() || execPath
}

export function desktopEntry(executable: string): string {
  return ['[Desktop Entry]', 'Type=Application', 'Version=1.0', 'Name=Cute Island', 'Comment=显示本机 AI agent 的执行状态',
    `Exec=${entryValue(execArgument(executable))}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true',
    `${DESKTOP_ENTRY_MARKER}`, ''].join('\n')
}
