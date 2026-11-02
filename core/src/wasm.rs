//! Browser bindings (wasm-bindgen). Each web worker holds one `WasmEngine`.

use crate::barrier::{preset, PresetParams};
use crate::engine::{Engine, Options, Scratch};
use crate::pe::{solve, PeInput};
use crate::scene::{Scene, SceneInput};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmEngine {
    engine: Engine,
    scratch: Scratch,
}

#[wasm_bindgen]
impl WasmEngine {
    /// `scene` is the JSON of `SceneInput`; `ground` the terrain heights,
    /// row 0 south, as described by `scene.ground`.
    #[wasm_bindgen(constructor)]
    pub fn new(scene: &str, ground: Vec<f32>) -> Result<WasmEngine, JsError> {
        let input: SceneInput = serde_json::from_str(scene).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmEngine { engine: Engine::new(Scene::build(input, ground)), scratch: Scratch::default() })
    }

    /// Levels for receivers. Returns 3 values (Ld, Le, Ln) per receiver, or 8
    /// with `lmax` (plus Lmax for light, medium, heavy, moped, moto). Skipped
    /// receivers are NaN.
    pub fn compute(&mut self, x: &[f64], y: &[f64], h: &[f64], skip: &[u8], lmax: bool, incident: bool) -> Vec<f32> {
        let stride = if lmax { 8 } else { 3 };
        let mut out = vec![f32::NAN; x.len() * stride];
        let opts = Options { lmax, incident, ..Default::default() };
        for i in 0..x.len() {
            if skip.get(i).copied().unwrap_or(0) != 0 {
                continue;
            }
            let r = self.engine.compute(x[i], y[i], h[i], opts, &mut self.scratch);
            let l = r.levels();
            out[i * stride] = l[0] as f32;
            out[i * stride + 1] = l[1] as f32;
            out[i * stride + 2] = l[2] as f32;
            if lmax {
                for c in 0..5 {
                    out[i * stride + 3 + c] = r.lmax[c] as f32;
                }
            }
        }
        out
    }

    pub fn facet_count(&self) -> usize {
        self.engine.scene.facets.len()
    }
}

/// Cross-section polygons for a preset (JSON of PresetParams → JSON of parts).
#[wasm_bindgen]
pub fn barrier_preset(params: &str) -> Result<String, JsError> {
    let p: PresetParams = serde_json::from_str(params).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&preset(&p)).map_err(|e| JsError::new(&e.to_string()))
}

/// Parabolic equation for a section (JSON of PeInput → JS object PeOutput).
#[wasm_bindgen]
pub fn pe_section(input: &str) -> Result<JsValue, JsError> {
    let p: PeInput = serde_json::from_str(input).map_err(|e| JsError::new(&e.to_string()))?;
    let out = solve(&p);
    serde_wasm_bindgen::to_value(&out).map_err(|e| JsError::new(&e.to_string()))
}
