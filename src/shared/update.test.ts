import { expect, it } from 'vitest'
import { UPDATE_NOTES_LIMIT, compareVersions, dueForCheck, installBlockedReason, newerRelease, parseRelease, releaseApiUrl, releasesPageUrl, supportsAutoInstall } from './update'

const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: 'v0.1.18', html_url: 'https://github.com/xihadance/cute-island/releases/tag/v0.1.18',
  body: '## v0.1.18\n\n- 修复了一个问题\n', published_at: '2026-02-01T10:00:00Z', ...overrides
})

it.each([
  { left: '0.1.17', right: '0.1.18', expected: -1 },
  { left: '0.1.9', right: '0.1.10', expected: -1 },
  { left: '0.1.17', right: '0.1.17', expected: 0 },
  { left: '0.1.17', right: 'v0.1.17', expected: 0 },
  { left: '0.2.0', right: '0.1.99', expected: 1 },
  { left: '1.0.0', right: '0.9.9', expected: 1 },
  { left: '0.1.18', right: '0.1.17', expected: 1 }
])('compares $left with $right', ({ left, right, expected }) => {
  expect(compareVersions(left, right)).toBe(expected)
})

it.each([
  { left: '0.1', right: '0.1.0' }, { left: '0.1.17', right: '0.1.18-beta.1' }, { left: '', right: '0.1.0' },
  { left: '0.1.17', right: 'latest' }, { left: '0.1.17.1', right: '0.1.18' }, { left: '0.1.17', right: '0x1.2.3' }
])('leaves $left vs $right unknown instead of guessing', ({ left, right }) => {
  expect(compareVersions(left, right)).toBeUndefined()
  expect(compareVersions(right, left)).toBeUndefined()
})

it('reads a well-formed release', () => {
  expect(parseRelease(release())).toEqual({
    version: '0.1.18', tag: 'v0.1.18', url: 'https://github.com/xihadance/cute-island/releases/tag/v0.1.18',
    notes: '## v0.1.18\n\n- 修复了一个问题', publishedAt: Date.parse('2026-02-01T10:00:00Z')
  })
})

it.each([
  { label: 'draft', value: release({ draft: true }) },
  { label: 'prerelease', value: release({ prerelease: true }) },
  { label: 'missing tag', value: release({ tag_name: undefined }) },
  { label: 'non-numeric tag', value: release({ tag_name: 'nightly' }) },
  { label: 'prerelease tag', value: release({ tag_name: 'v0.1.18-rc.1' }) },
  { label: 'another repository', value: release({ html_url: 'https://github.com/attacker/cute-island/releases/tag/v0.1.18' }) },
  { label: 'another host', value: release({ html_url: 'https://github.com.evil.test/xihadance/cute-island/releases/tag/v0.1.18' }) },
  { label: 'credentials in URL', value: release({ html_url: 'https://user:pass@github.com/xihadance/cute-island/releases/tag/v0.1.18' }) },
  { label: 'plain HTTP', value: release({ html_url: 'http://github.com/xihadance/cute-island/releases/tag/v0.1.18' }) },
  { label: 'missing URL', value: release({ html_url: undefined }) },
  { label: 'array', value: [release()] },
  { label: 'null', value: null },
  { label: 'API error object', value: { message: 'Not Found' } }
])('refuses to offer an update from $label', ({ value }) => {
  expect(parseRelease(value)).toBeUndefined()
})

it('truncates release notes and tolerates a missing timestamp', () => {
  const parsed = parseRelease(release({ body: 'x'.repeat(UPDATE_NOTES_LIMIT + 500), published_at: 'never' }))
  expect(parsed?.notes).toHaveLength(UPDATE_NOTES_LIMIT)
  expect(parsed?.publishedAt).toBe(0)
  expect(parseRelease(release({ body: undefined }))?.notes).toBe('')
})

it('offers only a strictly newer version that was not skipped', () => {
  const next = parseRelease(release())!
  expect(newerRelease('0.1.17', next)).toBe(next)
  expect(newerRelease('0.1.18', next)).toBeUndefined()
  expect(newerRelease('0.2.0', next)).toBeUndefined()
  expect(newerRelease('0.1.17', next, '0.1.18')).toBeUndefined()
  expect(newerRelease('0.1.17', next, ' 0.1.18 ')).toBeUndefined()
  expect(newerRelease('0.1.17', next, '0.1.19')).toBe(next)
  expect(newerRelease('0.1.17', undefined)).toBeUndefined()
})

it.each([
  { label: 'never checked', checkedAt: undefined, expected: true },
  { label: 'zero', checkedAt: 0, expected: true },
  { label: 'just checked', checkedAt: 1_000_000_000_000, expected: false },
  { label: 'one hour ago', checkedAt: 1_000_000_000_000 - 3_600_000, expected: false },
  { label: 'exactly one interval ago', checkedAt: 1_000_000_000_000 - 86_400_000, expected: true },
  { label: 'two days ago', checkedAt: 1_000_000_000_000 - 172_800_000, expected: true },
  { label: 'in the future after a clock change', checkedAt: 1_000_000_000_000 + 86_400_000, expected: true },
  { label: 'not a number', checkedAt: Number.NaN, expected: true }
])('decides a check is due when last checked $label', ({ checkedAt, expected }) => {
  expect(dueForCheck(1_000_000_000_000, checkedAt)).toBe(expected)
})

it.each([
  { label: 'packaged NSIS', target: { platform: 'win32' as const, packaged: true }, expected: true },
  { label: 'packaged AppImage', target: { platform: 'linux' as const, packaged: true, appImage: '/tmp/Cute Island.AppImage' }, expected: true },
  { label: 'packaged deb', target: { platform: 'linux' as const, packaged: true }, expected: false },
  { label: 'deb with a blank AppImage path', target: { platform: 'linux' as const, packaged: true, appImage: '  ' }, expected: false },
  // An unsigned build cannot pass the Squirrel.Mac signature check.
  { label: 'packaged macOS', target: { platform: 'darwin' as const, packaged: true }, expected: false },
  { label: 'development on Windows', target: { platform: 'win32' as const, packaged: false }, expected: false },
  { label: 'development AppImage path', target: { platform: 'linux' as const, packaged: false, appImage: '/tmp/x.AppImage' }, expected: false }
])('decides self-replacement for $label', ({ target, expected }) => {
  expect(supportsAutoInstall(target)).toBe(expected)
})

const idle = { pendingRequests: 0, attentionIds: [], activeSessions: 0 }
it.each([
  { label: 'nothing in flight', blockers: idle, expected: '' },
  { label: 'a pending takeover request', blockers: { ...idle, pendingRequests: 1 }, expected: '有远程接管请求正在等待处理，处理完成后可安装' },
  { label: 'a session awaiting the user', blockers: { ...idle, attentionIds: ['claude-1'] }, expected: '有会话正在等待你审批或回答，处理完成后可安装' },
  { label: 'a session still executing', blockers: { ...idle, activeSessions: 2 }, expected: '有会话正在执行，结束后可安装' }
])('holds the install back for $label', ({ blockers, expected }) => {
  expect(installBlockedReason(blockers)).toBe(expected)
})

it('reports the most urgent blocker first', () => {
  expect(installBlockedReason({ pendingRequests: 1, attentionIds: ['a'], activeSessions: 1 }))
    .toBe('有远程接管请求正在等待处理，处理完成后可安装')
})

it('builds feed and page URLs for this repository', () => {
  expect(releaseApiUrl()).toBe('https://api.github.com/repos/xihadance/cute-island/releases/latest')
  expect(releasesPageUrl()).toBe('https://github.com/xihadance/cute-island/releases/latest')
})
