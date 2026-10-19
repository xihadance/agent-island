import { expect, it } from 'vitest'
import { UpdateChecker, type UpdateCheckerOptions } from './updater'

const payload = (tag = 'v0.1.18') => ({ tag_name: tag, html_url: `https://github.com/xihadance/agent-island/releases/tag/${tag}`,
  body: '- 修复了一个问题', published_at: '2026-02-01T10:00:00Z' })

interface Harness {
  checker: UpdateChecker
  fire: () => Promise<void>
  requests: number
  changes: number
  saved: number[]
  timerDelays: number[]
  enabled: boolean
  skipped: string
  autoInstall: boolean
  blocked: string
  installs: number
  respond: (fetch: () => Promise<unknown>) => void
  advance: (ms: number) => void
}

function harness(overrides: Partial<UpdateCheckerOptions> = {}): Harness {
  let now = 1_700_000_000_000
  let timer: (() => void) | undefined
  let fetchRelease: () => Promise<unknown> = async () => payload()
  const state = {
    checker: undefined as unknown as UpdateChecker,
    requests: 0, changes: 0, saved: [] as number[], timerDelays: [] as number[], enabled: true, skipped: '',
    autoInstall: false, blocked: '', installs: 0,
    fire: async () => { const run = timer; timer = undefined; run?.(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() },
    respond: (next: () => Promise<unknown>) => { fetchRelease = next },
    advance: (ms: number) => { now += ms }
  }
  state.checker = new UpdateChecker({
    current: '0.1.17',
    enabled: () => state.enabled,
    skippedVersion: () => state.skipped,
    fetchRelease: () => { state.requests++; return fetchRelease() },
    lastCheckedAt: () => 0,
    onCheckedAt: at => state.saved.push(at),
    onChange: () => { state.changes++ },
    autoInstall: () => state.autoInstall,
    blockedReason: () => state.blocked,
    now: () => now,
    setTimer: (callback, ms) => { timer = callback; state.timerDelays.push(ms); return 1 },
    clearTimer: () => { timer = undefined },
    installer: { download: async onProgress => { onProgress(50); onProgress(100); return '0.1.18' }, install: () => { state.installs++ } },
    ...overrides
  })
  return state as Harness
}

it('starts idle and reports an available release after the first check', async () => {
  const test = harness()
  expect(test.checker.state).toEqual({ status: 'idle', current: '0.1.17', autoInstall: false })
  test.checker.start()
  expect(test.checker.state.status).toBe('idle')
  await test.fire()
  expect(test.requests).toBe(1)
  expect(test.checker.state).toMatchObject({ status: 'available', current: '0.1.17', available: { version: '0.1.18' } })
  expect(test.saved).toHaveLength(1)
  expect(test.changes).toBeGreaterThan(0)
})

it('never queries the feed while disabled', async () => {
  const test = harness()
  test.enabled = false
  test.checker.start()
  await test.checker.check(true)
  expect(test.requests).toBe(0)
  expect(test.checker.state).toEqual({ status: 'disabled', current: '0.1.17', autoInstall: false })
})

it('hides a discovered release behind the switch without losing it', async () => {
  const test = harness()
  test.checker.start()
  await test.fire()
  expect(test.checker.state.status).toBe('available')
  test.enabled = false
  test.checker.sync()
  expect(test.checker.state).toEqual({ status: 'disabled', current: '0.1.17', autoInstall: false })
  test.enabled = true
  test.checker.sync()
  expect(test.checker.state.status).toBe('available')
})

it('keeps the current version when the release is skipped', async () => {
  const test = harness()
  test.checker.start()
  await test.fire()
  test.skipped = '0.1.18'
  expect(test.checker.state).toMatchObject({ status: 'idle' })
  expect(test.checker.state.available).toBeUndefined()
  test.skipped = '0.1.17'
  expect(test.checker.state.status).toBe('available')
})

it.each([
  { label: 'a network failure', respond: async () => { throw new Error('无法连接到 GitHub') }, error: '无法连接到 GitHub' },
  { label: 'an unreadable payload', respond: async () => ({ message: 'Not Found' }), error: '未能读取版本信息，请稍后重试或手动查看发布页' },
  { label: 'a same-version release', respond: async () => payload('v0.1.17'), error: undefined }
])('survives $label without offering an update', async ({ respond, error }) => {
  const test = harness()
  test.respond(respond)
  test.checker.start()
  await test.fire()
  expect(test.checker.state.available).toBeUndefined()
  expect(test.checker.state.status).toBe(error ? 'error' : 'idle')
  expect(test.checker.state.error).toBe(error)
})

it('respects the interval but lets a manual check through', async () => {
  const test = harness({ interval: 1000 })
  test.checker.start()
  await test.fire()
  expect(test.requests).toBe(1)
  await test.checker.check()
  expect(test.requests).toBe(1)
  await test.checker.check(true)
  expect(test.requests).toBe(2)
  test.advance(1000)
  await test.checker.check()
  expect(test.requests).toBe(3)
})

it('reuses a saved timestamp so a restart does not re-query the feed', async () => {
  const test = harness({ interval: 1000, lastCheckedAt: () => 1_700_000_000_000 - 500 })
  test.checker.start()
  await test.fire()
  expect(test.requests).toBe(0)
  expect(test.checker.state.checkedAt).toBe(1_700_000_000_000 - 500)
  expect(test.timerDelays.at(-1)).toBe(500)
  test.advance(500)
  await test.fire()
  expect(test.requests).toBe(1)
  expect(test.timerDelays.at(-1)).toBe(1000)
  test.advance(1000)
  await test.fire()
  expect(test.requests).toBe(2)
})

it('ignores a saved timestamp from the future', async () => {
  const test = harness({ interval: 1000, lastCheckedAt: () => 1_700_000_000_000 + 60_000 })
  test.checker.start()
  await test.fire()
  expect(test.requests).toBe(1)
})

it('stops scheduling after stop and does not revive mid-check', async () => {
  const test = harness()
  let release: (() => void) | undefined
  test.respond(() => new Promise(resolve => { release = () => resolve(payload()) }))
  test.checker.start()
  const pending = test.checker.check(true)
  expect(test.checker.state.status).toBe('checking')
  test.checker.stop()
  release?.()
  await pending
  await test.fire()
  expect(test.requests).toBe(1)
  test.checker.stop()
  await test.fire()
  expect(test.requests).toBe(1)
})

it('stays notify-only when the installation cannot replace itself', async () => {
  const test = harness()
  test.checker.start()
  await test.fire()
  expect(test.checker.state.autoInstall).toBe(false)
  await expect(test.checker.download()).rejects.toThrow('当前安装方式不支持自动更新')
  expect(test.checker.install()).toBe('更新尚未下载完成')
  expect(test.installs).toBe(0)
})

it('downloads, reports progress and installs once staged', async () => {
  const test = harness()
  test.autoInstall = true
  test.checker.start()
  await test.fire()
  expect(test.checker.state).toMatchObject({ status: 'available', autoInstall: true })
  await test.checker.download()
  expect(test.checker.state).toMatchObject({ status: 'downloaded', blockedReason: '' })
  expect(test.checker.state.progress).toBeUndefined()
  expect(test.checker.install()).toBe('')
  expect(test.installs).toBe(1)
})

it('surfaces download progress while it runs', async () => {
  const seen: { status: string; progress?: number }[] = []
  let report: ((percent: number) => void) | undefined
  const test = harness({ installer: { download: async onProgress => { report = onProgress; return '0.1.18' }, install: () => {} } })
  test.autoInstall = true
  test.checker.start()
  await test.fire()
  const pending = test.checker.download()
  seen.push({ status: test.checker.state.status, progress: test.checker.state.progress })
  report!(42)
  seen.push({ status: test.checker.state.status, progress: test.checker.state.progress })
  await pending
  seen.push({ status: test.checker.state.status, progress: test.checker.state.progress })
  expect(seen).toEqual([{ status: 'downloading', progress: 0 }, { status: 'downloading', progress: 42 }, { status: 'downloaded', progress: undefined }])
})

it('refuses to install while a request or session is in flight', async () => {
  const test = harness()
  test.autoInstall = true
  test.checker.start()
  await test.fire()
  await test.checker.download()
  test.blocked = '有远程接管请求正在等待处理，处理完成后可安装'
  expect(test.checker.state.blockedReason).toBe('有远程接管请求正在等待处理，处理完成后可安装')
  expect(test.checker.install()).toBe('有远程接管请求正在等待处理，处理完成后可安装')
  expect(test.installs).toBe(0)
  test.blocked = ''
  expect(test.checker.install()).toBe('')
  expect(test.installs).toBe(1)
})

it('rejects a staged payload that does not match the offered release', async () => {
  const test = harness({ installer: { download: async () => '0.9.9', install: () => {} } })
  test.autoInstall = true
  test.checker.start()
  await test.fire()
  await expect(test.checker.download()).rejects.toThrow('与提示的 0.1.18 不一致')
  expect(test.checker.state.status).toBe('error')
  expect(test.checker.install()).toBe('更新尚未下载完成')
})

it('keeps the offer after a failed download and allows a retry', async () => {
  let attempts = 0
  const test = harness({ installer: { download: async () => { if (++attempts === 1) throw new Error('下载中断'); return '0.1.18' }, install: () => {} } })
  test.autoInstall = true
  test.checker.start()
  await test.fire()
  await expect(test.checker.download()).rejects.toThrow('下载中断')
  expect(test.checker.state).toMatchObject({ status: 'error', error: '下载中断', available: { version: '0.1.18' } })
  await test.checker.download()
  expect(test.checker.state.status).toBe('downloaded')
})

it('drops a staged version when a newer release appears', async () => {
  const test = harness({ interval: 1 })
  test.autoInstall = true
  test.checker.start()
  await test.fire()
  await test.checker.download()
  expect(test.checker.state.status).toBe('downloaded')
  test.respond(async () => payload('v0.1.19'))
  test.advance(10)
  await test.checker.check(true)
  expect(test.checker.state).toMatchObject({ status: 'available', available: { version: '0.1.19' } })
})

it('ignores a skipped version for download and install', async () => {
  const test = harness()
  test.autoInstall = true
  test.checker.start()
  await test.fire()
  await test.checker.download()
  expect(test.checker.installOnQuit).toBe(true)
  test.skipped = '0.1.18'
  test.checker.sync()
  expect(test.checker.installOnQuit).toBe(false)
  expect(test.checker.state.status).toBe('idle')
  expect(test.checker.install()).toBe('更新尚未下载完成')
  await test.checker.download()
  expect(test.installs).toBe(0)
  test.skipped = ''
  test.checker.sync()
  expect(test.checker.installOnQuit).toBe(true)
  test.enabled = false
  test.checker.sync()
  expect(test.checker.installOnQuit).toBe(false)
})

it('does not authorize an unverified payload to install on quit', async () => {
  const test = harness({ installer: { download: async () => '0.9.9', install: () => {} } })
  test.autoInstall = true
  await test.checker.check(true)
  await expect(test.checker.download()).rejects.toThrow('不一致')
  expect(test.checker.installOnQuit).toBe(false)
})

it('ignores overlapping checks', async () => {
  const test = harness()
  let release: (() => void) | undefined
  test.respond(() => new Promise(resolve => { release = () => resolve(payload()) }))
  test.checker.start()
  const first = test.checker.check(true)
  await test.checker.check(true)
  expect(test.requests).toBe(1)
  release?.()
  await first
  expect(test.checker.state.status).toBe('available')
})
