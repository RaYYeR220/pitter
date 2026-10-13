import { indexer } from 'envio'
import { loadCell, loadPool } from '../entities'

indexer.onEvent({ contract: 'WeatherIndex', event: 'WeatherReported' }, async ({ event, context }) => {
  const { key, cumulative } = event.params
  const from = Number(event.params.from)
  const to = Number(event.params.to)
  const wetSeconds = Number(event.params.wetSeconds)
  const now = event.block.timestamp

  const [pool, cell] = await Promise.all([loadPool(context), loadCell(context, key)])

  context.WeatherReading.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    cell_id: cell.id,
    key,
    from,
    to,
    wetSeconds,
    cumulative,
    txHash: event.transaction.hash,
    timestamp: now,
  })

  context.Cell.set({
    ...cell,
    wetSeconds: cumulative,
    lastWetAt: wetSeconds > 0 ? to : cell.lastWetAt,
    lastReadingAt: to,
  })

  context.PoolState.set({ ...pool, readingCount: pool.readingCount + 1, updatedAt: now })
})

indexer.onEvent({ contract: 'WeatherIndex', event: 'Heartbeat' }, async ({ event, context }) => {
  const pool = await loadPool(context)
  context.PoolState.set({
    ...pool,
    lastHeartbeat: Number(event.params.timestamp),
    updatedAt: event.block.timestamp,
  })
})
