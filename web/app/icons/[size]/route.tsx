import { ImageResponse } from 'next/og'

const SIZES = new Set([180, 192, 512])

/** The app icon as a PNG, drawn here: a white drop on the theme colour. `?maskable` leaves the safe margin. */
export async function GET(request: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size)
  if (!SIZES.has(size)) return new Response('Not found', { status: 404 })
  const maskable = new URL(request.url).searchParams.has('maskable')
  const drop = Math.round(size * (maskable ? 0.5 : 0.62))

  return new ImageResponse(
    (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1f4e8c',
          borderRadius: maskable ? 0 : Math.round(size * 0.22),
        }}
      >
        <svg width={drop} height={drop} viewBox="0 0 64 64">
          <path d="M32 6c-10 14-18 24-18 34a18 18 0 0 0 36 0c0-10-8-20-18-34z" fill="#ffffff" />
        </svg>
      </div>
    ),
    { width: size, height: size, headers: { 'cache-control': 'public, max-age=86400, immutable' } },
  )
}
