import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionDiscovery } from './discovery'
import { collect } from './files'
import { cursorPlugin } from './plugins/cursor'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), watch: vi.fn() }))
const temporary: string[] = []
afterEach(async () => { vi.resetAllMocks(); for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'island-discovery-')); temporary.push(root)
  const folder = path.join(root, 'agent-transcripts'); await mkdir(folder)
  const file = path.join(folder, 'one.jsonl'); await writeFile(file, '{}\n')
  const fake = Object.assign(new EventEmitter(), { close: vi.fn() })
  let changed!: (event: string, file: string | null) => void
  vi.mocked(watch).mockImplementation((...args: unknown[]) => {
    changed = args[2] as typeof changed
    return fake as unknown as FSWatcher
  })
  const discover = vi.fn(collect)
  const discovery = new SessionDiscovery(root, cursorPlugin, discover)
  return { root, folder, file, fake, discover, discovery, change: (event: string, file: string | null) => changed(event, file) }
}

it('reuses a directory index, refreshes changed files, and reconciles missed events', async () => {
  const s = await setup()
  try {
    const first = await s.discovery.list(0)
    expect(first).toHaveLength(1)
    await appendFile(s.file, 'changed\n')
    s.change('change', path.relative(s.root, s.file))
    const next = await s.discovery.list(10_000)
    expect(next[0].stamp).not.toBe(first[0].stamp)
    expect(s.discover).toHaveBeenCalledTimes(1)
    await s.discovery.list(20_000)
    expect(s.discover).toHaveBeenCalledTimes(1)
    await writeFile(path.join(s.folder, 'missed.jsonl'), '{}\n')
    expect(await s.discovery.list(60_000)).toHaveLength(2)
    expect(s.discover).toHaveBeenCalledTimes(2)
  } finally { s.discovery.close(); expect(s.fake.close).toHaveBeenCalledTimes(1) }
})

it('discovers renames and falls back to walking when watching fails', async () => {
  const s = await setup()
  try {
    await s.discovery.list(0)
    await writeFile(path.join(s.folder, 'new.jsonl'), '{}\n')
    s.change('rename', 'agent-transcripts/new.jsonl')
    expect(await s.discovery.list(10_000)).toHaveLength(2)
    s.fake.emit('error', new Error('watch lost'))
    vi.mocked(watch).mockImplementation(() => { throw new Error('unsupported') })
    await rm(s.file)
    expect(await s.discovery.list(20_000)).toHaveLength(1)
    await s.discovery.list(30_000)
    expect(s.discover).toHaveBeenCalledTimes(4)
  } finally { s.discovery.close() }
})
