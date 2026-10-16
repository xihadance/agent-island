import { session } from 'electron'
import type { SystemProxyResolver } from '../control/proxy'

let configured: Promise<void> | undefined
export const resolveSystemProxy: SystemProxyResolver = async url => {
  const system = session.fromPartition('island-system-proxy')
  configured ??= system.setProxy({ mode: 'system' })
  await configured
  return system.resolveProxy(url)
}
