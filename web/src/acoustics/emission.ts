// Road traffic sound power, after CNOSSOS-EU (Directive (EU) 2015/996, Annex II,
// section 2.2): rolling noise + propulsion noise per vehicle category and
// octave band, then a line source of flow Q (veh/h) at speed v (km/h).
//
//   L_WR = A_R + B_R · lg(v / 70)              rolling
//   L_WP = A_P + B_P · (v − 70) / 70           propulsion
//   L_W' = L_W + 10 lg(Q / (1000 · v))         per metre of lane, dB re 1 pW/m
//
// Corrections included: road gradient (propulsion), road surface (rolling, as a
// flat dB value). Not included: acceleration at junctions, studded tyres,
// temperature. The coefficients are the reference values; a site calibration
// against a measurement is recommended (see the measurement field on receivers).

import { A_WEIGHT, NB } from './bands'

/** CNOSSOS vehicle categories: light, medium heavy, heavy, mopeds, motorcycles. */
export type Category = 'light' | 'medium' | 'heavy' | 'moped' | 'moto'
export const CATEGORIES: readonly Category[] = ['light', 'medium', 'heavy', 'moped', 'moto']

interface Coeffs {
  AR: readonly number[]
  BR: readonly number[]
  AP: readonly number[]
  BP: readonly number[]
}

const ZERO = [0, 0, 0, 0, 0, 0, 0, 0]

export const COEFFS: Record<Category, Coeffs> = {
  light: {
    AR: [79.7, 85.7, 84.5, 90.2, 97.3, 93.9, 84.1, 74.3],
    BR: [30.0, 41.5, 38.9, 25.7, 32.5, 37.2, 39.0, 40.0],
    AP: [94.5, 89.2, 88.0, 85.9, 84.2, 86.9, 83.3, 76.1],
    BP: [-1.3, 7.2, 7.7, 8.0, 8.0, 8.0, 8.0, 8.0],
  },
  medium: {
    AR: [84.0, 88.7, 91.5, 96.7, 97.4, 90.9, 83.8, 80.5],
    BR: [30.0, 35.8, 32.6, 23.8, 30.1, 36.2, 38.3, 40.1],
    AP: [101.0, 96.5, 98.8, 96.8, 98.6, 95.2, 88.8, 82.7],
    BP: [-1.9, 4.7, 6.4, 6.5, 6.5, 6.5, 6.5, 6.5],
  },
  heavy: {
    AR: [87.0, 91.7, 94.1, 100.7, 100.8, 94.3, 87.1, 82.5],
    BR: [30.0, 33.5, 31.3, 25.4, 31.8, 37.1, 38.6, 40.6],
    AP: [104.4, 100.6, 101.7, 101.0, 100.1, 95.9, 91.3, 85.3],
    BP: [0.0, 3.0, 4.6, 5.0, 5.0, 5.0, 5.0, 5.0],
  },
  moped: {
    AR: ZERO,
    BR: ZERO,
    AP: [88.0, 87.5, 89.5, 93.7, 96.6, 98.8, 93.9, 88.7],
    BP: [4.2, 7.4, 9.8, 11.6, 15.7, 18.9, 20.3, 20.6],
  },
  moto: {
    AR: ZERO,
    BR: ZERO,
    AP: [95.0, 97.2, 92.7, 92.9, 94.7, 93.2, 90.1, 86.5],
    BP: [3.2, 5.9, 11.9, 11.6, 11.5, 12.6, 11.1, 12.0],
  },
}

/** Lowest speed the model is valid for (CNOSSOS: 20 km/h). */
export const MIN_SPEED = 20

/**
 * Gradient correction on propulsion noise, dB. `s` in percent, positive uphill
 * in the direction of travel. CNOSSOS-EU 2.2.4 (gradient capped at ±12 %).
 */
export function gradientCorrection(cat: Category, sPercent: number, v: number): number {
  const s = Math.max(-12, Math.min(12, sPercent))
  switch (cat) {
    case 'light':
      if (s < -6) return (-s - 6) / 1
      if (s > 2) return (s - 2) / 1.5
      return 0
    case 'medium':
      if (s < -4) return ((-s - 4) / 0.7) * ((v - 20) / 100)
      if (s > 0) return (s / 1) * (v / 100)
      return 0
    case 'heavy':
      if (s < -4) return ((-s - 4) / 0.5) * ((v - 10) / 100)
      if (s > 0) return (s / 0.8) * (v / 100)
      return 0
    default:
      return 0
  }
}

export interface VehicleOptions {
  /** Gradient in percent along the direction of travel. */
  gradient?: number
  /** Road surface correction on rolling noise, dB (negative = quieter surface). */
  surface?: number
  /** Extra dB on the whole vehicle, e.g. for loud / tuned motorcycles. */
  extra?: number
}

/** Sound power of a single vehicle, per octave band, dB re 1 pW. */
export function vehiclePower(cat: Category, speed: number, opts: VehicleOptions = {}): number[] {
  const v = Math.max(MIN_SPEED, speed)
  const c = COEFFS[cat]
  const grad = gradientCorrection(cat, opts.gradient ?? 0, v)
  const rolling = cat === 'moped' || cat === 'moto' ? false : true
  const out: number[] = []
  for (let b = 0; b < NB; b++) {
    const lp = c.AP[b] + (c.BP[b] * (v - 70)) / 70 + grad
    let e = 10 ** (lp / 10)
    if (rolling) {
      const lr = c.AR[b] + c.BR[b] * Math.log10(v / 70) + (opts.surface ?? 0)
      e += 10 ** (lr / 10)
    }
    out.push(10 * Math.log10(e) + (opts.extra ?? 0))
  }
  return out
}

/**
 * Sound power per metre of a traffic stream, per band, as linear energy
 * (10^(L_W'/10)) so streams can be added. Q in vehicles per hour.
 */
export function streamPowerPerMetre(
  cat: Category,
  flow: number,
  speed: number,
  opts: VehicleOptions = {},
): number[] {
  const out = new Array<number>(NB).fill(0)
  if (!(flow > 0)) return out
  const v = Math.max(MIN_SPEED, speed)
  const lw = vehiclePower(cat, v, opts)
  const k = flow / (1000 * v)
  for (let b = 0; b < NB; b++) out[b] = 10 ** (lw[b] / 10) * k
  return out
}

export function aWeighted(levels: readonly number[]): number {
  let e = 0
  for (let b = 0; b < NB; b++) e += 10 ** ((levels[b] + A_WEIGHT[b]) / 10)
  return 10 * Math.log10(e)
}
