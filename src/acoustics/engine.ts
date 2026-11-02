// Sound propagation from road sources to a receiver.
//
// Method: ISO 9613-2 ("Attenuation of sound during propagation outdoors",
// downwind / favourable propagation, i.e. the conservative long-term case),
// evaluated per octave band along a vertical profile cut through the terrain,
// the buildings and the noise barriers between each source piece and the
// receiver:
//
//   L = L_W − A_div − A_atm − A_ground/screen
//
//   A_div    20 lg d + 11                         spherical spreading
//   A_atm    α(f) · d                              10 °C, 70 % RH
//   A_ground ISO 9613-2 general method (7.3.1)     G_source = 0 (road), G elsewhere
//   D_z      10 lg(3 + 20/λ · C3 · z · K_met)     barrier, z = path difference over
//                                                  the convex hull ("rubber band")
//                                                  of terrain + buildings + walls;
//                                                  capped 20 dB (single) / 25 dB (multiple)
//
// Screening and ground effect are blended continuously (see `screenAndGround`)
// rather than with ISO's hard max(), so a receiver moving into a barrier's
// shadow does not jump by several dB. Partial screening of a path that clears
// an obstacle only just (negative path difference, up to λ/10) is included as
// in CNOSSOS-EU.
//
// First-order reflections on noise walls are added with image sources, with
// the wall's reflection loss. Reflections on building façades are not modelled.

import { NB, WAVELENGTH } from './bands'
import { NP, sampleBilinear, sampleNearest, type ComputeScene } from './scene'

/** Atmospheric absorption, dB per metre, ISO 9613-1 at 10 °C / 70 % RH. */
const ALPHA = [0.1, 0.4, 1.0, 1.9, 3.7, 9.7, 32.8, 117].map((a) => a / 1000)

/** Source pieces are refined until their radius is below this fraction of the distance. */
const REFINE = 0.2

/** Terrain must stand this far above the sight line to count as an obstacle (DTM noise). */
const TERRAIN_TOL = 0.3

/** Terrain within this distance of the source / receiver is ground, not obstacle. */
const NEAR_SOURCE = 4
const NEAR_RECEIVER = 1.5
/** Buildings closer than this to the receiver are ignored (the façade the point sits on). */
const NEAR_RECEIVER_BLDG = 0.8

const MAX_SAMPLES = 400
const MAX_POINTS = MAX_SAMPLES + 64

// Scratch buffers — engines run single-threaded per worker.
const pd = new Float64Array(MAX_POINTS) // distance along path
const pz = new Float64Array(MAX_POINTS) // obstacle top
const pk = new Uint8Array(MAX_POINTS) // 0 terrain, 1 building, 2 wall
const hx = new Float64Array(MAX_POINTS)
const hz = new Float64Array(MAX_POINTS)
const wallD = new Float64Array(64)
const wallZ = new Float64Array(64)

/** ISO 9613-2 Table 3 ground attenuation for one region. */
function regionGround(out: Float64Array, h: number, G: number, dp: number): void {
  const e50 = 1 - Math.exp(-dp / 50)
  const a = 1.5 + 3.0 * Math.exp(-0.12 * (h - 5) * (h - 5)) * e50 +
    5.7 * Math.exp(-0.09 * h * h) * (1 - Math.exp(-2.8e-6 * dp * dp))
  const b = 1.5 + 8.6 * Math.exp(-0.09 * h * h) * e50
  const c = 1.5 + 14.0 * Math.exp(-0.46 * h * h) * e50
  const d = 1.5 + 5.0 * Math.exp(-0.9 * h * h) * e50
  out[0] += -1.5
  out[1] += -1.5 + G * a
  out[2] += -1.5 + G * b
  out[3] += -1.5 + G * c
  out[4] += -1.5 + G * d
  out[5] += -1.5 * (1 - G)
  out[6] += -1.5 * (1 - G)
  out[7] += -1.5 * (1 - G)
}

const agr = new Float64Array(NB)

/** A_gr per band into `agr`. Source region on the road (G = 0). */
function groundAttenuation(hs: number, hr: number, dp: number, G: number): void {
  agr.fill(0)
  regionGround(agr, Math.max(0, hs), 0, dp)
  regionGround(agr, Math.max(0, hr), G, dp)
  const lim = 30 * (hs + hr)
  const q = dp <= lim ? 0 : 1 - lim / dp
  agr[0] += -3 * q
  for (let b = 1; b < NB; b++) agr[b] += -3 * q * (1 - G)
}

/**
 * Barrier attenuation blended with the ground effect.
 *
 * For z ≤ 0 (clear or grazing) the ground effect applies in full plus the
 * partial screening term. Once the path is blocked the ground term fades out
 * as the screening grows, reaching ISO's max(D_z, A_gr) = D_z at full
 * screening, and the two meet at z = 0.
 */
function screenAndGround(
  out: Float64Array,
  z: number,
  multiple: boolean,
  e: number,
  kmet: number,
): void {
  const cap = multiple ? 25 : 20
  for (let b = 0; b < NB; b++) {
    const lam = WAVELENGTH[b]
    let c3 = 1
    if (multiple && e > 0) {
      const t = (5 * lam) / e
      c3 = (1 + t * t) / (1 / 3 + t * t)
    }
    let dz = 0
    const arg = 3 + (20 / lam) * c3 * z * (z > 0 ? kmet : 1)
    if (arg > 1) dz = Math.min(cap, 10 * Math.log10(arg))
    if (z <= 0) {
      out[b] = agr[b] + dz
    } else {
      const d0 = 10 * Math.log10(3)
      const f = Math.max(0, 1 - (dz - d0) / (cap - d0))
      out[b] = dz + agr[b] * f
    }
  }
}

export interface PathPoint {
  x: number
  y: number
}

/**
 * Attenuation per band along a path that may fold at one reflection point.
 * `via` (optional) is the reflection point; `skipWall` the reflecting segment.
 * Returns false when the path is not evaluated (too far).
 */
export function pathAttenuation(
  scene: ComputeScene,
  xs: number,
  ys: number,
  zs: number,
  xr: number,
  yr: number,
  zr: number,
  out: Float64Array,
  via?: PathPoint,
  skipWall = -1,
): boolean {
  const legs = via ? 2 : 1
  const ax = [xs, via ? via.x : xr, xr]
  const ay = [ys, via ? via.y : yr, yr]
  const len1 = Math.hypot(ax[1] - ax[0], ay[1] - ay[0])
  const len2 = via ? Math.hypot(ax[2] - ax[1], ay[2] - ay[1]) : 0
  const dPlan = Math.max(0.5, len1 + len2)
  if (dPlan > scene.maxDistance) return false

  const step = Math.max(1.5, dPlan / MAX_SAMPLES)
  const g = scene.ground
  const bl = scene.bldg
  const walls = scene.walls

  // ---- build the profile: samples + wall crossings, ordered by distance
  let np = 0
  pd[np] = 0
  pz[np] = zs
  pk[np] = 0
  np++

  let base = 0
  let sumClear = 0
  let nClear = 0
  for (let leg = 0; leg < legs; leg++) {
    const x0 = ax[leg]
    const y0 = ay[leg]
    const x1 = ax[leg + 1]
    const y1 = ay[leg + 1]
    const L = leg === 0 ? len1 : len2
    const dx = x1 - x0
    const dy = y1 - y0

    // wall crossings on this leg, sorted
    let nw = 0
    for (let j = 0; j < walls.n && nw < 64; j++) {
      if (j === skipWall) continue
      const ex = walls.x1[j] - walls.x0[j]
      const ey = walls.y1[j] - walls.y0[j]
      const den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-12) continue
      const wx = walls.x0[j] - x0
      const wy = walls.y0[j] - y0
      const t = (wx * ey - wy * ex) / den
      const u = (wx * dy - wy * dx) / den
      if (t <= 1e-6 || t >= 1 - 1e-6 || u < 0 || u > 1) continue
      const px = x0 + dx * t
      const py = y0 + dy * t
      const dist = base + t * L
      const top = sampleBilinear(g, px, py) + walls.h[j]
      // insertion sort
      let k = nw++
      while (k > 0 && wallD[k - 1] > dist) {
        wallD[k] = wallD[k - 1]
        wallZ[k] = wallZ[k - 1]
        k--
      }
      wallD[k] = dist
      wallZ[k] = top
    }

    const n = Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(L / step)))
    let wi = 0
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const dist = base + t * L
      while (wi < nw && wallD[wi] <= dist && np < MAX_POINTS - 2) {
        pd[np] = wallD[wi]
        pz[np] = wallZ[wi]
        pk[np] = 2
        np++
        wi++
      }
      if (leg === legs - 1 && i === n) break // the receiver itself
      if (np >= MAX_POINTS - 2) break
      const px = x0 + dx * t
      const py = y0 + dy * t
      const gz = sampleBilinear(g, px, py)
      const toR = dPlan - dist
      const h = sampleNearest(bl, px, py)
      const lineZ = zs + ((zr - zs) * dist) / dPlan
      sumClear += lineZ - gz
      nClear++
      if (h > 0 && toR > NEAR_RECEIVER_BLDG) {
        pd[np] = dist
        pz[np] = gz + h
        pk[np] = 1
        np++
      } else if (dist > NEAR_SOURCE && toR > NEAR_RECEIVER) {
        pd[np] = dist
        pz[np] = gz - TERRAIN_TOL
        pk[np] = 0
        np++
      }
    }
    while (wi < nw && np < MAX_POINTS - 1) {
      pd[np] = wallD[wi]
      pz[np] = wallZ[wi]
      pk[np] = 2
      np++
      wi++
    }
    base += L
  }
  pd[np] = dPlan
  pz[np] = zr
  pk[np] = 0
  np++

  // ---- geometry
  const dz = zr - zs
  const d3 = Math.max(1, Math.hypot(dPlan, dz))

  // Upper convex hull from S to R (monotone chain).
  let nh = 0
  let blocked = false
  let bestNeg = -Infinity // largest (closest to zero) negative path difference
  for (let i = 0; i < np; i++) {
    const x = pd[i]
    const z = pz[i]
    if (i > 0 && i < np - 1) {
      const lineZ = zs + (dz * x) / dPlan
      if (z > lineZ) blocked = true
      else if (pk[i] !== 0) {
        // partial screening by a building or wall that the ray just clears
        const c = lineZ - z
        const a = x
        const b = dPlan - x
        const neg = -(Math.hypot(a, c) + Math.hypot(b, c) - a - b)
        if (neg > bestNeg) bestNeg = neg
      }
    }
    while (nh >= 2) {
      const ox = hx[nh - 2]
      const oz = hz[nh - 2]
      const cross = (hx[nh - 1] - ox) * (z - oz) - (hz[nh - 1] - oz) * (x - ox)
      if (cross >= 0) nh--
      else break
    }
    hx[nh] = x
    hz[nh] = z
    nh++
  }

  let z = bestNeg === -Infinity ? -1e9 : bestNeg
  let multiple = false
  let e = 0
  let kmet = 1
  if (blocked && nh > 2) {
    let len = 0
    for (let i = 1; i < nh; i++) len += Math.hypot(hx[i] - hx[i - 1], hz[i] - hz[i - 1])
    z = Math.max(0, len - d3)
    const dss = Math.hypot(hx[1] - hx[0], hz[1] - hz[0])
    const dsr = Math.hypot(hx[nh - 1] - hx[nh - 2], hz[nh - 1] - hz[nh - 2])
    e = Math.max(0, len - dss - dsr)
    multiple = nh > 3 && e > 0.5
    if (z > 0) kmet = Math.exp(-(1 / 2000) * Math.sqrt((dss * dsr * d3) / (2 * z)))
  }

  // ---- ground: heights above local ground at both ends
  const hs = Math.max(0, zs - sampleBilinear(g, xs, ys))
  const hr = Math.max(0, zr - sampleBilinear(g, xr, yr))
  // Over a valley the ray runs well above the ground: use the mean clearance
  // in the middle region when it exceeds the end heights (ISO 9613-2 h_m idea).
  const hm = nClear > 0 ? sumClear / nClear : 0
  groundAttenuation(hs, Math.max(hr, Math.min(hm, 30)), dPlan, scene.groundG)
  screenAndGround(out, z, multiple, e, kmet)

  const adiv = 20 * Math.log10(d3) + 11
  for (let b = 0; b < NB; b++) out[b] += adiv + ALPHA[b] * d3
  return true
}

const att = new Float64Array(NB)
const stack = new Int32Array(4096)

/** Lmax per category when requested: 5 values, dB(A). */
export interface PointOptions {
  lmax?: Float64Array
}

const A_LIN = [-26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1]

/**
 * Accumulates the energy at a receiver into `out` (NP × NB, linear).
 * The receiver stands at (x, y), `height` metres above the ground.
 */
export function computePoint(
  scene: ComputeScene,
  x: number,
  y: number,
  height: number,
  out: Float64Array,
  opts: PointOptions = {},
): void {
  out.fill(0)
  const src = scene.src
  const zr = sampleBilinear(scene.ground, x, y) + height
  const maxD = scene.maxDistance
  const lmax = opts.lmax
  if (lmax) lmax.fill(-Infinity)

  // ---- direct paths
  let sp = 0
  for (let i = 0; i < src.roots.length; i++) stack[sp++] = src.roots[i]
  while (sp > 0) {
    const n = stack[--sp]
    const dx = src.x[n] - x
    const dy = src.y[n] - y
    const d = Math.hypot(dx, dy)
    if (d - src.r[n] > maxD) continue
    const leaf = src.left[n] < 0
    const refine = lmax ? !leaf : !leaf && src.r[n] > REFINE * d
    if (refine && sp < stack.length - 2) {
      stack[sp++] = src.left[n]
      stack[sp++] = src.right[n]
      continue
    }
    if (!pathAttenuation(scene, src.x[n], src.y[n], src.z[n], x, y, zr, att)) continue
    accumulate(out, src.pow, n, att)
    if (lmax) maxLevels(scene, src.road[n], att, lmax)
  }

  // ---- first-order reflections on walls
  if (!scene.reflections) return
  const w = scene.walls
  for (let j = 0; j < w.n; j++) {
    const refl = w.refl[j]
    if (!Number.isFinite(refl)) continue
    const ex = w.x1[j] - w.x0[j]
    const ey = w.y1[j] - w.y0[j]
    const el = Math.hypot(ex, ey)
    if (el < 0.5) continue
    const ux = ex / el
    const uy = ey / el
    const sideR = ux * (y - w.y0[j]) - uy * (x - w.x0[j])
    if (Math.abs(sideR) < 0.1) continue
    const lossLin = 10 ** (-refl / 10)

    sp = 0
    for (let i = 0; i < src.roots.length; i++) stack[sp++] = src.roots[i]
    while (sp > 0) {
      const n = stack[--sp]
      const sx = src.x[n]
      const sy = src.y[n]
      const sideS = ux * (sy - w.y0[j]) - uy * (sx - w.x0[j])
      // the whole node on the far side: skip; straddling nodes are refined
      if (sideS * sideR <= 0 && Math.abs(sideS) > src.r[n]) continue
      // image source
      const ix = sx - 2 * sideS * -uy
      const iy = sy - 2 * sideS * ux
      const d = Math.hypot(ix - x, iy - y)
      if (d - src.r[n] > maxD) continue
      const leaf = src.left[n] < 0
      if (!leaf && (src.r[n] > REFINE * d || Math.abs(sideS) <= src.r[n]) && sp < stack.length - 2) {
        stack[sp++] = src.left[n]
        stack[sp++] = src.right[n]
        continue
      }
      if (sideS * sideR <= 0) continue
      // reflection point: where image → receiver crosses the wall line
      const dxr = x - ix
      const dyr = y - iy
      const den = dxr * ey - dyr * ex
      if (Math.abs(den) < 1e-9) continue
      const wx = w.x0[j] - ix
      const wy = w.y0[j] - iy
      const t = (wx * ey - wy * ex) / den
      const u = (wx * dyr - wy * dxr) / den
      if (t <= 0 || t >= 1 || u < 0 || u > 1) continue
      const px = ix + dxr * t
      const py = iy + dyr * t
      const zAt = src.z[n] + (zr - src.z[n]) * t
      const top = sampleBilinear(scene.ground, px, py) + w.h[j]
      if (zAt > top) continue
      if (!pathAttenuation(scene, sx, sy, src.z[n], x, y, zr, att, { x: px, y: py }, j)) continue
      accumulate(out, src.pow, n, att, lossLin)
    }
  }
}

function accumulate(
  out: Float64Array,
  pow: Float64Array,
  n: number,
  a: Float64Array,
  factor = 1,
): void {
  const o = n * NP * NB
  for (let b = 0; b < NB; b++) {
    const k = 10 ** (-a[b] / 10) * factor
    for (let p = 0; p < NP; p++) out[p * NB + b] += pow[o + p * NB + b] * k
  }
}

function maxLevels(scene: ComputeScene, road: number, a: Float64Array, lmax: Float64Array): void {
  for (let c = 0; c < 5; c++) {
    const o = (road * 5 + c) * NB
    let e = 0
    for (let b = 0; b < NB; b++) {
      const lw = scene.vehicle[o + b]
      if (!Number.isFinite(lw)) continue
      e += 10 ** ((lw - a[b] + A_LIN[b]) / 10)
    }
    const l = e > 0 ? 10 * Math.log10(e) : -Infinity
    if (l > lmax[c]) lmax[c] = l
  }
}

/** Period levels in dB(A) from an NP × NB energy vector. */
export function periodLevels(e: Float64Array): [number, number, number] {
  const out: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let p = 0; p < NP; p++) {
    let s = 0
    for (let b = 0; b < NB; b++) s += e[p * NB + b] * 10 ** (A_LIN[b] / 10)
    out[p] = s > 0 ? 10 * Math.log10(s) : -Infinity
  }
  return out
}
