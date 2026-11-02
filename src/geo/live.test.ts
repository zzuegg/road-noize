import { it, expect } from 'vitest'
import { fetchRoads, fetchBuildings, fetchCoverage, heightsFromDsm, fetchCounters, DEM_COVERAGES } from './services'
import { TSCHARS_AREA } from '../model/defaults'

it.skipIf(!process.env.LIVE)('live services', async () => {
  const a = TSCHARS_AREA
  const roads = await fetchRoads(a)
  console.log('roads', roads.map((r) => `${r.cls} ${r.name} (${r.lines.length})`).join('; '))
  const counters = await fetchCounters(a)
  console.log('counters', counters.map((c) => `${c.code} ${c.place} km ${c.km}`).join('; '))
  const c = DEM_COVERAGES['2.5']
  const [dtm, dsm, b] = await Promise.all([fetchCoverage(c.dtm, a, c.cell), fetchCoverage(c.dsm, a, c.cell), fetchBuildings(a)])
  console.log('dtm', dtm.cols, dtm.rows, dtm.e0, dtm.n0, dtm.data.reduce((a,b)=>Math.min(a,b)), dtm.data.reduce((a,b)=>Math.max(a,b)))
  const bs = heightsFromDsm(b, dtm, dsm)
  const h = bs.map((x) => x.height).sort((p, q) => p - q)
  console.log('buildings', bs.length, 'dsm', bs.filter((x) => x.heightSource === 'dsm').length, 'median h', h[h.length >> 1], 'p90', h[Math.floor(h.length * 0.9)])
  expect(roads.length).toBeGreaterThan(0)
}, 300000)

it.skipIf(!process.env.LIVE)('overlap check', async () => {
  const roads = await fetchRoads(TSCHARS_AREA)
  const key = (x: number, y: number) => `${Math.round(x / 3)},${Math.round(y / 3)}`
  const cells = new Map<string, Set<string>>()
  for (const r of roads) for (const l of r.lines) for (let i = 0; i < l.length - 1; i++) {
    const [x0, y0] = l[i], [x1, y1] = l[i + 1]
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2)
    for (let k = 0; k <= n; k++) { const s = key(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n); (cells.get(s) ?? cells.set(s, new Set()).get(s)!).add(r.name) }
  }
  const pairs = new Map<string, number>()
  for (const s of cells.values()) if (s.size > 1) { const k = [...s].sort().join(' & '); pairs.set(k, (pairs.get(k) ?? 0) + 1) }
  console.log([...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15))
  console.log(roads.map(r=>r.cls+' '+r.name+' '+Math.round(r.lines.reduce((s,l)=>s+l.slice(1).reduce((q,p,i)=>q+Math.hypot(p[0]-l[i][0],p[1]-l[i][1]),0),0))+'m').join('; '))
  const tot = new Map<string, number>(); for (const s of cells.values()) for (const n of s) tot.set(n, (tot.get(n) ?? 0) + 1)
  console.log([...tot.entries()])
}, 300000)
