import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', async original => {
  const { promisify } = await import('node:util')
  Object.defineProperty(native.execFile, promisify.custom, { value: (...args: unknown[]) => new Promise((resolve, reject) => {
    native.execFile(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))
  }) })
  return { ...(await original<object>()), ...native }
})

let stop = () => {}
afterEach(() => { stop(); vi.clearAllMocks() })

async function queries() {
  vi.resetModules()
  const module = await import('./processes')
  stop = module.stopProcessQueries
  return module
}

function shellFixture() {
  const children: Array<ChildProcess & { stdout: PassThrough }> = []
  native.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, killed: false, kill: vi.fn(() => { Object.assign(child, { killed: true }); child.emit('exit', 0); return true })
    }) as unknown as ChildProcess & { stdout: PassThrough }
    children.push(child)
    return child
  })
  native.execFile.mockImplementation((_exe, _args, _options, callback) => callback(null, '[]', ''))
  return children
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const reply = (child: ChildProcess & { stdout: PassThrough }) => child.stdout.write('[]@@CUTE_ISLAND_PROCESSES_END@@\n')

it.skipIf(process.platform !== 'win32')('reuses a resident process after turning session observation off and back on', async () => {
  const children = shellFixture()
  const { listProcessSnapshot, stopProcessQueries } = await queries()
  const first = listProcessSnapshot()
  await tick()
  reply(children[0])
  await first
  stopProcessQueries()

  for (let i = 0; i < 3; i++) {
    const snapshot = listProcessSnapshot()
    await tick()
    if (children[1]) reply(children[1])
    await snapshot
  }
  expect(native.execFile).not.toHaveBeenCalled()
  expect(native.spawn).toHaveBeenCalledTimes(2)
  expect(children[0].kill).toHaveBeenCalledTimes(1)
})

it.skipIf(process.platform !== 'win32')('propagates a failed resident query without allocating a fallback console', async () => {
  const children = shellFixture()
  const { listProcessSnapshot } = await queries()
  const snapshot = listProcessSnapshot()
  const rejected = expect(snapshot).rejects.toThrow()
  await tick()
  children[0].emit('error', new Error('查询失败'))
  await rejected
  expect(native.execFile).not.toHaveBeenCalled()
})
