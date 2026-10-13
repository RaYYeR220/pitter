import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { judgeProbe, sealProbe } from './fixtures/engine-probe'

// The workflow reads its sources and signs its reports inside the QuickJS engine that Javy compiles into the
// WASM binary. This test compiles both paths with the same Javy release the CRE toolchain uses and runs them in
// that engine.

const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const platform = `${process.platform}-${process.arch}`
const cached = home ? await Array.fromAsync(new Bun.Glob(`*/${platform}/javy*`).scan({ cwd: join(home, '.cache', 'javy'), absolute: true })).catch(() => []) : []
const javy = cached.sort().at(-1)
const node = Bun.which('node')
const available = javy !== undefined && node !== null
if (!available) console.warn('skipping the WASM engine test: it needs node and the Javy binary that `cre workflow build` downloads')

const WASI_RUNNER = `
  const { readFileSync } = require('node:fs')
  const { WASI } = require('node:wasi')
  const wasi = new WASI({ version: 'preview1', args: [], env: {} })
  WebAssembly.instantiate(readFileSync(process.argv[1]), wasi.getImportObject()).then(({ instance }) => wasi.start(instance))
`

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`${command[0]} exited with ${exitCode}: ${stderr || stdout}`)
  return stdout + stderr
}

describe.skipIf(!available)('inside the workflow engine', () => {
  it('judges the recorded sources and signs a report exactly as outside it', async () => {
    const workDir = join(import.meta.dir, '.tmp')
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, 'fixtures', 'engine-probe.entry.ts')],
      outdir: workDir,
      target: 'browser',
      format: 'esm',
      naming: 'engine-probe.js',
    })
    expect(build.success).toBe(true)

    const wasm = join(workDir, 'engine-probe.wasm')
    await run([javy as string, 'build', join(workDir, 'engine-probe.js'), '-o', wasm])
    const output = await run([node as string, '--no-warnings', '-e', WASI_RUNNER, wasm])

    const line = output.split('\n').find((candidate) => candidate.startsWith('{'))
    expect(line).toBeDefined()
    const insideEngine = JSON.parse(line as string)
    const sealed = sealProbe()
    const judged = judgeProbe()
    expect(insideEngine).toEqual({ sealed, judged })
    expect(sealed.signature).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/)
    expect(judged.requests).toBe(15)
    expect(judged.verdicts).toMatch(/^[wd]{37}$/)
    expect(judged.verdicts.startsWith('dww')).toBe(true)
  }, 120_000)
})
