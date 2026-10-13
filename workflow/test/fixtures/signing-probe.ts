import { buildReport, keyFromLatLon, reportDomain, sealReports } from '@cover/core'

/** Builds, signs and encodes a full report of twenty readings from fixed inputs. */
export function sealProbe(): { digest: string; signature: string; payload: string } {
  const keys = Array.from({ length: 20 }, (_, i) => keyFromLatLon(50.025 + 0.05 * i, 19.025))
  const verdicts = new Map(keys.map((key, i) => [key, i % 3 === 0 ? ('wet' as const) : ('dry' as const)]))
  const { reports } = buildReport(keys, new Map(), 1791874657, { observations: verdicts })
  const [sealed] = sealReports(reports, `0x${'00'.repeat(31)}01`, reportDomain(10143, '0x5FbDB2315678afecb367f032d93F642f64180aa3'))
  if (!sealed) throw new Error('no report')
  return { digest: sealed.digest, signature: sealed.signature, payload: sealed.payload }
}
