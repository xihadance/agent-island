export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateRelease {
  version: string
  tag: string
  url: string
  notes: string
  /** Unix milliseconds; 0 when the feed omits a usable timestamp. */
  publishedAt: number
}

export interface UpdateState {
  status: UpdateStatus
  current: string
  available?: UpdateRelease
  checkedAt?: number
  error?: string
  /** Whether this installation can replace itself, rather than only pointing at the download. */
  autoInstall: boolean
  /** Integer percent while downloading. */
  progress?: number
  /** Why an otherwise ready install is being held back; empty when it may proceed. */
  blockedReason?: string
}

export const UPDATE_REPOSITORY = 'xihadance/agent-island'
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_NOTES_LIMIT = 4000

export function releaseApiUrl(repository = UPDATE_REPOSITORY): string {
  return `https://api.github.com/repos/${repository}/releases/latest`
}

export function releasesPageUrl(repository = UPDATE_REPOSITORY): string {
  return `https://github.com/${repository}/releases/latest`
}

/** Only plain three-part versions compare; anything else stays unknown rather than guessed. */
function parts(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  if (!match) return undefined
  const numbers: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return numbers.every(number => Number.isSafeInteger(number)) ? numbers : undefined
}

export function compareVersions(left: string, right: string): number | undefined {
  const a = parts(left)
  const b = parts(right)
  if (!a || !b) return undefined
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  return 0
}

function isReleaseUrl(value: string, repository: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password &&
      url.pathname.startsWith(`/${repository}/releases/`)
  } catch { return false }
}

/** A release is offered only when every field checks out. A malformed feed must never prompt an update. */
export function parseRelease(value: unknown, repository = UPDATE_REPOSITORY): UpdateRelease | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (source.draft === true || source.prerelease === true) return undefined
  const tag = typeof source.tag_name === 'string' ? source.tag_name.trim() : ''
  if (!parts(tag)) return undefined
  const url = typeof source.html_url === 'string' ? source.html_url.trim() : ''
  if (!isReleaseUrl(url, repository)) return undefined
  const notes = typeof source.body === 'string' ? source.body.replace(/\r\n/g, '\n').trim().slice(0, UPDATE_NOTES_LIMIT) : ''
  const published = typeof source.published_at === 'string' ? Date.parse(source.published_at) : NaN
  return { version: tag.replace(/^v/, ''), tag, url, notes, publishedAt: Number.isFinite(published) ? published : 0 }
}

export function newerRelease(current: string, release: UpdateRelease | undefined, skippedVersion = ''): UpdateRelease | undefined {
  if (!release || release.version === skippedVersion.trim()) return undefined
  return compareVersions(current, release.version) === -1 ? release : undefined
}

export interface InstallTarget {
  platform: NodeJS.Platform
  packaged: boolean
  /** Set by the AppImage runtime; a deb installation has no such path. */
  appImage?: string
}

/**
 * Only NSIS and AppImage can replace themselves here. macOS rejects an unsigned
 * Squirrel update, and deb belongs to the system package manager.
 */
export function supportsAutoInstall(target: InstallTarget): boolean {
  if (!target.packaged) return false
  if (target.platform === 'win32') return true
  return target.platform === 'linux' && !!target.appImage?.trim()
}

export interface InstallBlockers {
  pendingRequests: number
  attentionIds: readonly string[]
  /** Sessions still executing, whose hook endpoints a restart would take away. */
  activeSessions: number
}

/**
 * A restart tears down the hook endpoints, the managed Codex service and any resume
 * child. Work already in flight must not be interrupted: a dropped or replayed control
 * action is worse than a postponed update.
 */
export function installBlockedReason(blockers: InstallBlockers): string {
  if (blockers.pendingRequests > 0) return '有远程接管请求正在等待处理，处理完成后可安装'
  if (blockers.attentionIds.length > 0) return '有会话正在等待你审批或回答，处理完成后可安装'
  if (blockers.activeSessions > 0) return '有会话正在执行，结束后可安装'
  return ''
}

/** A clock moved backwards would otherwise postpone every later check indefinitely. */
export function dueForCheck(now: number, checkedAt: number | undefined, interval = UPDATE_INTERVAL_MS): boolean {
  if (!checkedAt || !Number.isFinite(checkedAt) || checkedAt > now) return true
  return now - checkedAt >= interval
}
