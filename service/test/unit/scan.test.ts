import { describe, expect, it } from 'vitest'
import { advanceCursor, cursorToJson, parseCursor, planScan, type ScanCursor } from '../../src/keeper/scan'

describe('scan cursor', () => {
  describe('parseCursor', () => {
    it('starts at the first policy when nothing is stored', () => {
      expect(parseCursor(null)).toEqual({ low: 1n, next: 1n })
    })

    it('reads what it stores', () => {
      const cursor = { low: 12n, next: 40n }

      expect(parseCursor(cursorToJson(cursor))).toEqual(cursor)
    })

    it('reads a bare id as the low mark', () => {
      expect(parseCursor('7')).toEqual({ low: 7n, next: 7n })
    })

    it('never starts below the low mark', () => {
      expect(parseCursor({ low: '9', next: '3' })).toEqual({ low: 9n, next: 9n })
    })

    it.each([['0'], ['-1'], ['abc'], [{ low: 'x' }], [[1, 2]], [42], [{ next: '5' }]])(
      'starts over on %j',
      (stored) => {
        expect(parseCursor(stored)).toEqual({ low: 1n, next: 1n })
      },
    )
  })

  describe('planScan', () => {
    it('reads at most the limit from where it left off', () => {
      expect(planScan({ low: 1n, next: 4n }, 20n, 3)).toEqual({ from: 4n, to: 6n })
    })

    it('stops at the last policy', () => {
      expect(planScan({ low: 1n, next: 19n }, 20n, 5)).toEqual({ from: 19n, to: 20n })
    })

    it('starts again from the low mark when it has run past the end', () => {
      expect(planScan({ low: 3n, next: 25n }, 20n, 5)).toEqual({ from: 3n, to: 7n })
    })

    it('reads nothing when every policy is known to be closed', () => {
      expect(planScan({ low: 21n, next: 21n }, 20n, 5)).toBeNull()
      expect(planScan({ low: 1n, next: 1n }, 0n, 5)).toBeNull()
    })
  })

  describe('advanceCursor', () => {
    it('moves the low mark to the first open policy when the read started there', () => {
      expect(advanceCursor({ low: 1n, next: 1n }, { from: 1n, to: 3n }, 2n, 10n)).toEqual({ low: 2n, next: 4n })
    })

    it('moves the low mark past a stretch that is all closed', () => {
      expect(advanceCursor({ low: 1n, next: 1n }, { from: 1n, to: 3n }, null, 10n)).toEqual({ low: 4n, next: 4n })
    })

    it('keeps the low mark when the read started above it', () => {
      expect(advanceCursor({ low: 1n, next: 4n }, { from: 4n, to: 6n }, null, 10n)).toEqual({ low: 1n, next: 7n })
    })

    it('wraps to the low mark at the end of the book', () => {
      expect(advanceCursor({ low: 2n, next: 8n }, { from: 8n, to: 10n }, 9n, 10n)).toEqual({ low: 2n, next: 2n })
    })
  })

  it('reaches every open policy within one pass, however long the oldest stays open', () => {
    const count = 1_000n
    const limit = 37
    const open = new Set<bigint>([1n, 2n, 250n, 251n, 777n, 999n, 1_000n])
    let cursor: ScanCursor = { low: 1n, next: 1n }
    const lastSeen = new Map<bigint, number>()
    const pass = Math.ceil(Number(count) / limit)

    for (let tick = 1; tick <= 4 * pass; tick++) {
      const scan = planScan(cursor, count, limit)!
      let firstOpen: bigint | null = null
      for (let id = scan.from; id <= scan.to; id++) {
        if (open.has(id)) {
          firstOpen ??= id
          lastSeen.set(id, tick)
        }
      }
      cursor = advanceCursor(cursor, scan, firstOpen, count)
      for (const id of open) {
        if (tick > pass) expect(tick - (lastSeen.get(id) ?? 0), `policy ${id}`).toBeLessThanOrEqual(pass)
      }
    }
    expect(cursor.low).toBe(1n)
  })
})
