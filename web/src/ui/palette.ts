// Colour scales. Levels: 5 dB classes in the colours of ISO 1996-2 / DIN 45682
// noise maps. Differences: diverging blue (quieter) – white – red (louder).

export const LEVEL_CLASSES: [number, string][] = [
  [35, '#c4e6a4'],
  [40, '#8fcf6b'],
  [45, '#3f9a3a'],
  [50, '#f3ee5a'],
  [55, '#e8b540'],
  [60, '#e5772e'],
  [65, '#d6262a'],
  [70, '#a11a4c'],
  [75, '#5d1f8c'],
  [80, '#2a2f8f'],
]

export function levelColour(v: number): string | undefined {
  if (!Number.isFinite(v) || v < LEVEL_CLASSES[0][0]) return undefined
  let c = LEVEL_CLASSES[0][1]
  for (const [from, col] of LEVEL_CLASSES) if (v >= from) c = col
  return c
}

export const DIFF_CLASSES: [number, string][] = [
  [-Infinity, '#08306b'],
  [-10, '#2171b5'],
  [-6, '#4292c6'],
  [-3, '#9ecae1'],
  [-1, '#f0f0f0'],
  [1, '#fcbba1'],
  [3, '#fb6a4a'],
  [6, '#cb181d'],
]

export function diffColour(d: number): string | undefined {
  if (!Number.isFinite(d)) return undefined
  // |Δ| < 1 dB is not audible and not drawn, so the map shows through.
  if (d > -1 && d < 1) return undefined
  let c = DIFF_CLASSES[0][1]
  for (const [from, col] of DIFF_CLASSES) if (d >= from) c = col
  return c
}

export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
