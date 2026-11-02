# road-noize — Verkehrslärm-Simulation Südtirol

Browser application to simulate **road traffic noise** and compare **noise
protection options** before anything is built: noise walls, earth berms, speed
limits, quieter asphalt, night-time truck bans, traffic reduction, louder or
quieter motorcycles.

Terrain, buildings and roads are loaded directly from the open geodata services
of the **Autonomous Province of Bolzano – South Tyrol** (CC0). The example
project is **Tschars / Ciardes** (Kastelbell-Tschars) with the SS 38.

## What it does

1. **Choose an area** (rectangle on the map, EPSG:25832).
2. **Load geodata** from the province:
   - terrain model DTM 2.5 m (or 0.5 m) — WCS `geoservices9`
   - surface model DSM — building height = 90th percentile of DSM − DTM inside each footprint
   - building footprints INSPIRE `BU.Building` — WFS `geoservices8`
   - road graph `LinksSequences` (state / provincial / municipal roads) — WFS `geoservices1`,
     clipped to the area and de-duplicated (address names lying on the SS 38 are not counted twice)
   - permanent traffic counters nearby, with links to the ASTAT AADT figures
3. **Enter traffic** per road: AADT, shares of vans, trucks, motorcycles, mopeds,
   distribution over day / evening / night, speeds, surface correction,
   motorcycle extra dB (sport bikes / open exhausts).
   > Imported roads start with **placeholder** traffic. Replace them with counted values.
4. **Scenarios**: "Existing situation" plus any number of variants (copy a
   scenario, add walls/berms and traffic measures).
5. **Compute** (web workers, all CPU cores). Results:
   - noise map (Lden, LAeq 06–22, Lday, Levening, Lnight) at 4 m height
   - **difference map** between two scenarios
   - **façade levels per floor** for every building, buildings/floors above the limit
   - **receiver points** at windows with Lday/Lnight, **Lmax of a passing truck / motorcycle**,
     and comparison with measured values
   - **vertical cross-section** showing terrain, buildings, walls and the sound field
   - CSV export, project export/import (`.noise.json`), autosave in the browser

## Method

| Part | Model |
|---|---|
| Emission | CNOSSOS-EU road traffic (Directive (EU) 2015/996 Annex II): rolling + propulsion noise, 5 vehicle categories, octave bands 63 Hz–8 kHz, gradient correction from the DTM per direction, surface correction |
| Propagation | ISO 9613-2 (downwind, i.e. conservative): geometric divergence, atmospheric absorption (10 °C / 70 %), ground effect (general method, G configurable, road surface G = 0) |
| Screening | Path difference over the convex hull of a vertical profile through terrain, buildings and barriers; single / multiple diffraction (C3), Kmet; partial screening for grazing paths; ground effect blended continuously into screening |
| Reflections | First-order reflections on noise walls (image sources) with reflection loss: reflective 1 dB, absorptive 6 dB, highly absorptive 11 dB |
| Periods | D.Lgs. 194/2005: day 06–20, evening 20–22, night 22–06; Lden; LAeq 06–22 (DPR 142/2004) |

Source lines are split into ≤ 4 m pieces and organised in a tree, so distant
roads are evaluated as aggregated point sources and nearby ones in detail.

**Not modelled** (known limitations): reflections on building façades,
lateral diffraction around wall ends other than via the source discretisation,
meteorological correction C_met (results are for favourable propagation),
acceleration at junctions, railway noise, tunnels and bridges (roads lie on the
terrain model).

Results are a planning aid. For formal noise assessments cross-check with
certified software (e.g. CadnaA, SoundPLAN) and measurements — the receiver
points accept measured values for exactly that.

## Development

```bash
npm install
npm run dev        # http://localhost:5180
npm test           # physics tests
npm run build
```

Live service checks (need network): `LIVE=1 npx vitest run src/geo/live.test.ts`.

Code layout:

- `src/acoustics/` — emission, propagation engine, scene builder, web worker pool (no UI)
- `src/geo/` — province services (WCS/WFS), CRS
- `src/model/` — project document and state
- `src/ui/` — map (OpenLayers), panels, cross-section
