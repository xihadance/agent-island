import { UPDATE_INTERVAL_MS, dueForCheck, newerRelease, parseRelease, type UpdateRelease, type UpdateState } from '../shared/update'

export interface UpdateInstaller {
  /** Resolves with the version actually staged, which must match what was offered. */
  download: (onProgress: (percent: number) => void) => Promise<string>
  install: () => void
}

export interface UpdateCheckerOptions {
  current: string
  /** Re-read on every tick: the environment switch, packaging and the preference can all change the answer. */
  enabled: () => boolean
  skippedVersion: () => string
  fetchRelease: () => Promise<unknown>
  lastCheckedAt: () => number
  onCheckedAt: (at: number) => void
  onChange: () => void
  /** False keeps this platform on the notify-only path. */
  autoInstall: () => boolean
  installer?: UpdateInstaller
  /** Empty means an install may proceed right now. */
  blockedReason: () => string
  interval?: number
  /** Leave the first check out of the startup path; agents matter more than versions. */
  delay?: number
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export class UpdateChecker {
  private timer: unknown
  private running = false
  private checking = false
  private downloading = false
  private downloadError = false
  private progress = 0
  private downloaded: string | undefined
  private release: UpdateRelease | undefined
  private checkedAt: number | undefined
  private error: string | undefined
  private readonly interval: number
  private readonly delay: number
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(private readonly options: UpdateCheckerOptions) {
    this.interval = options.interval ?? UPDATE_INTERVAL_MS
    this.delay = options.delay ?? 30_000
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref())
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  }

  get state(): UpdateState {
    const current = this.options.current
    const autoInstall = this.options.autoInstall() && !!this.options.installer
    if (!this.options.enabled()) return { status: 'disabled', current, autoInstall }
    const available = newerRelease(current, this.release, this.options.skippedVersion())
    const staged = available && this.downloaded === available.version
    // A failed download has to stay visible even though the release is still on offer.
    const status = this.checking ? 'checking' : this.downloading ? 'downloading' : staged ? 'downloaded'
      : this.downloadError && available ? 'error' : available ? 'available' : this.error ? 'error' : 'idle'
    return { status, current, autoInstall, ...(available ? { available } : {}), ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.error && (!available || this.downloadError) ? { error: this.error } : {}),
      ...(this.downloading ? { progress: this.progress } : {}),
      ...(staged ? { blockedReason: this.options.blockedReason() } : {}) }
  }

  get installOnQuit(): boolean {
    return this.options.enabled() && this.options.autoInstall() && !!this.downloaded &&
      newerRelease(this.options.current, this.release, this.options.skippedVersion())?.version === this.downloaded
  }

  start(): void {
    if (this.running || !this.options.enabled()) return
    this.running = true
    const saved = this.options.lastCheckedAt()
    if (saved > 0 && saved <= this.now()) this.checkedAt = saved
    this.schedule(this.delay)
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
  }

  /** Follow the preference switch without losing an already discovered release. */
  sync(): void {
    if (this.options.enabled()) this.start()
    else this.stop()
    this.options.onChange()
  }

  async check(manual = false): Promise<void> {
    if (this.checking || !this.options.enabled()) return
    if (!manual && !dueForCheck(this.now(), this.checkedAt, this.interval)) {
      if (this.running) this.schedule(this.interval - (this.now() - this.checkedAt!))
      return
    }
    this.checking = true
    this.error = undefined
    this.options.onChange()
    try {
      const release = parseRelease(await this.options.fetchRelease())
      // An unreadable or unexpected payload clears nothing and offers nothing.
      if (release) this.release = release
      else this.error = '未能读取版本信息，请稍后重试或手动查看发布页'
      const at = this.now()
      this.checkedAt = at
      this.options.onCheckedAt(at)
    } catch (error) {
      this.error = error instanceof Error ? error.message : '检查更新失败'
    } finally {
      this.checking = false
      this.options.onChange()
      // A stop() during the request must not revive the schedule.
      if (this.running) this.schedule(this.interval)
    }
  }

  async download(): Promise<void> {
    const offered = this.state.available
    if (!offered || this.downloading || this.state.status === 'downloaded') return
    const installer = this.options.installer
    if (!installer || !this.options.autoInstall()) throw new Error('当前安装方式不支持自动更新，请前往发布页下载')
    this.downloading = true
    this.downloadError = false
    this.progress = 0
    this.error = undefined
    this.options.onChange()
    try {
      const staged = await installer.download(percent => {
        this.progress = percent
        this.options.onChange()
      })
      // Never present a staged payload as the release that was offered and verified.
      if (staged !== offered.version) throw new Error(`下载到的版本 ${staged} 与提示的 ${offered.version} 不一致，请前往发布页下载`)
      this.downloaded = staged
    } catch (error) {
      this.downloadError = true
      this.error = error instanceof Error ? error.message : '下载更新失败'
      this.downloaded = undefined
      throw new Error(this.error)
    } finally {
      this.downloading = false
      this.options.onChange()
    }
  }

  /** Returns the blocking reason instead of installing; an empty string means it started. */
  install(): string {
    const state = this.state
    if (state.status !== 'downloaded') return '更新尚未下载完成'
    if (state.blockedReason) return state.blockedReason
    this.options.installer!.install()
    return ''
  }

  private schedule(ms: number): void {
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = undefined
      if (this.running) void this.check()
    }, ms)
  }
}
