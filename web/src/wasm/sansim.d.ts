/* tslint:disable */
/* eslint-disable */
/**
 * Cross-section polygons for a preset (JSON of PresetParams → JSON of parts).
 */
export function barrier_preset(params: string): string;
/**
 * Parabolic equation for a section (JSON of PeInput → JS object PeOutput).
 */
export function pe_section(input: string): any;
export class WasmEngine {
  free(): void;
  facet_count(): number;
  /**
   * `scene` is the JSON of `SceneInput`; `ground` the terrain heights,
   * row 0 south, as described by `scene.ground`.
   */
  constructor(scene: string, ground: Float32Array);
  /**
   * Levels for receivers. Returns 3 values (Ld, Le, Ln) per receiver, or 8
   * with `lmax` (plus Lmax for light, medium, heavy, moped, moto). Skipped
   * receivers are NaN.
   */
  compute(x: Float64Array, y: Float64Array, h: Float64Array, skip: Uint8Array, lmax: boolean, incident: boolean): Float32Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmengine_free: (a: number, b: number) => void;
  readonly barrier_preset: (a: number, b: number) => [number, number, number, number];
  readonly pe_section: (a: number, b: number) => [number, number, number];
  readonly wasmengine_compute: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
  readonly wasmengine_facet_count: (a: number) => number;
  readonly wasmengine_new: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
