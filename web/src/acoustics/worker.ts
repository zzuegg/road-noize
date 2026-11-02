/// <reference lib="webworker" />
import init, { WasmEngine, pe_section } from '../wasm/sansim.js'

let engine: WasmEngine | undefined
let sceneKey = ''
const ready = init()

self.onmessage = async (ev: MessageEvent) => {
  await ready
  const msg = ev.data
  try {
    if (msg.type === 'scene') {
      if (msg.key !== sceneKey) {
        engine?.free()
        engine = new WasmEngine(msg.json, msg.ground)
        sceneKey = msg.key
      }
      return
    }
    if (msg.type === 'job') {
      const out = engine!.compute(msg.x, msg.y, msg.h, msg.skip, msg.lmax, msg.incident)
      ;(self as unknown as Worker).postMessage({ type: 'done', id: msg.id, out }, [out.buffer])
      return
    }
    if (msg.type === 'pe') {
      const out = pe_section(msg.json)
      ;(self as unknown as Worker).postMessage({ type: 'pe', id: msg.id, out })
    }
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ type: 'error', id: msg.id, message: String(e) })
  }
}
