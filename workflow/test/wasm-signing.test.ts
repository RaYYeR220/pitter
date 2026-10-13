import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { sealProbe } from './fixtures/signing-probe'

// The workflow signs its reports inside the QuickJS engine that Javy compiles into the WASM binary. This test
// compiles the signing path with the same Javy release the CRE toolchain uses and runs it in that engine.

const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const platform = `${process.platform}-${process.arch}`
const cached = home ? await Array.fromAsync(new Bun.Glob(`*/${platform}/javy*`).scan({ cwd: join(home, '.cache', 'javy'), absolute: true })).catch(() => []) : []
const javy = cached.sort().at(-1)
const node = Bun.which('node')
const available = javy !== undefined && node !== null
if (!available) console.warn('skipping the WASM signing test: it needs node and the Javy binary that `cre workflow build` downloads')

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

describe.skipIf(!available)('signing inside the workflow engine', () => {
  it('produces the same digest, signature and payload as outside it', async () => {
    const workDir = join(import.meta.dir, '.tmp')
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, 'fixtures', 'signing-probe.entry.ts')],
      outdir: workDir,
      target: 'browser',
      format: 'esm',
      naming: 'signing-probe.js',
    })
    expect(build.success).toBe(true)

    const wasm = join(workDir, 'signing-probe.wasm')
    await run([javy as string, 'build', join(workDir, 'signing-probe.js'), '-o', wasm])
    const output = await run([node as string, '--no-warnings', '-e', WASI_RUNNER, wasm])

    const line = output.split('\n').find((candidate) => candidate.startsWith('{'))
    expect(line).toBeDefined()
    const insideEngine = JSON.parse(line as string)
    const expected = sealProbe()
    expect(insideEngine).toEqual(expected)
    expect(expected.signature).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/)
  }, 120_000)
})
