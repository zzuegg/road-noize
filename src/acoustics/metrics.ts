// Indicators from the three period levels (D.Lgs. 194/2005: day 06–20,
// evening 20–22, night 22–06).

import type { Metric } from '../model/types'

export function lden(ld: number, le: number, ln: number): number {
  const e = 14 * 10 ** (ld / 10) + 2 * 10 ** ((le + 5) / 10) + 8 * 10 ** ((ln + 10) / 10)
  return 10 * Math.log10(e / 24)
}

/** L_Aeq over 06–22, the Italian "periodo diurno" (DPR 142/2004). */
export function ldiurno(ld: number, le: number): number {
  return 10 * Math.log10((14 * 10 ** (ld / 10) + 2 * 10 ** (le / 10)) / 16)
}

export function metricOf(m: Metric, ld: number, le: number, ln: number): number {
  switch (m) {
    case 'lday':
      return ld
    case 'levening':
      return le
    case 'lnight':
      return ln
    case 'ldiurno':
      return ldiurno(ld, le)
    case 'lden':
      return lden(ld, le, ln)
  }
}

/** The limit a metric is judged against. */
export function limitFor(
  m: Metric,
  s: { limitDay: number; limitNight: number; limitLden: number },
): number {
  if (m === 'lnight') return s.limitNight
  if (m === 'lden') return s.limitLden
  return s.limitDay
}
