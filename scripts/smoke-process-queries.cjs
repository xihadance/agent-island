// node scripts/smoke-process-queries.cjs
// Exercise the real resident PowerShell from Electron without reading session logs.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

async function fixture() {
  const { app } = require('electron')
  const processes = require('node:child_process')
  const nativeSpawn = processes.spawn
  const nativeExecFile = processes.execFile
  let residents = 0, fallbacks = 0
  processes.spawn = (exe, args, options) => {
    if (exe === 'powershell.exe') {
      residents++
      assert.equal(options.windowsHide, true)
    }
    return nativeSpawn(exe, args, options)
  }
  processes.execFile = (exe, ...args) => {
    if (exe === 'powershell.exe') fallbacks++
    return nativeExecFile(exe, ...args)
  }
  const { listProcessSnapshot, stopProcessQueries } = require(path.join(process.env.CUTE_ISLAND_QUERY_SMOKE, 'processes.cjs'))
  await app.whenReady()
  try {
    for (let round = 0; round < 2; round++) {
      for (let scan = 0; scan < 3; scan++) {
        const snapshot = await listProcessSnapshot()
        assert.ok(snapshot.processes.some(row => row.pid === process.pid), 'A live snapshot is returned')
        assert.equal(residents, round + 1, 'Repeated scans reuse the resident shell')
        assert.equal(fallbacks, 0, 'No one-shot fallback console is allocated')
      }
      stopProcessQueries()
    }
    console.log(JSON.stringify({ result: 'passed', scans: 6, residents, fallbacks, restart: true }))
  } finally { stopProcessQueries(); app.quit() }
}

async function smoke() {
  if (process.platform !== 'win32') { console.log('此冒烟仅适用于 Windows'); return }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'island-process-smoke-'))
  let child
  try {
    await require('esbuild').build({ entryPoints: ['src/agents/processes.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temporary, 'processes.cjs') })
    const env = { ...process.env, CUTE_ISLAND_QUERY_SMOKE: temporary }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), [__filename, `--user-data-dir=${path.join(temporary, 'profile')}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    const timeout = setTimeout(() => child.kill(), 30000)
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    try {
      const [code] = await once(child, 'exit')
      assert.equal(code, 0, 'Electron process query fixture succeeds')
      assert.match(output, /"result":"passed"/)
      console.log(output.trim())
    } finally { clearTimeout(timeout) }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temporary).startsWith('island-process-smoke-'))
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

(process.versions.electron ? fixture() : smoke()).catch(error => { console.error(error); process.exitCode = 1 })
