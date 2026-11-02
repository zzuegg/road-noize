/// <reference lib="webworker" />
import { computePoint, periodLevels } from './engine'
import { NP, type ComputeScene } from './scene'
import { NB } from './bands'

let scene: ComputeScene | undefined
const e = new Float64Array(NP * NB)
const lmax = new Float64Array(5)

export interface JobMessage {
  type: 'job'
  id: number
  x: Float64Array
  y: Float64Array
  h: Float64Array
  skip: Uint8Array
  lmax: boolean
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data
  if (msg.type === 'scene') {
    scene = msg.scene as ComputeScene
    return
  }
  if (msg.type === 'job' && scene) {
    const job = msg as JobMessage
    const n = job.x.length
    const stride = job.lmax ? 8 : 3
    const out = new Float32Array(n * stride).fill(NaN)
    for (let i = 0; i < n; i++) {
      if (job.skip[i]) continue
      computePoint(scene, job.x[i], job.y[i], job.h[i], e, job.lmax ? { lmax } : {})
      const [ld, le, ln] = periodLevels(e)
      out[i * stride] = ld
      out[i * stride + 1] = le
      out[i * stride + 2] = ln
      if (job.lmax) for (let c = 0; c < 5; c++) out[i * stride + 3 + c] = lmax[c]
    }
    ;(self as unknown as Worker).postMessage({ type: 'done', id: job.id, out }, [out.buffer])
  }
}
