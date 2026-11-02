// Octave bands used throughout: 63 Hz … 8 kHz, as in CNOSSOS-EU and ISO 9613-2.

export const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const
export const NB = BANDS.length

/** A-weighting per octave band (IEC 61672-1), dB. */
export const A_WEIGHT = [-26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1] as const

/** Speed of sound, m/s (≈ 10 °C). */
export const C_SOUND = 337.5

export const WAVELENGTH = BANDS.map((f) => C_SOUND / f)

/** Energetic sum of levels in dB. */
export function dbSum(levels: readonly number[]): number {
  let e = 0
  for (const l of levels) if (Number.isFinite(l)) e += 10 ** (l / 10)
  return e > 0 ? 10 * Math.log10(e) : -Infinity
}

/** Level from energy (10^(L/10)). */
export function energyToDb(e: number): number {
  return e > 0 ? 10 * Math.log10(e) : -Infinity
}

/** A-weighted total from per-band linear energies. */
export function aWeightedFromEnergy(bandEnergy: ArrayLike<number>, offset = 0): number {
  let e = 0
  for (let b = 0; b < NB; b++) e += bandEnergy[offset + b] * 10 ** (A_WEIGHT[b] / 10)
  return energyToDb(e)
}
