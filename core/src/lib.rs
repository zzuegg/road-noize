//! sansim — outdoor road traffic noise propagation.
//!
//! See the README for the model. Modules:
//! - `emission`   CNOSSOS-EU road emission
//! - `ground`     impedance ground, spherical-wave reflection coefficient
//! - `special`    Faddeeva function, Fresnel integrals, knife-edge diffraction
//! - `turbulence` coherence loss and shadow-zone scattering
//! - `barrier`    barriers of any cross-section, presets, materials
//! - `geometry`   facets, image sources, occlusion
//! - `scene`      input format and scene preparation
//! - `path`       one path under one propagation condition
//! - `iso9613`    ISO 9613-2 general method (standards mode)
//! - `engine`     receivers: direct, lateral, reflections up to order 2
//! - `pe`         Crank–Nicolson parabolic equation for vertical sections

pub mod bands;
pub mod barrier;
pub mod emission;
pub mod engine;
pub mod geometry;
pub mod ground;
pub mod iso9613;
pub mod path;
pub mod pe;
pub mod raster;
pub mod scene;
pub mod special;
pub mod turbulence;

#[cfg(feature = "wasm")]
pub mod wasm;
