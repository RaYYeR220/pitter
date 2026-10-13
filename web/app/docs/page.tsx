import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { copy } from '@/lib/copy'
import type { HealthReport } from '@/lib/config'
import { health } from '@/lib/server/health'

export const metadata: Metadata = { title: copy.nav.docs }
export const dynamic = 'force-dynamic'

async function origin(): Promise<string> {
  const list = await headers()
  const host = list.get('x-forwarded-host') ?? list.get('host') ?? 'localhost:3000'
  const protocol = list.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${protocol}://${host}`
}

async function report(): Promise<HealthReport | null> {
  try {
    return await health()
  } catch {
    return null
  }
}

export default async function DocsPage() {
  const [base, status] = await Promise.all([origin(), report()])
  const start = Math.ceil(Date.now() / 60_000) * 60 + 600
  const body = JSON.stringify({
    lat: 52.2297,
    lon: 21.0122,
    start,
    end: start + 3600,
    rate: '2000',
    holder: '0x…the rider’s account number',
  })
  const fields = copy.docs.fields

  return (
    <>
      <section>
        <h1>{copy.docs.heading}</h1>
        <p>{copy.docs.intro}</p>
        <p className={status?.paidCover.enabled ? 'good' : 'warn'}>
          {status?.paidCover.enabled ? copy.docs.enabled : copy.docs.disabled}
        </p>
      </section>

      <section>
        <h2>{copy.docs.endpointHeading}</h2>
        <p>
          <code>POST {base}/api/v1/cover</code>
        </p>
        <p>{copy.docs.endpoint}</p>
        <pre>
          <code>{`curl -i -X POST ${base}/api/v1/cover \\
  -H 'content-type: application/json' \\
  -d '${body}'`}</code>
        </pre>
        <h3>{copy.docs.fieldsHeading}</h3>
        <dl>
          {Object.entries(fields).map(([name, text]) => (
            <div key={name} style={{ display: 'contents' }}>
              <dt>
                <code>{name}</code>
              </dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        <h3>{copy.docs.stepsHeading}</h3>
        <ol>
          {copy.docs.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <h3>{copy.docs.safeHeading}</h3>
        <p>{copy.docs.safe}</p>
        <h3>{copy.docs.refusalsHeading}</h3>
        <p>{copy.docs.refusals}</p>
      </section>

      <section>
        <h2>{copy.docs.quoteHeading}</h2>
        <p>{copy.docs.quote}</p>
        <pre>
          <code>{`curl '${base}/api/quote?lat=52.2297&lon=21.0122&start=${start}&end=${start + 3600}&rate=2000&holder=0x…'`}</code>
        </pre>
      </section>

      <section>
        <h2>{copy.docs.practiceHeading}</h2>
        <p>{status?.practice.enabled ? copy.docs.practiceOn : copy.docs.practiceOff}</p>
        {status?.practice.simulator ? (
          <p>{copy.docs.simulatorArea(status.practice.simulator.lat, status.practice.simulator.lon)}</p>
        ) : null}
      </section>

      <section>
        <h2>{copy.docs.healthHeading}</h2>
        <p>{copy.docs.health}</p>
        <pre>
          <code>{`curl ${base}/api/health`}</code>
        </pre>
      </section>
    </>
  )
}
