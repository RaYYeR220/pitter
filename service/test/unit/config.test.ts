import { parseEther, parseGwei } from 'viem'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config'
import { validEnv } from '../helpers/env'

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('expected the configuration to be rejected')
}

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const { settings, secrets } = loadConfig(validEnv())

    expect(settings.chainId).toBe(10143)
    expect(settings.basePath).toBe('')
    expect(settings.quote).toEqual({
      ttlSeconds: 120,
      maxRatePerSecond: 10_000n,
      maxDurationSeconds: 43_200,
      minPremiumBps: 100,
    })
    expect(settings.relayer.maxFeePerGas).toBe(parseGwei('300'))
    expect(settings.relayer.maxPriorityFeePerGas).toBe(parseGwei('2'))
    expect(settings.relayer.minBalance).toBe(parseEther('1'))
    expect(settings.sandbox).toEqual({ enabled: false, simulatorKey: null })
    expect(settings.x402.enabled).toBe(false)
    expect(settings.x402.facilitatorUrl).toBe('https://x402-facilitator.molandak.org')
    expect(secrets.databaseUrl).toBeUndefined()
    expect(secrets.sandboxSecret).toBeUndefined()
  })

  it('keeps secrets out of the settings', () => {
    const env = validEnv({ DATABASE_URL: 'postgres://user:hunter2@db.example.test:5432/cover' })
    const { settings } = loadConfig(env)
    const printed = JSON.stringify(settings, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))

    for (const name of ['UNDERWRITER_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY', 'REPORTER_PRIVATE_KEY', 'CRON_SECRET']) {
      expect(printed).not.toContain(env[name]!.slice(2))
    }
    expect(printed).not.toContain('secret-api-key')
    expect(printed).not.toContain('hunter2')
  })

  it('names every missing variable', () => {
    const problems = problemsOf({})

    for (const name of [
      'CHAIN_ID',
      'RPC_URL',
      'TOKEN_ADDRESS',
      'COVER_BOOK_ADDRESS',
      'COVER_POOL_ADDRESS',
      'WEATHER_INDEX_ADDRESS',
      'UNDERWRITER_PRIVATE_KEY',
      'RELAYER_PRIVATE_KEY',
    ]) {
      expect(problems).toContain(`${name}: required`)
    }
  })

  it('treats blank values as unset', () => {
    expect(problemsOf(validEnv({ RPC_URL: '   ' }))).toContain('RPC_URL: required')
    expect(loadConfig(validEnv({ QUOTE_TTL_SECONDS: '' })).settings.quote.ttlSeconds).toBe(120)
  })

  it('never echoes a rejected value', () => {
    const key = '0xnot-a-key-but-still-private'
    const error = (() => {
      try {
        loadConfig(validEnv({ RELAYER_PRIVATE_KEY: key }))
      } catch (caught) {
        return caught as Error
      }
      throw new Error('expected a rejection')
    })()

    expect(error.message).toContain('RELAYER_PRIVATE_KEY')
    expect(error.message).not.toContain('still-private')
  })

  it('rejects malformed addresses and keys', () => {
    expect(problemsOf(validEnv({ TOKEN_ADDRESS: '0x1234' }))[0]).toMatch(/^TOKEN_ADDRESS: /)
    expect(problemsOf(validEnv({ UNDERWRITER_PRIVATE_KEY: '0x12' }))[0]).toMatch(/^UNDERWRITER_PRIVATE_KEY: /)
  })

  it('requires a separate key for each role', () => {
    const env = validEnv()
    env.RELAYER_PRIVATE_KEY = env.UNDERWRITER_PRIVATE_KEY

    expect(problemsOf(env)[0]).toMatch(/each role needs its own key/)
  })

  it('requires distinct contract addresses', () => {
    const env = validEnv()
    env.COVER_POOL_ADDRESS = env.COVER_BOOK_ADDRESS

    expect(problemsOf(env)[0]).toMatch(/must be distinct/)
  })

  it('rejects out-of-range numbers', () => {
    expect(problemsOf(validEnv({ QUOTE_TTL_SECONDS: '5' }))[0]).toMatch(/^QUOTE_TTL_SECONDS: /)
    expect(problemsOf(validEnv({ QUOTE_MAX_RATE_PER_SECOND: '0' }))[0]).toMatch(/^QUOTE_MAX_RATE_PER_SECOND: /)
    expect(problemsOf(validEnv({ KEEPER_SETTLE_BATCH: '11' }))[0]).toMatch(/^KEEPER_SETTLE_BATCH: /)
  })

  it('rejects a priority fee above the fee cap', () => {
    const problems = problemsOf(validEnv({ RELAYER_MAX_FEE_GWEI: '1', RELAYER_PRIORITY_FEE_GWEI: '2' }))

    expect(problems[0]).toMatch(/^RELAYER_PRIORITY_FEE_GWEI: /)
  })

  it('rejects short shared secrets', () => {
    expect(problemsOf(validEnv({ CRON_SECRET: 'short' }))[0]).toMatch(/^CRON_SECRET: /)
  })

  describe('sandbox', () => {
    const sandbox = {
      SANDBOX_ENABLED: 'true',
      SANDBOX_SECRET: 'sandbox-secret-for-tests-01234567',
      SANDBOX_SIMULATOR_KEY: '18446744073709551616',
    }

    it('is off unless enabled', () => {
      const { settings, secrets } = loadConfig(validEnv({ ...sandbox, SANDBOX_ENABLED: undefined }))

      expect(settings.sandbox).toEqual({ enabled: false, simulatorKey: null })
      expect(secrets.sandboxSecret).toBeUndefined()
    })

    it('needs a secret and a simulator cell', () => {
      const problems = problemsOf(validEnv({ SANDBOX_ENABLED: 'true' }))

      expect(problems).toContain('SANDBOX_SECRET: required when the sandbox is enabled')
      expect(problems).toContain('SANDBOX_SIMULATOR_KEY: required when the sandbox is enabled')
    })

    it('accepts a decimal or hex simulator key', () => {
      expect(loadConfig(validEnv(sandbox)).settings.sandbox.simulatorKey).toBe(1n << 64n)
      expect(
        loadConfig(validEnv({ ...sandbox, SANDBOX_SIMULATOR_KEY: '0x10000000000000000' })).settings.sandbox
          .simulatorKey,
      ).toBe(1n << 64n)
    })

    it('refuses to start on chain 143', () => {
      const problems = problemsOf(validEnv({ ...sandbox, CHAIN_ID: '143' }))

      expect(problems).toContain('SANDBOX_ENABLED: the sandbox cannot run on chain 143')
    })

    it('needs a secret different from the cron secret', () => {
      const env = validEnv(sandbox)
      env.SANDBOX_SECRET = env.CRON_SECRET

      expect(problemsOf(env)[0]).toMatch(/must differ/)
    })
  })
})
