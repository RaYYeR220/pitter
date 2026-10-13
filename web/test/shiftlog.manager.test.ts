import { MeraError } from '@category-labs/mera'
import { toHex } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'
import { AccountManager, HOUR_MS } from '@/lib/account'
import {
  MAX_LOG_BYTES,
  SHIFT_LOG_BLOB,
  ShiftLogManager,
  ShiftLogStore,
  addPoint,
  addShift,
  decodeLog,
  deriveShiftLogKeys,
  editShift,
  emptyLog,
  encodeLog,
  fitLog,
  mergeLogs,
  newShift,
  removeShift,
  shiftLogSalt,
  type ShiftLog,
} from '@/lib/shiftlog'
import { fakeAuthenticator, manualClock, type FakeAuthenticator } from './support/passkeys'
import { TEST_CHAIN_ID, localService, type LocalService } from './support/service'

const point = (at: number, lat = 52.229771, lon = 21.011783) => ({ at, lat, lon, accuracy: 8 })

describe('the log itself', () => {
  it('survives a round trip through its stored form', () => {
    let log = addShift(emptyLog(), newShift('a', 1000, 'Tuesday lunch'))
    log = addPoint(log, 'a', point(1010))
    log = addPoint(log, 'a', { at: 1020, lat: -33.86882, lon: 151.20929 })
    log = editShift(log, 'a', { note: 'Tips were good, €14', endedAt: 5000 }, 5000)
    expect(decodeLog(encodeLog(log))).toEqual(log)
  })

  it('keeps names and notes within their limits', () => {
    let log = addShift(emptyLog(), newShift('a', 1000, 'x'.repeat(500)))
    log = editShift(log, 'a', { note: 'y'.repeat(5000) }, 1001)
    expect(log.shifts[0]!.label).toHaveLength(80)
    expect(log.shifts[0]!.note).toHaveLength(2000)
  })

  it('puts the newest shift first and removes on request', () => {
    let log = addShift(emptyLog(), newShift('a', 1000))
    log = addShift(log, newShift('b', 2000))
    expect(log.shifts.map((shift) => shift.id)).toEqual(['b', 'a'])
    expect(removeShift(log, 'b').shifts.map((shift) => shift.id)).toEqual(['a'])
  })

  it('refuses bytes that are not a log', () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    expect(() => decodeLog(new Uint8Array([0xff, 0xfe]))).toThrow('not readable')
    expect(() => decodeLog(encode({ v: 2, shifts: [] }))).toThrow('version 1')
    expect(() => decodeLog(encode({ v: 1, shifts: [{ id: 1 }] }))).toThrow('malformed')
    expect(() =>
      decodeLog(encode({ v: 1, shifts: [{ id: 'a', s: 1, e: null, l: '', n: '', u: 1, t: [[1, 'x', 2]] }] })),
    ).toThrow('route point')
  })

  it('merges two copies by entry, the later edit winning', () => {
    const base = addShift(addShift(emptyLog(), newShift('a', 1000, 'first')), newShift('b', 2000, 'second'))
    const here = addShift(editShift(base, 'a', { note: 'edited here' }, 3000), newShift('c', 4000, 'only here'))
    const there = addShift(editShift(base, 'a', { note: 'edited there' }, 3500), newShift('d', 3800, 'only there'))

    const merged = mergeLogs(here, there)
    expect(merged.shifts.map((shift) => shift.id)).toEqual(['c', 'd', 'b', 'a'])
    expect(merged.shifts.find((shift) => shift.id === 'a')!.note).toBe('edited there')
  })

  it('drops the oldest routes first when the log outgrows storage, and says so', () => {
    let log = emptyLog()
    for (const [id, startedAt] of [
      ['old', 1000],
      ['mid', 2000],
      ['new', 3000],
    ] as const) {
      log = addShift(log, newShift(id, startedAt, `shift ${id}`))
      for (let i = 0; i < 400; i++) log = addPoint(log, id, point(startedAt + i))
    }
    const full = encodeLog(log).length
    expect(fitLog(log, full)).toBe(log)

    const fitted = fitLog(log, Math.floor(full * 0.75))
    expect(fitted.trimmed).toBe(true)
    expect(fitted.shifts.map((shift) => [shift.id, shift.trail.length])).toEqual([
      ['new', 400],
      ['mid', 400],
      ['old', 0],
    ])
    expect(fitted.shifts.map((shift) => shift.label)).toEqual(['shift new', 'shift mid', 'shift old'])
    expect(encodeLog(fitted).length).toBeLessThanOrEqual(Math.floor(full * 0.75))
  })

  it('holds a long shift well within the storage limit', () => {
    let log = addShift(emptyLog(), newShift('a', 1000))
    for (let i = 0; i < 2000; i++) log = addPoint(log, 'a', point(1000 + i * 15, 52.2 + i / 1e5, 21 + i / 1e5))
    expect(encodeLog(log).length).toBeLessThan(MAX_LOG_BYTES / 2)
  })
})

describe('ShiftLogManager', () => {
  let clock: ReturnType<typeof manualClock>
  let local: LocalService
  let authenticator: FakeAuthenticator
  let credentialId: string

  const device = (passkeys = authenticator) => {
    let id = 0
    return new ShiftLogManager({
      passkeys,
      store: new ShiftLogStore({ transport: local.client, chainId: TEST_CHAIN_ID, now: clock.seconds }),
      now: clock.seconds,
      newId: () => `shift-${++id}-${clock.seconds()}`,
      platform: () => ({ secureContext: true, webAuthn: true }),
    })
  }

  beforeEach(async () => {
    clock = manualClock()
    local = await localService(clock.seconds)
    authenticator = fakeAuthenticator()
    credentialId = (await authenticator.create({ label: 'test' })).credential.credentialId
    authenticator.ceremonies.length = 0
  })

  it('unlocks with one ceremony on the shift log salt', async () => {
    const log = device()
    expect(log.getState()).toMatchObject({ status: 'locked', log: null, storageAddress: null })

    expect(await log.unlock()).toBe(true)
    expect(authenticator.ceremonies).toEqual([
      { kind: 'evaluate', credentialId, salt: toHex(shiftLogSalt()).slice(2), hinted: false },
    ])
    expect(log.getState()).toMatchObject({ status: 'unlocked', log: emptyLog(), sync: 'saved', savedAt: null })
    expect(log.getState().storageAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('prompts for the signed-in passkey when there is one', async () => {
    const log = new ShiftLogManager({
      passkeys: authenticator,
      store: new ShiftLogStore({ transport: local.client, chainId: TEST_CHAIN_ID, now: clock.seconds }),
      credential: () => ({ credentialId }),
    })
    await log.unlock()
    expect(authenticator.ceremonies.at(-1)).toMatchObject({ hinted: true })
  })

  it('stores ciphertext only, under an identity that is not the account', async () => {
    const account = new AccountManager({
      passkeys: authenticator,
      terms: async () => {
        throw new Error('unused')
      },
      policy: { lengthMs: HOUR_MS, idleMs: HOUR_MS, maxSpendPerHour: 1n },
    })
    await account.signIn()

    const log = device()
    await log.unlock()
    const id = log.startShift('Friday night, old town')!
    log.addPoint(id, { lat: 52.249771, lon: 21.012283, accuracy: 6 })
    log.editShift(id, { note: 'Earned 212 zloty' })
    expect(await log.save()).toBe(true)

    const put = local.requests.find((request) => request.method === 'PUT')!
    expect(put.path).toBe(`/api/blobs/${log.getState().storageAddress}/${SHIFT_LOG_BLOB}`)
    expect(log.getState().storageAddress).not.toBe(account.getState().address)

    const stored = Buffer.from(put.body!).toString('latin1')
    for (const secret of ['Friday', 'old town', '212 zloty', '52.249771', '21.012283']) {
      expect(stored).not.toContain(secret)
    }
    expect(stored.startsWith('PSL1')).toBe(true)
  })

  it('decrypts the same log on a second device from the passkey alone', async () => {
    const first = device()
    await first.unlock()
    const id = first.startShift('Tuesday lunch')!
    first.addPoint(id, { lat: 52.229771, lon: 21.011783 })
    first.editShift(id, { note: 'Rained from 13:10' })
    await first.save()
    const written = first.getState().log
    first.lock()

    const second = device()
    expect(second.getState().log).toBeNull()
    expect(await second.unlock()).toBe(true)
    expect(second.getState().log).toEqual(written)
    expect(second.getState().storageAddress).toBe(
      (await deriveShiftLogKeys((await authenticator.evaluate({ prfSalt: shiftLogSalt() })).prfOutput)).storage.address,
    )
  })

  it('opens nothing with another passkey', async () => {
    const mine = device()
    await mine.unlock()
    mine.startShift('mine')
    await mine.save()

    const other = fakeAuthenticator()
    await other.create({ label: 'someone else' })
    const theirs = device(other)
    await theirs.unlock()
    expect(theirs.getState().log).toEqual(emptyLog())
    expect(theirs.getState().storageAddress).not.toBe(mine.getState().storageAddress)
  })

  it('forgets the log and the keys when locked', async () => {
    const log = device()
    await log.unlock()
    log.startShift('to forget')
    log.lock()
    expect(log.getState()).toEqual({
      status: 'locked',
      log: null,
      storageAddress: null,
      sync: 'saved',
      savedAt: null,
      error: null,
      problem: null,
    })
    expect(log.startShift('ignored')).toBeNull()
    expect(await log.save()).toBe(false)
  })

  it('tracks whether storage has the current copy', async () => {
    const log = device()
    await log.unlock()
    const id = log.startShift('a')!
    expect(log.getState().sync).toBe('unsaved')

    clock.advance(5000)
    await log.save()
    expect(log.getState()).toMatchObject({ sync: 'saved', savedAt: clock.seconds() })

    log.endShift(id)
    expect(log.getState().sync).toBe('unsaved')
    expect(log.getState().log!.shifts[0]!.endedAt).toBe(clock.seconds())
  })

  it('saves twice in the same second without a rejected write', async () => {
    const log = device()
    await log.unlock()
    log.startShift('a')
    expect(await log.save()).toBe(true)
    log.startShift('b')
    expect(await log.save()).toBe(true)

    const again = device()
    await again.unlock()
    expect(again.getState().log!.shifts).toHaveLength(2)
  })

  it('keeps the log in memory when storage is down, and stores it once it is back', async () => {
    const log = device()
    await log.unlock()
    log.startShift('written offline')

    local.setOffline(true)
    expect(await log.save()).toBe(false)
    expect(log.getState()).toMatchObject({ status: 'unlocked', sync: 'failed' })
    expect(log.getState().log!.shifts[0]!.label).toBe('written offline')

    local.setOffline(false)
    expect(await log.save()).toBe(true)
    expect(log.getState().sync).toBe('saved')
  })

  it('stays locked when the stored log cannot be fetched, so nothing can overwrite it', async () => {
    const writer = device()
    await writer.unlock()
    writer.startShift('precious')
    await writer.save()

    local.setOffline(true)
    const reader = device()
    expect(await reader.unlock()).toBe(false)
    expect(reader.getState()).toMatchObject({ status: 'locked', log: null, error: 'load_failed' })
    expect(await reader.save()).toBe(false)

    local.setOffline(false)
    expect(await reader.unlock()).toBe(true)
    expect(reader.getState().log!.shifts[0]!.label).toBe('precious')
  })

  it('reports a stored log that cannot be opened', async () => {
    const keys = await deriveShiftLogKeys((await authenticator.evaluate({ prfSalt: shiftLogSalt() })).prfOutput)
    const garbage = new Uint8Array(64).fill(7)
    const store = new ShiftLogStore({ transport: local.client, chainId: TEST_CHAIN_ID, now: clock.seconds })
    const real = await store.save(keys, emptyLog(), null)
    const transport = {
      getBlob: async () => ({ bytes: garbage, issuedAt: real.storedAt }),
      putBlob: local.client.putBlob,
    }
    const log = new ShiftLogManager({
      passkeys: authenticator,
      store: new ShiftLogStore({ transport, chainId: TEST_CHAIN_ID, now: clock.seconds }),
    })
    expect(await log.unlock()).toBe(false)
    expect(log.getState()).toMatchObject({ status: 'locked', error: 'cannot_open' })
  })

  it('merges with a copy another device stored in the meantime', async () => {
    const phone = device()
    const tablet = device()
    await phone.unlock()
    await tablet.unlock()

    phone.startShift('from the phone')
    clock.advance(2000)
    await phone.save()

    clock.advance(2000)
    tablet.startShift('from the tablet')
    clock.set((phone.getState().savedAt! - 100) * 1000)
    expect(await tablet.save()).toBe(true)

    const labels = (log: ShiftLog | null) => log!.shifts.map((shift) => shift.label).sort()
    expect(labels(tablet.getState().log)).toEqual(['from the phone', 'from the tablet'])

    const fresh = device()
    await fresh.unlock()
    expect(labels(fresh.getState().log)).toEqual(['from the phone', 'from the tablet'])
  })

  it('reports a closed prompt and stays locked', async () => {
    const log = device()
    authenticator.failNext(new MeraError('PASSKEY_OPERATION_FAILED', 'cancelled'))
    expect(await log.unlock()).toBe(false)
    expect(log.getState()).toMatchObject({ status: 'locked', log: null })
    expect(log.getState().problem?.code).toBe('cancelled')
  })

  it('reports a device without PRF', async () => {
    const log = device()
    authenticator.failNext(new MeraError('PRF_UNAVAILABLE', 'no PRF'))
    await log.unlock()
    expect(log.getState().problem).toMatchObject({ code: 'prf_unavailable', suggestPhone: true })
  })

  it('notifies subscribers', async () => {
    const log = device()
    const seen: string[] = []
    log.subscribe(() => seen.push(log.getState().status))
    await log.unlock()
    log.lock()
    expect(seen).toEqual(['unlocking', 'unlocked', 'locked'])
  })
})

describe('the blob store', () => {
  it('refuses a read or a write signed by anyone but the owner', async () => {
    const clock = manualClock()
    const local = await localService(clock.seconds)
    const authenticator = fakeAuthenticator()
    await authenticator.create({ label: 'owner' })
    const owner = await deriveShiftLogKeys((await authenticator.evaluate({ prfSalt: shiftLogSalt() })).prfOutput)
    const stranger = await deriveShiftLogKeys(new Uint8Array(32).fill(9))
    const store = new ShiftLogStore({ transport: local.client, chainId: TEST_CHAIN_ID, now: clock.seconds })
    await store.save(owner, addShift(emptyLog(), newShift('a', 1, 'secret')), null)

    const forged = { ...stranger, storage: { ...stranger.storage, address: owner.storage.address } }
    await expect(store.load(forged)).rejects.toMatchObject({ status: 403, code: 'not_owner' })
    await expect(store.save(forged, emptyLog(), clock.seconds())).rejects.toMatchObject({ status: 403 })

    const { log } = await store.load(owner)
    expect(log.shifts[0]!.label).toBe('secret')
  })
})
