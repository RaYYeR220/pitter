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
    <div className="page page--docs">
      <header className="docs-head">
        <h1 className="h-display">{copy.docs.heading}</h1>
        <p className="lede">{copy.docs.intro}</p>
        <p className={`mono docs-state${status?.paidCover.enabled ? '' : ' docs-state--off'}`}>
          <i className="check__mark" aria-hidden="true" />
          {status?.paidCover.enabled ? copy.docs.enabled : copy.docs.disabled}
        </p>
      </header>

      <section className="docs-sec" aria-labelledby="endpoint-h">
        <h2 className="h-section" id="endpoint-h">
          {copy.docs.endpointHeading}
        </h2>
        <p className="docs-endpoint">
          <code>POST {base}/api/v1/cover</code>
        </p>
        <p className="prose">{copy.docs.endpoint}</p>
        <pre className="code">
          <code>{`curl -i -X POST ${base}/api/v1/cover \\
  -H 'content-type: application/json' \\
  -d '${body}'`}</code>
        </pre>
        <div className="docs-split">
          <div>
            <h3 className="h-block">{copy.docs.fieldsHeading}</h3>
            <dl className="rows docs-fields">
              {Object.entries(fields).map(([name, text]) => (
                <div key={name} className="row">
                  <dt>
                    <code>{name}</code>
                  </dt>
                  <dd className="docs-fields__text">{text}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3 className="h-block">{copy.docs.stepsHeading}</h3>
            <ol className="docs-steps">
              {copy.docs.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <h3 className="h-block">{copy.docs.safeHeading}</h3>
            <p className="small">{copy.docs.safe}</p>
            <h3 className="h-block">{copy.docs.refusalsHeading}</h3>
            <p className="small">{copy.docs.refusals}</p>
          </div>
        </div>
      </section>

      <section className="docs-sec" aria-labelledby="quote-h">
        <h2 className="h-section" id="quote-h">
          {copy.docs.quoteHeading}
        </h2>
        <p className="prose">{copy.docs.quote}</p>
        <pre className="code">
          <code>{`curl '${base}/api/quote?lat=52.2297&lon=21.0122&start=${start}&end=${start + 3600}&rate=2000&holder=0x…'`}</code>
        </pre>
      </section>

      <section className="docs-sec" aria-labelledby="practice-h">
        <h2 className="h-section" id="practice-h">
          {copy.docs.practiceHeading}
        </h2>
        <p className="prose">{status?.practice.enabled ? copy.docs.practiceOn : copy.docs.practiceOff}</p>
        {status?.practice.simulator ? (
          <p className="mono">{copy.docs.simulatorArea(status.practice.simulator.lat, status.practice.simulator.lon)}</p>
        ) : null}
      </section>

      <section className="docs-sec" aria-labelledby="health-h">
        <h2 className="h-section" id="health-h">
          {copy.docs.healthHeading}
        </h2>
        <p className="prose">{copy.docs.health}</p>
        <pre className="code">
          <code>{`curl ${base}/api/health`}</code>
        </pre>
      </section>
    </div>
  )
}
