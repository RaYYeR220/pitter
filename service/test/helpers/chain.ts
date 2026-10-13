import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Address, Hex } from 'viem'

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts')
const EXE = process.platform === 'win32' ? '.exe' : ''

function installed(tool: string): string[] {
  const foundry = join(homedir(), '.foundry')
  const versions = join(foundry, 'versions')
  const perVersion = existsSync(versions)
    ? readdirSync(versions)
        .sort()
        .reverse()
        .map((version) => join(versions, version, tool + EXE))
    : []
  return [tool, join(foundry, 'bin', tool + EXE), ...perVersion]
}

/** An `anvil` that knows the Monad network family, which arrived in Foundry 1.8. */
export function findAnvil(): string {
  const candidates = [process.env.ANVIL_BIN, ...installed('anvil')].filter((path): path is string => Boolean(path))
  for (const candidate of candidates) {
    const help = spawnSync(candidate, ['--help'], { encoding: 'utf8' })
    if (help.status === 0 && /possible values:[^\]]*\bmonad\b/.test(help.stdout)) return candidate
  }
  throw new Error('No anvil with the Monad network family was found. Install Foundry 1.8 or newer, or set ANVIL_BIN.')
}

function findForge(): string {
  const candidates = [process.env.FORGE_BIN, ...installed('forge')].filter((path): path is string => Boolean(path))
  for (const candidate of candidates) {
    if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate
  }
  throw new Error('forge was not found. Install Foundry, or set FORGE_BIN.')
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (address && typeof address === 'object' ? done(address.port) : fail(new Error('no port'))))
    })
  })
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const payload = (await response.json()) as { result?: unknown; error?: { message: string } }
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`)
  return payload.result
}

export interface LocalChain {
  url: string
  stop(): void
  setBalance(address: Address, wei: bigint): Promise<void>
  /** Mines one block at exactly `timestamp`. */
  mineAt(timestamp: number): Promise<void>
  time(): Promise<number>
}

/** Starts a throwaway local chain that follows the Monad gas rules, on a port of its own. */
export async function startChain(): Promise<LocalChain> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const child: ChildProcess = spawn(
    findAnvil(),
    ['--network', 'monad', '--host', '127.0.0.1', '--port', String(port), '--silent'],
    { stdio: 'ignore' },
  )

  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      await rpc(url, 'eth_chainId')
      break
    } catch (error) {
      if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`)
      if (Date.now() > deadline) {
        child.kill()
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  return {
    url,
    stop: () => void child.kill(),
    setBalance: async (address, wei) => void (await rpc(url, 'anvil_setBalance', [address, `0x${wei.toString(16)}`])),
    mineAt: async (timestamp) => {
      await rpc(url, 'evm_setNextBlockTimestamp', [timestamp])
      await rpc(url, 'evm_mine')
    },
    time: async () =>
      Number(((await rpc(url, 'eth_getBlockByNumber', ['latest', false])) as { timestamp: Hex }).timestamp),
  }
}

/** Settings of the deploy script that must come from its defaults, whatever the shell has set. */
const OPTIONAL_DEPLOY_VARIABLES = [
  'TOKEN',
  'OWNER',
  'FORWARDERS',
  'MAX_POLICY_PAYOUT',
  'MIN_PREMIUM',
  'SERVED_ONLY',
  'SERVED_KEYS',
  'REDEEM_NOTICE',
  'MAX_HORIZON',
  'SHARE_NAME',
  'SHARE_SYMBOL',
]

export interface Deployment {
  token: Address
  weatherIndex: Address
  coverPool: Address
  coverBook: Address
}

/**
 * Deploys the contracts with the project's Foundry script, the test dollar included. The script records the
 * addresses in the contracts folder; that record is read and the folder is left as it was found.
 */
export function deployContracts(
  chain: LocalChain,
  deployerKey: Hex,
  roles: { reporter: Address; underwriter: Address; treasury: Address },
): Deployment {
  const folder = join(CONTRACTS, 'deployments')
  const record = join(folder, '31337.json')
  const folderExisted = existsSync(folder)
  const previous = existsSync(record) ? readFileSync(record) : null

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REPORTER: roles.reporter,
    UNDERWRITER: roles.underwriter,
    TREASURY: roles.treasury,
    MIN_LEAD: '0',
  }
  for (const name of OPTIONAL_DEPLOY_VARIABLES) delete env[name]

  try {
    const run = spawnSync(
      findForge(),
      ['script', 'script/Deploy.s.sol', '--rpc-url', chain.url, '--broadcast', '--private-key', deployerKey],
      {
        cwd: CONTRACTS,
        encoding: 'utf8',
        env,
      },
    )
    if (run.status !== 0 || !existsSync(record)) {
      throw new Error(`The deploy script failed:\n${run.stdout?.slice(-2_000)}\n${run.stderr?.slice(-2_000)}`)
    }
    const deployment = JSON.parse(readFileSync(record, 'utf8')) as Deployment
    return {
      token: deployment.token,
      weatherIndex: deployment.weatherIndex,
      coverPool: deployment.coverPool,
      coverBook: deployment.coverBook,
    }
  } finally {
    if (previous) writeFileSync(record, previous)
    else rmSync(record, { force: true })
    if (!folderExisted && existsSync(folder) && readdirSync(folder).length === 0) rmSync(folder, { recursive: true })
  }
}
