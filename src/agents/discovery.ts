import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { collect, mapLimited, type SessionFile } from './files'
import type { AgentPlugin } from './types'

/** Watch notifications save metadata walks; periodic reconciliation repairs missed events. */
export class SessionDiscovery {
  private watcher?: FSWatcher
  private files = new Map<string, SessionFile>()
  private dirty = new Set<string>()
  private rediscover = true
  private lastFull = -Infinity
  private generation = 0

  constructor(private readonly root: string, private readonly plugin: AgentPlugin,
    private readonly discover: typeof collect = collect) {}

  async list(now: number, watchChanges = true): Promise<SessionFile[]> {
    // An explicit one-off scan must observe changes even before OS notifications arrive.
    if (!watchChanges) return this.discover(this.root, this.plugin)
    const generation = this.generation
    if (!this.watcher) {
      try {
        const watcher = watch(this.root, { recursive: true, persistent: false }, (event, filename) => {
          if (event === 'rename' || !filename) { this.rediscover = true; return }
          const file = path.resolve(this.root, filename.toString())
          if (this.plugin.accepts(file)) this.dirty.add(file)
        })
        watcher.on('error', () => { watcher.close(); if (this.watcher === watcher) this.watcher = undefined })
        this.watcher = watcher
      } catch { /* Missing roots or unsupported watching use regular discovery. */ }
    }
    if (!this.watcher || this.rediscover || now - this.lastFull >= 60_000) {
      this.rediscover = false
      this.dirty.clear()
      const files = await this.discover(this.root, this.plugin)
      if (generation !== this.generation) return []
      this.files = new Map(files.map(file => [file.path, file]))
      this.lastFull = now
    } else {
      const dirty = [...this.dirty]
      this.dirty.clear()
      await mapLimited(dirty, 8, async file => {
        try {
          const info = await stat(file)
          if (generation !== this.generation) return
          if (!info.isFile()) return
          this.files.set(file, { plugin: this.plugin, path: file, sessionId: this.plugin.sessionIdFrom(file),
            mtimeMs: info.mtimeMs, stamp: `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}` })
        } catch { if (generation === this.generation) this.files.delete(file) }
      })
    }
    return [...this.files.values()]
  }

  close(): void {
    this.generation += 1
    this.watcher?.close()
    this.watcher = undefined
    this.files.clear()
    this.dirty.clear()
    this.rediscover = true
    this.lastFull = -Infinity
  }
}
