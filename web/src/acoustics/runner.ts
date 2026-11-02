// Worker pool around the Rust core. A scene is sent once per worker and kept
// until a different one arrives; receivers go out in chunks for progress and
// cancellation.

import type { ReceiverSet } from './build'

const CHUNK = 64
const SIZE = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1))

let pool: Worker[] = []
let runId = 0
let abort: (() => void) | undefined

function workers(): Worker[] {
  if (pool.length === 0) {
    pool = Array.from({ length: SIZE }, () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }))
  }
  return pool
}

export class Cancelled extends Error {}

export function cancelAll(): void {
  runId++
  for (const w of pool) w.terminate()
  pool = []
  abort?.()
  abort = undefined
}

export interface RunPart {
  key: string
  json: string
  ground: Float32Array
  set: ReceiverSet
  lmax?: boolean
  incident?: boolean
}

export async function runParts(parts: RunPart[], onProgress: (f: number) => void): Promise<Float32Array[]> {
  const my = ++runId
  const total = parts.reduce((s, p) => s + p.set.x.length, 0) || 1
  let done = 0
  const out: Float32Array[] = []
  for (const part of parts) {
    if (my !== runId) throw new Cancelled()
    out.push(
      await runOne(part, my, (n) => {
        done += n
        onProgress(done / total)
      }),
    )
  }
  return out
}

function runOne(part: RunPart, my: number, onChunk: (n: number) => void): Promise<Float32Array> {
  const ws = workers()
  for (const w of ws) w.postMessage({ type: 'scene', key: part.key, json: part.json, ground: part.ground })
  const n = part.set.x.length
  const stride = part.lmax ? 8 : 3
  const out = new Float32Array(n * stride).fill(NaN)
  const chunks: [number, number][] = []
  // small chunks first so progress moves; receivers interleaved for balance
  for (let i = 0; i < n; i += CHUNK) chunks.push([i, Math.min(n, i + CHUNK)])
  if (chunks.length === 0) return Promise.resolve(out)
  return new Promise((resolve, reject) => {
    abort = () => reject(new Cancelled())
    let next = 0
    let finished = 0
    const send = (w: Worker) => {
      if (next >= chunks.length) return
      const id = next++
      const [a, b] = chunks[id]
      w.postMessage({
        type: 'job',
        id,
        x: part.set.x.slice(a, b),
        y: part.set.y.slice(a, b),
        h: part.set.h.slice(a, b),
        skip: part.set.skip.slice(a, b),
        lmax: !!part.lmax,
        incident: !!part.incident,
      })
    }
    ws.forEach((w) => {
      w.onmessage = (ev: MessageEvent) => {
        if (my !== runId) return reject(new Cancelled())
        const m = ev.data
        if (m.type === 'error') return reject(new Error(m.message))
        if (m.type !== 'done') return
        out.set(m.out, chunks[m.id][0] * stride)
        onChunk(chunks[m.id][1] - chunks[m.id][0])
        if (++finished === chunks.length) resolve(out)
        else send(w)
      }
      w.onerror = (e) => reject(new Error(e.message))
      send(w)
    })
  })
}

/** Parabolic equation for one section on a spare worker. */
export function runPe(json: string): Promise<PeOutput> {
  const w = workers()[0]
  return new Promise((resolve, reject) => {
    const prev = w.onmessage
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data
      if (m.type === 'pe') {
        w.onmessage = prev
        resolve(m.out as PeOutput)
      } else if (m.type === 'error') {
        w.onmessage = prev
        reject(new Error(m.message))
      }
    }
    w.postMessage({ type: 'pe', id: -1, json })
  })
}

export interface PeOutput {
  cols: number
  rows: number
  outDr: number
  outDz: number
  zBottom: number
  deltaL: number[][]
}
