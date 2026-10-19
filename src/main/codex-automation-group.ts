import type { Decision } from '../shared/automation'
import type { Preferences, SettingsSnapshot } from '../shared/preferences'
import { CodexAutomation } from './codex-automation'

export class CodexAutomationGroup {
  private connections = new Map<string, CodexAutomation>()
  constructor(private preferences: () => Preferences, private urls: () => string[], private changed: () => void, private report: (decision: Decision) => void) {}
  get status(): SettingsSnapshot['codexStatus'] {
    const values = [...this.connections.values()]
    return values.some(value => value.status === 'error') ? 'error' : values.some(value => value.status === 'connecting') ? 'connecting'
      : values.some(value => value.status === 'connected') ? 'connected' : 'disabled'
  }
  get detail(): string {
    return [...this.connections.values()].find(value => value.status === 'error')?.detail ??
      (this.connections.size ? `已接入 ${[...this.connections.values()].filter(value => value.status === 'connected').length}/${this.connections.size} 个 Codex 服务` : '')
  }
  connected(url: string): boolean { return this.connections.get(url)?.status === 'connected' }
  update(): void {
    const desired = new Set(this.preferences().automation.enabled ? this.urls().filter(Boolean) : [])
    for (const [url, connection] of this.connections) if (!desired.has(url)) { this.connections.delete(url); connection.stop() }
    for (const url of desired) {
      if (!this.connections.has(url)) this.connections.set(url, new CodexAutomation(() => {
        const preferences = this.preferences()
        return { ...preferences, automation: { ...preferences.automation, codexUrl: url } }
      }, this.changed, this.report))
      this.connections.get(url)!.update()
    }
  }
  stop(): void { const connections = [...this.connections.values()]; this.connections.clear(); for (const connection of connections) connection.stop() }
}
