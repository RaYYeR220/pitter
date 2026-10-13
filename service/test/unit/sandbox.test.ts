import { testDollarAbi } from '@cover/core/abi'
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import { SANDBOX_SECRET_HEADER, sandboxHandlers } from '../../src/sandbox/handlers'
import { readStorm } from '../../src/sandbox/storm'
import { T0 } from '../helpers/fakes'
import { body, get, harness, post, type Harness } from '../helpers/harness'

const SIMULATOR = (1n << 64n) | (1800n << 32n) | 3600n
const recipient = privateKeyToAddress(generatePrivateKey())
const sandboxEnv = {
  SANDBOX_ENABLED: 'true',
  SANDBOX_SECRET: 'sandbox-secret-for-tests-01234567',
  SANDBOX_SIMULATOR_KEY: SIMULATOR.toString(),
}

describe('sandbox', () => {
  let h: Harness
  let handlers: ReturnType<typeof sandboxHandlers>
  let secret: Record<string, string>

  function start(env: Record<string, string | undefined> = sandboxEnv) {
    h = harness(env)
    handlers = sandboxHandlers(h.context)
    secret = { [SANDBOX_SECRET_HEADER]: sandboxEnv.SANDBOX_SECRET }
  }

  const drip = (headers = secret, payload: unknown = { address: recipient }) =>
    h.guarded(handlers.drip)(post('/sandbox/drip', payload, headers))
  const storm = (payload: unknown, headers = secret) =>
    h.guarded(handlers.storm)(post('/sandbox/storm', payload, headers))

  beforeEach(() => start())

  describe('when it is not enabled', () => {
    beforeEach(() => start({}))

    it('refuses the faucet and the switch, with or without a secret', async () => {
      for (const response of [
        await drip(),
        await drip({}),
        await storm({ wet: true }),
        await storm({ wet: true }, {}),
      ]) {
        expect(response.status).toBe(403)
        expect((await body(response)).error.code).toBe('sandbox_unavailable')
      }
      expect(h.rpc.simulated).toHaveLength(0)
      expect((await readStorm(h.stores.state)).wet).toBe(false)
    })
  })

  it('refuses to run on chain 143 even if it were switched on', async () => {
    h.settings.chainId = 143

    expect((await drip()).status).toBe(403)
    expect((await storm({ wet: true })).status).toBe(403)
    expect(h.rpc.simulated).toHaveLength(0)
    expect(h.rpc.sent).toHaveLength(0)
  })

  it('requires the sandbox secret', async () => {
    expect((await drip({})).status).toBe(401)
    expect((await drip({ [SANDBOX_SECRET_HEADER]: 'wrong-secret-wrong-secret-wrong' })).status).toBe(401)
    expect((await drip({ [SANDBOX_SECRET_HEADER]: h.secrets.cronSecret! })).status).toBe(401)
    expect((await storm({ wet: true }, {})).status).toBe(401)
    expect(h.rpc.simulated).toHaveLength(0)
  })

  describe('drip', () => {
    it('mints test dollars to the address through the relayer', async () => {
      h.rpc.logs = [
        {
          address: h.settings.contracts.token,
          topics: encodeEventTopics({ abi: testDollarAbi, eventName: 'Dripped', args: { to: recipient } }) as Hex[],
          data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000_000n]),
        },
      ]

      const response = await drip()
      const result = await body(response)

      expect(response.status).toBe(200)
      expect(result).toMatchObject({ address: recipient, amount: '1000000000', simulated: true })
      const call = h.rpc.simulated[0]!
      expect(call.to).toBe(h.settings.contracts.token)
      expect(decodeFunctionData({ abi: testDollarAbi, data: call.data })).toMatchObject({
        functionName: 'drip',
        args: [recipient],
      })
    })

    it('says when an address has already been served today', async () => {
      h.rpc.revertWith = encodeErrorResult({
        abi: testDollarAbi,
        errorName: 'DripLimited',
        args: [recipient, BigInt(T0 + 3_600)],
      })

      const response = await drip()
      const { error } = await body(response)

      expect(response.status).toBe(429)
      expect(error.code).toBe('drip_limited')
      expect(error.details.availableAt).toBe(T0 + 3_600)
      expect(h.rpc.sent).toHaveLength(0)
    })

    it('validates the address', async () => {
      expect((await drip(secret, { address: '0x12' })).status).toBe(400)
      expect((await drip(secret, { address: '0x0000000000000000000000000000000000000000' })).status).toBe(400)
      expect((await drip(secret, {})).status).toBe(400)
    })

    it('is limited per IP', async () => {
      start({ ...sandboxEnv, RATE_SANDBOX_PER_IP: '2' })

      expect((await drip()).status).toBe(200)
      expect((await drip({})).status).toBe(401)
      expect((await drip()).status).toBe(429)
    })
  })

  describe('storm switch', () => {
    it('turns the simulator cell wet and dry', async () => {
      const on = await body(await storm({ wet: true }))
      h.clock.time += 90
      const off = await body(await storm({ wet: false }))

      expect(on).toEqual({ simulatorKey: SIMULATOR.toString(), wet: true, since: T0, simulated: true })
      expect(off).toEqual({ simulatorKey: SIMULATOR.toString(), wet: false, since: T0 + 90, simulated: true })
    })

    it('reports its position', async () => {
      await storm({ wet: true })

      const response = await h.guarded(handlers.storm)(get('/sandbox/storm', secret))

      expect(await body(response)).toMatchObject({ wet: true, since: T0 })
    })

    it('starts dry', async () => {
      const response = await h.guarded(handlers.storm)(get('/sandbox/storm', secret))

      expect(await body(response)).toMatchObject({ wet: false, since: null })
    })

    it('only takes a boolean', async () => {
      expect((await storm({ wet: 'yes' })).status).toBe(400)
      expect((await storm({ wet: true, key: '1' })).status).toBe(400)
    })
  })
})
