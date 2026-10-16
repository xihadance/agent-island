import { ProxyAgent } from 'proxy-agent'
import nodeFetch, { type RequestInit } from 'node-fetch'
import axios from 'axios'
import type { Client } from '@larksuiteoapi/node-sdk'
import { effectiveProxy, type ProxyOverride, type ProxySettings } from '../shared/proxy'

/** Electron resolves the OS proxy/PAC; the standalone CLI uses proxy environment variables. */
export type SystemProxyResolver = (url: string) => Promise<string>

export function chromiumProxy(result: string): string {
  const first = result.split(';')[0].trim()
  if (first === 'DIRECT') return ''
  const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s]+)$/i.exec(first)
  if (!match) throw new Error('系统代理返回了不支持的规则，请使用自定义代理。')
  const protocol = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5h', SOCKS: 'socks4a' }[match[1].toUpperCase()]
  return `${protocol}://${match[2]}`
}

export function createChannelTransport(global?: ProxySettings, override?: ProxyOverride, resolveSystem?: SystemProxyResolver) {
  const settings = effectiveProxy(global, override)
  // Delegate environment proxy and NO_PROXY parsing to proxy-agent in standalone CLI mode.
  const agent = new ProxyAgent()
  const fromEnvironment = agent.getProxyForUrl
  let closed = false
  agent.getProxyForUrl = async (address, request) => {
    if (closed) throw new Error('连接已关闭')
    const url = new URL(address)
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || settings.mode === 'direct') return ''
    if (settings.mode === 'custom') return settings.url!.replace(/^socks5:/, 'socks5h:')
    const proxy = resolveSystem ? chromiumProxy(await resolveSystem(address.replace(/^ws/, 'http'))) : await fromEnvironment(address, request)
    if (closed || request.destroyed) throw new Error('连接已关闭')
    return proxy
  }
  const nodeRequest = (url: string, options?: RequestInit) => nodeFetch(url, { ...options, agent })
  const fetchImpl = nodeRequest as unknown as typeof fetch
  // Lark expects response data, rather than the Axios response wrapper.
  const http = axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false, timeout: 30000 })
  http.interceptors.response.use(response => (response.config as { $return_headers?: boolean }).$return_headers
    ? { data: response.data, headers: response.headers } : response.data)
  return {
    agent, fetch: fetchImpl, nodeRequest,
    http: http as unknown as NonNullable<ConstructorParameters<typeof Client>[0]['httpInstance']>,
    close() {
      if (closed) return
      closed = true
      agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy()
    }
  }
}
export type ChannelTransport = ReturnType<typeof createChannelTransport>
