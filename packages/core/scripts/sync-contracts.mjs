// Copies the contract ABIs from the Foundry build output into src/abi as typed constants, and the deployed
// addresses from contracts/deployments into src/deployments. Run it after `forge build` or a deployment:
//   pnpm --filter @cover/core sync:contracts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const contractsDir = join(here, '..', '..', '..', 'contracts')
const abiDir = join(here, '..', 'src', 'abi')
const deploymentsDir = join(here, '..', 'src', 'deployments')

const CONTRACTS = ['CoverBook', 'CoverPool', 'WeatherIndex', 'TestDollar']
const CHAIN_IDS = [143, 10143]
const ADDRESS_FIELDS = ['token', 'weatherIndex', 'coverPool', 'coverBook', 'reporter', 'underwriter', 'treasury']
const EMPTY_DEPLOYMENT = {
  startBlock: 0,
  token: '',
  testDollar: false,
  weatherIndex: '',
  coverPool: '',
  coverBook: '',
  reporter: '',
  underwriter: '',
  treasury: '',
  forwarders: [],
}

const camel = (name) => name.charAt(0).toLowerCase() + name.slice(1)

mkdirSync(abiDir, { recursive: true })
for (const name of CONTRACTS) {
  const artifactPath = join(contractsDir, 'out', `${name}.sol`, `${name}.json`)
  if (!existsSync(artifactPath)) {
    throw new Error(`${artifactPath} is missing: run \`forge build\` in contracts/ first`)
  }
  const { abi } = JSON.parse(readFileSync(artifactPath, 'utf8'))
  const source = `export const ${camel(name)}Abi = ${JSON.stringify(abi, null, 2)} as const\n`
  writeFileSync(join(abiDir, `${name}.ts`), source)
  console.log(`abi/${name}.ts  ${abi.length} entries`)
}

mkdirSync(deploymentsDir, { recursive: true })
for (const chainId of CHAIN_IDS) {
  const target = join(deploymentsDir, `${chainId}.json`)
  const source = join(contractsDir, 'deployments', `${chainId}.json`)
  if (!existsSync(source)) {
    if (!existsSync(target)) {
      writeFileSync(target, `${JSON.stringify({ chainId, ...EMPTY_DEPLOYMENT }, null, 2)}\n`)
      console.log(`deployments/${chainId}.json  empty (not deployed)`)
    }
    continue
  }
  const deployed = JSON.parse(readFileSync(source, 'utf8'))
  const record = { chainId, ...EMPTY_DEPLOYMENT }
  record.startBlock = Number(deployed.startBlock ?? 0)
  record.testDollar = Boolean(deployed.testDollar)
  record.forwarders = deployed.forwarders ?? []
  for (const field of ADDRESS_FIELDS) record[field] = deployed[field] ?? ''
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`deployments/${chainId}.json  ${record.coverBook}`)
}
