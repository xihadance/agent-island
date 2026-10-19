import { afterEach, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { once } from 'node:events'
import { CodexAutomation } from './codex-automation'
import { normalizePreferences, patchPreferences } from '../shared/preferences'
import type { Decision } from '../shared/automation'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const wait = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('Timed out')
}

it.each(['item/tool/requestUserInput', 'tool/requestUserInput'])('joins loaded threads, returns native responses exactly once, and leaves manual %s requests for the original client', async method => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  let peer: WebSocket | undefined
  const messages: Record<string, unknown>[] = []
  server.on('connection', socket => {
    peer = socket
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      messages.push(message)
      if (message.id && message.method) socket.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: ['live-thread'], nextCursor: null } : {} }))
    })
  })
  let preferences = patchPreferences(normalizePreferences(undefined), { automation: { enabled: true, codexUrl: `ws://127.0.0.1:${address.port}` } })
  const reports: Decision[] = []
  const connector = new CodexAutomation(() => preferences, () => {}, decision => reports.push(decision))
  cleanup.push(() => connector.stop())
  connector.update()
  await wait(() => messages.some(message => message.method === 'thread/resume'))
  expect(connector.status).toBe('connected')
  expect(messages.find(message => message.method === 'thread/resume')?.params).toEqual({ threadId: 'live-thread', excludeTurns: true })
  const approval = { id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'live-thread', availableDecisions: ['accept', 'decline'] } }
  peer!.send(JSON.stringify(approval))
  peer!.send(JSON.stringify(approval))
  await wait(() => messages.some(message => message.id === 8))
  expect(messages.filter(message => message.id === 8)).toEqual([{ id: 8, result: { decision: 'accept' } }])
  const recommended = { id: 'recommended', method, params: { threadId: 'live-thread', questions: [{ id: 'q', options: [{ label: 'A' }, { label: 'B（推荐）' }] }] } }
  peer!.send(JSON.stringify(recommended))
  peer!.send(JSON.stringify(recommended))
  await wait(() => messages.some(message => message.id === 'recommended'))
  expect(messages.filter(message => message.id === 'recommended')).toEqual([{ id: 'recommended', result: { answers: { q: { answers: ['B（推荐）'] } } } }])
  const question = { id: 9, method, params: { questions: [{ id: 'q', options: [{ label: 'A' }, { label: 'B' }] }] } }
  peer!.send(JSON.stringify(question))
  await wait(() => reports.some(report => report.action === 'manual'))
  expect(messages.some(message => message.id === 9)).toBe(false)
  preferences = patchPreferences(preferences, { automation: { fallback: 'first' } })
  connector.update()
  await wait(() => messages.some(message => message.id === 9))
  expect(messages.find(message => message.id === 9)?.result).toEqual({ answers: { q: { answers: ['A'] } } })
  peer!.send(JSON.stringify({ id: 10, method, params: { questions: [{ id: 'secret', isSecret: true, options: [{ label: 'A (Recommended)' }] }] } }))
  await wait(() => reports.filter(report => report.action === 'manual').length === 2)
  peer!.send(JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 10 } }))
  await new Promise(resolve => setTimeout(resolve, 20))
  connector.update()
  expect(messages.some(message => message.id === 10)).toBe(false)
  preferences = patchPreferences(preferences, { automation: { enabled: false } })
  connector.update()
  expect(connector.status).toBe('disabled')
})
