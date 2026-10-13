import { copy } from '@/lib/copy'
import { EXAMPLE, EXAMPLE_TIMES, formatExact } from './example'

/**
 * The evening of the worked example: rain against the 1 mm line, the minutes above it that paid, the parts of
 * the payout at each weather check, and the cover underneath. One series in ink; the accent marks only the
 * line and the minutes that paid.
 */

const WIDTH = 1040
const X0 = 0
const X1 = 960
const BASE = 420
const PER_MM = 120
const THRESHOLD = BASE - PER_MM

const x = (minutes: number) => X0 + ((minutes - EXAMPLE_TIMES.start) / (EXAMPLE_TIMES.end - EXAMPLE_TIMES.start)) * (X1 - X0)
const y = (mm: number) => BASE - mm * PER_MM

/** Made-up rain, millimetres an hour, at minutes after midnight. */
const RAIN: Array<[number, number]> = [
  [16 * 60, 0],
  [18 * 60, 0],
  [18 * 60 + 10, 0.05],
  [18 * 60 + 20, 0.22],
  [18 * 60 + 30, 0.5],
  [18 * 60 + 36, 0.78],
  [18 * 60 + 41, 1],
  [18 * 60 + 45, 1.35],
  [18 * 60 + 48, 1.7],
  [18 * 60 + 52, 2.2],
  [18 * 60 + 56, 1.75],
  [19 * 60, 1.3],
  [19 * 60 + 4, 1],
  [19 * 60 + 10, 0.62],
  [19 * 60 + 20, 0.3],
  [19 * 60 + 32, 0.1],
  [19 * 60 + 45, 0],
  [22 * 60, 0],
]

function rainAt(minutes: number): number {
  for (let i = 1; i < RAIN.length; i++) {
    const [t1, v1] = RAIN[i]!
    const [t0, v0] = RAIN[i - 1]!
    if (minutes <= t1) return v0 + ((v1 - v0) * (minutes - t0)) / (t1 - t0)
  }
  return 0
}

const clock = (minutes: number) =>
  `${Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`

export function ExampleChart() {
  const words = copy.story.worked
  const hatch: number[] = []
  for (let m = EXAMPLE_TIMES.rain + 0.25; m < EXAMPLE_TIMES.dry; m += 0.5) hatch.push(m)
  const hours = [16, 17, 18, 19, 20, 21, 22]
  const blockWidth = x(EXAMPLE_TIMES.start + EXAMPLE.blockMinutes) - x(EXAMPLE_TIMES.start)

  return (
    <svg
      className="plot__svg"
      viewBox={`0 104 ${WIDTH} 418`}
      width={WIDTH}
      height={418}
      role="img"
      aria-labelledby="example-title example-desc"
    >
      <title id="example-title">{words.chartTitle}</title>
      <desc id="example-desc">{words.chartDesc(EXAMPLE.wetMinutes, EXAMPLE.parts.length)}</desc>

      <line className="plot__axis" x1={X0} x2={X1} y1={BASE + 0.5} y2={BASE + 0.5} />
      {hours.map((hour) => {
        const at = x(hour * 60)
        return (
          <g key={hour}>
            <line className="plot__axis" x1={at + 0.5} x2={at + 0.5} y1={BASE} y2={BASE + 8} />
            <text x={at} y={442} textAnchor={hour === 22 ? 'end' : hour === 16 ? 'start' : 'middle'}>
              {clock(hour * 60)}
            </text>
          </g>
        )
      })}

      <g className="plot__paid">
        {hatch.map((m) => (
          <line key={m} x1={x(m)} x2={x(m)} y1={THRESHOLD} y2={y(rainAt(m))} />
        ))}
      </g>
      <line className="plot__threshold" x1={0} x2={WIDTH} y1={THRESHOLD + 0.5} y2={THRESHOLD + 0.5} />
      <text className="plot__label" x={0} y={THRESHOLD - 14}>
        {words.line}
      </text>

      <polyline className="plot__trace" points={RAIN.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />

      {EXAMPLE.parts.map((part) => (
        <circle key={part.at} className="plot__part" cx={x(part.at)} cy={THRESHOLD + 0.5} r={4} />
      ))}

      <g className="plot__blocks">
        {Array.from({ length: EXAMPLE.payBlocks }, (_, i) => (
          <rect key={i} x={x(EXAMPLE_TIMES.start) + i * blockWidth + 1} y={462} width={blockWidth - 2} height={6} />
        ))}
      </g>
      <rect className="plot__lock" x={x(EXAMPLE_TIMES.lock) + 1} y={462} width={x(EXAMPLE_TIMES.end) - x(EXAMPLE_TIMES.lock) - 1} height={6} />
      <text className="plot__label" x={x(EXAMPLE_TIMES.start) + 1} y={492}>
        {words.blocks(EXAMPLE.payBlocks, formatExact(EXAMPLE.payAsYouGo))}
      </text>
      <text className="plot__label" x={x(EXAMPLE_TIMES.lock) + 1} y={514}>
        {words.locked(formatExact(EXAMPLE.locked))}
      </text>

      <line className="plot__lead" x1={x(EXAMPLE_TIMES.start) + 0.5} x2={x(EXAMPLE_TIMES.start) + 0.5} y1={318} y2={468} />
      <text className="plot__label" x={x(EXAMPLE_TIMES.start) + 9} y={332}>
        <tspan className="plot__t">{clock(EXAMPLE_TIMES.start)}</tspan> {words.on}
      </text>
      <line className="plot__lead" x1={x(EXAMPLE_TIMES.lock) + 0.5} x2={x(EXAMPLE_TIMES.lock) + 0.5} y1={346} y2={468} />
      <text className="plot__label" x={x(EXAMPLE_TIMES.lock) + 9} y={360}>
        <tspan className="plot__t">{clock(EXAMPLE_TIMES.lock)}</tspan> {words.lock}
      </text>

      <line className="plot__lead" x1={x(EXAMPLE_TIMES.rain) + 0.5} x2={x(EXAMPLE_TIMES.rain) + 0.5} y1={172} y2={THRESHOLD} />
      <text className="plot__label" x={x(EXAMPLE_TIMES.rain) - 10} y={186} textAnchor="end">
        <tspan className="plot__t">{clock(EXAMPLE_TIMES.rain)}</tspan> {words.arrives}
      </text>
      <text className="plot__label plot__label--dim" x={x(EXAMPLE_TIMES.rain) - 10} y={208} textAnchor="end">
        {words.counts}
      </text>

      <text className="plot__big" x={x(EXAMPLE_TIMES.dry) + 24} y={172}>
        {formatExact(EXAMPLE.paid)}
      </text>
      <text className="plot__label" x={x(EXAMPLE_TIMES.dry) + 27} y={204}>
        {words.paidLine1(EXAMPLE.wetMinutes, EXAMPLE.parts.length)}
      </text>
      <text className="plot__label" x={x(EXAMPLE_TIMES.dry) + 27} y={226}>
        {words.paidLine2}
      </text>

      <line className="plot__lead" x1={x(EXAMPLE_TIMES.dry) + 0.5} x2={x(EXAMPLE_TIMES.dry) + 0.5} y1={THRESHOLD} y2={336} />
      <line className="plot__lead" x1={x(EXAMPLE_TIMES.dry) + 0.5} x2={x(EXAMPLE_TIMES.dry) + 20} y1={327.5} y2={327.5} />
      <text className="plot__label" x={x(EXAMPLE_TIMES.dry) + 26} y={332}>
        <tspan className="plot__t">{clock(EXAMPLE_TIMES.dry)}</tspan> {words.eases}
      </text>

      <line className="plot__lead" x1={x(EXAMPLE_TIMES.end) - 0.5} x2={x(EXAMPLE_TIMES.end) - 0.5} y1={318} y2={468} />
      <text className="plot__label" x={x(EXAMPLE_TIMES.end) - 9} y={332} textAnchor="end">
        <tspan className="plot__t">{clock(EXAMPLE_TIMES.end)}</tspan> {words.off}
      </text>
    </svg>
  )
}

export { clock as exampleClock }
