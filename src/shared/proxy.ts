export interface ProxySettings {
  mode: 'system' | 'direct' | 'custom'
  url?: string
}

export interface ProxyOverride {
  mode: ProxySettings['mode'] | 'inherit'
  url?: string
}

export function parseProxy(input: unknown, allowInherit = false): ProxyOverride | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('代理配置无效')
  const { mode, url } = input as Record<string, unknown>
  if (typeof mode !== 'string' || !['system', 'direct', 'custom', ...(allowInherit ? ['inherit'] : [])].includes(mode)) throw new Error('代理模式无效')
  if (mode !== 'custom') return { mode: mode as ProxyOverride['mode'] }
  const message = '代理地址需为 http://、https:// 或 socks5:// 地址，并填写有效端口；不要包含路径、查询或片段。'
  if (typeof url !== 'string' || url.length > 2000) throw new Error(message)
  let parsed: URL
  try { parsed = new URL(url.trim()) } catch { throw new Error(message) }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname ||
    (parsed.protocol.startsWith('socks') && !parsed.port) || parsed.port === '0' || parsed.pathname && parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(message)
  return { mode: 'custom', url: parsed.href }
}

export function effectiveProxy(global?: ProxySettings, override?: ProxyOverride): ProxySettings {
  return !override || override.mode === 'inherit' ? global ?? { mode: 'system' } : override as ProxySettings
}
