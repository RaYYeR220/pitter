import type { CSSProperties } from 'react'

/**
 * Rain streaks: 1px strokes that sit on the 8px column rules, so the rain is the page's own grid falling. The
 * strokes are a mask, so their colour follows the ink of whichever set is showing.
 */
function streakTile(width: number, height: number, count: number, seed: number): string {
  let state = seed
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    const x = Math.floor(random() * (width / 8)) * 8 + 0.5
    const y = Math.floor(random() * height)
    const length = 18 + Math.floor(random() * 100)
    const alpha = (0.15 + random() * 0.25).toFixed(2)
    // drawn twice, one tile apart, so the tile repeats without a seam
    for (const offset of [0, -height]) {
      lines.push(`<line x1='${x}' x2='${x}' y1='${y + offset}' y2='${y + offset + length}' stroke-opacity='${alpha}'/>`)
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'><g stroke='#000' stroke-width='1' shape-rendering='crispEdges'>${lines.join('')}</g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

const TILE = { width: 640, height: 900 }
const SOFT = streakTile(TILE.width, TILE.height, 70, 7)
const HEAVY = streakTile(TILE.width, TILE.height, 190, 13)

export function Rain({ heavy = false, className }: { heavy?: boolean; className?: string }) {
  const style = {
    '--streaks': heavy ? HEAVY : SOFT,
    '--tile-h': `${TILE.height}px`,
  } as CSSProperties
  return <div className={`rain${heavy ? ' rain--heavy' : ''}${className ? ` ${className}` : ''}`} style={style} aria-hidden="true" />
}
