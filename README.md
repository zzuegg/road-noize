# traffic-sansim

Road traffic noise simulation for South Tyrol with **physically detailed
propagation**: noise barriers of any cross-section (vertical, tilted, bent or
curved tops towards or away from the road, T/Y tops, earth berms with any
slope, berm + wall, gabions, free polygons) with their real reflection
directions, impedance ground, weather (refraction) and atmospheric turbulence.

Built to compare protection options *before* anything is built, and to show
why: noise maps, difference maps between scenarios, façade levels per floor,
pass-by maxima, and vertical cross-sections computed two independent ways
(ray model and a wave solver).

```
core/   Rust: the simulation (native library + WebAssembly)
web/    TypeScript/React: map, South Tyrol geodata import, scenarios, UI
```

## Data

Loaded live from the open geodata of the Autonomous Province of Bolzano –
South Tyrol (CC0), EPSG:25832:

| What | Service |
|---|---|
| Terrain DTM 2.5 m / 0.5 m | WCS `geoservices9.civis.bz.it` |
| Surface model DSM → building heights (90th percentile DSM − DTM per footprint) | same |
| Building footprints (INSPIRE `BU.Building`) | WFS `geoservices8` |
| Road graph (`LinksSequences`: state, provincial, municipal roads), clipped and de-duplicated | WFS `geoservices1` |
| Permanent traffic counters (links to ASTAT AADT) | WFS `geoservices1` |
| Orthophoto 2023 / maps | WMTS `geoservices.buergernetz.bz.it` |

Traffic volumes start as **placeholders** — enter counted AADT, shares and speeds.

## The model

### Emission
CNOSSOS-EU road traffic (Directive (EU) 2015/996): rolling + propulsion noise,
5 vehicle categories, octave bands 63 Hz – 8 kHz, gradient correction from the
DTM per direction of travel, road surface correction, extra dB for loud
motorcycles. Sources at the **Harmonoise heights**: 0.01 m (tyre/road, 80 % of
rolling, 20 % of propulsion) and 0.30 m (cars, two-wheelers) / 0.75 m (vans,
trucks) for the rest.

### Propagation (`core/src/path.rs`, `engine.rs`)
For every source piece → receiver, a vertical cut through terrain, buildings
and barrier cross-sections is evaluated per **sub-frequency** (default 3 per
octave, then band-averaged) and per **propagation condition**:

- **Ground**: locally reacting impedance (Delany–Bazley from flow resistivity:
  orchard meadow, pasture, forest, gravel, asphalt …; roads and buildings hard),
  **spherical-wave reflection coefficient** with the ground wave (Faddeeva
  function). The impedance is averaged over the **Fresnel zone** of the
  reflection, so a source on the asphalt still sees the meadow beside it.
- **Diffraction**: **four paths** (source/receiver and their ground images)
  over the diffracting edge(s), each with the complex **Fresnel knife-edge**
  coefficient of its own path difference along the **convex hull** of the
  obstacles (handles thick tops, berms with crests, several edges), summed
  coherently with the ground reflections on both sides.
- **Lateral diffraction** around the ends of a barrier.
- **Reflections**: image sources up to **2nd order** on every barrier face and
  building façade. Barrier faces are the extruded polygons of the actual
  cross-section, so a face tilted by θ reflects 2θ up or down; overhangs and
  bent tops block or redirect reflected rays (3D occlusion test). Energy
  absorption per face and octave band (EN 1793-1 categories A3/A4 for
  absorptive panels, grass, gabions, wood, concrete/glass, façades).
- **Refraction (weather)**: curved rays of radius R per class (default:
  homogeneous, favourable/downwind R = max(1000 m, 8 d) as in NMPB-2008,
  night inversion, upward refraction), using the curved-ground analogy for
  screening and the CNOSSOS equivalent heights for the ground reflection.
  Results are energy-averaged with the occurrence of each class per period.
  **The default occurrences are estimates** — replace them with local
  statistics.
- **Turbulence**: loss of coherence between paths (Daigle, Gaussian model:
  fills interference dips) and scattering into barrier shadows with the
  Kolmogorov scaling used in Nord2000 (caps what a barrier can achieve).
- **Air absorption**: ISO 9613-1 for the set temperature and humidity.
- Periods D.Lgs. 194/2005: day 06–20, evening 20–22, night 22–06; Lden,
  LAeq 06–22 (DPR 142/2004).

### Wave solver for sections (`core/src/pe.rs`)
Crank–Nicolson **parabolic equation** (wide-angle Padé (1,1)) in the vertical
section: impedance ground, staircase terrain/buildings/barriers, logarithmic
sound-speed profile (neutral, downwind, strong inversion, upwind), turbulence
by random phase screens averaged over realisations. Shown as the pass-by level
of one vehicle; independent of the ray model, so the two can be compared.

### Validation (`core/tests`)
- Faddeeva function and Fresnel integrals against mpmath reference values.
- Knife-edge diffraction against ITU-R P.526 J(v) (±1 dB).
- Ground dip over grass at the classic geometry (hs 0.5 m, hr 1.5 m, 50 m).
- **PE against the analytical spherical-wave solution over grass: within
  0.6 dB at 125–1000 Hz.**
- Line source: ~3 dB per distance doubling over hard ground; plausible
  absolute level (1000 cars/h, 50 km/h, 25 m).
- Walls: more benefit on the ground floor than above the shadow line;
  reflective vertical wall raises the opposite side by ~3 dB, a 15° tilt
  removes that, absorptive panels too; a bent top screens more than a plain
  wall of the same height; every preset screens.
- Downward refraction reduces a wall's insertion loss at 200 m.

## Known limits
- Engineering approximations in the ray model: Deygout-type single hull
  path difference instead of exact wedge solutions; reflections are combined
  incoherently with screening per leg; refraction classes are not
  direction-dependent (no wind rose yet).
- PE is one-way (no back-reflection; walls on the far side of the road
  appear only in the ray model) and fills in under overhangs.
- Façade receivers are free-field (incident) levels, 1 m in front.
- Railway noise is not included.
- It is a planning and comparison tool. For formal assessments cross-check
  with certified software (e.g. CadnaA, SoundPLAN with Nord2000/CNOSSOS) and
  with measurements — receiver points accept measured values.

## Build and run

Needs Rust (with target `wasm32-unknown-unknown`), `wasm-bindgen-cli` 0.2.100
and Node 20+.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100
cd web
npm install
npm run wasm      # builds core → web/src/wasm
npm run dev       # http://localhost:5181
```

```bash
cargo test --release            # physics tests
cargo run --release --example bench
```
