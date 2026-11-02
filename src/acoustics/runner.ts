// A pool of web workers. A scene is posted once per run; receivers go out in
// chunks so progress can be reported and a run can be cancelled.

import type { ComputeScene } from './scene'
import type { ReceiverSet } from './build'

const CHUNK = 400
const SIZE = Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 1))

let pool: Worker[] = []
let runId = 0
let abort: (() => void) | undefined

function workers(): Worker[] {
  if (pool.length === 0) {
    pool = Array.from(
      { length: SIZE },
      () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    )
  }
  return pool
}

export class Cancelled extends Error {}

/** Cancels whatever is running (the pool is rebuilt on the next run). */
export function cancelAll(): void {
  runId++
  for (const w of pool) w.terminate()
  pool = []
  abort?.()
  abort = undefined
}

export interface RunPart {
  scene: ComputeScene
  set: ReceiverSet
  lmax?: boolean
}

/**
 * Computes several receiver sets (possibly on different scenes) in sequence,
 * reporting overall progress 0…1. Result per part: Float32Array with 3 (or 8
 * with lmax) values per receiver: Ld, Le, Ln [, Lmax per category].
 */
export async function runParts(
  parts: RunPart[],
  onProgress: (f: number) => void,
): Promise<Float32Array[]> {
  const my = ++runId
  const total = parts.reduce((s, p) => s + p.set.x.length, 0) || 1
  let done = 0
  const results: Float32Array[] = []
  for (const part of parts) {
    if (my !== runId) throw new Cancelled()
    results.push(
      await runOne(part, my, (n) => {
        done += n
        onProgress(done / total)
      }),
    )
  }
  return results
}

function runOne(part: RunPart, my: number, onChunk: (n: number) => void): Promise<Float32Array> {
  const ws = workers()
  for (const w of ws) w.postMessage({ type: 'scene', scene: part.scene })
  const n = part.set.x.length
  const stride = part.lmax ? 8 : 3
  const out = new Float32Array(n * stride).fill(NaN)
  const chunks: [number, number][] = []
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
      })
    }
    ws.forEach((w) => {
      w.onmessage = (ev: MessageEvent) => {
        if (my !== runId) return reject(new Cancelled())
        const { id, out: chunk } = ev.data as { id: number; out: Float32Array }
        out.set(chunk, chunks[id][0] * stride)
        onChunk(chunks[id][1] - chunks[id][0])
        finished++
        if (finished === chunks.length) resolve(out)
        else send(w)
      }
      w.onerror = (e) => reject(new Error(e.message))
      send(w)
    })
  })
}
