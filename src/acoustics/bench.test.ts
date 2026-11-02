import { it } from 'vitest'
import { computePoint } from './engine'
import { buildScene, rasterizeBuildings } from './build'
import { createProject, defaultTraffic, uid } from '../model/defaults'
import { NB } from './bands'

it.skipIf(!process.env.BENCH)('bench', () => {
  const cols = 801
  const g = { cols, rows: cols, cell: 2.5, e0: 0, n0: 0, data: new Float32Array(cols * cols).map((_, i) => 500 + ((i / cols) | 0) * 0.1) }
  const p = createProject('t', 'b')
  p.area = { e0: 0, n0: 0, e1: 2000, n1: 2000 }
  p.roads = [0, 1, 2].map((k) => ({ id: uid('r'), name: 'r', cls: 'SS' as const, enabled: true, lines: [[[0, 300 + k * 500], [700, 500 + k * 400], [2000, 600 + k * 400]] as [number, number][]], traffic: defaultTraffic('SS') }))
  const bl = rasterizeBuildings([], p.area)
  const scene = buildScene(p, p.scenarios[0], g, bl)
  const out = new Float64Array(3 * NB)
  const t0 = performance.now()
  let n = 0
  for (let y = 0; y < 2000; y += 40) for (let x = 0; x < 2000; x += 40) { computePoint(scene, x, y, 4, out); n++ }
  console.log('receivers', n, 'ms', performance.now() - t0, 'per receiver ms', (performance.now() - t0) / n, 'sources', scene.src.n)
})
