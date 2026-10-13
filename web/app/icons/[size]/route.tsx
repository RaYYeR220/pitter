import { ImageResponse } from 'next/og'

const SIZES = new Set([180, 192, 512])

/**
 * The app icon as a PNG, drawn here: the cover switch, switched on, on the near-black ground, with the 1 mm line
 * on its knob. `?maskable` leaves the safe margin.
 */
export async function GET(request: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size)
  if (!SIZES.has(size)) return new Response('Not found', { status: 404 })
  const maskable = new URL(request.url).searchParams.has('maskable')
  const pill = Math.round(size * (maskable ? 0.6 : 0.76))
  const height = Math.round(pill / 2)
  const knob = Math.round(height * 0.76)
  const inset = Math.round((height - knob) / 2)

  return new ImageResponse(
    (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0b',
        }}
      >
        <div
          style={{
            width: pill,
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            paddingRight: inset,
            borderRadius: height,
            background: '#edebe6',
          }}
        >
          <div
            style={{
              width: knob,
              height: knob,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: knob,
              background: '#0a0a0b',
            }}
          >
            <div style={{ width: Math.max(2, Math.round(knob * 0.07)), height: Math.round(knob * 0.36), background: '#ff5a1f' }} />
          </div>
        </div>
      </div>
    ),
    { width: size, height: size, headers: { 'cache-control': 'public, max-age=86400, immutable' } },
  )
}
