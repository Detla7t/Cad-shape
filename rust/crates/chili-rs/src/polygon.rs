// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! Bindings of the `polygon` crate. Paths cross as a `Float64Array` of flat coordinates
//! (x0, y0, x1, y1, …) and a `Uint32Array` of point counts per path; results come back in
//! the same layout inside a `PolygonPaths`, whose arrays the caller takes before freeing it.
//! Enumerations are their names: fill rules `evenOdd` / `nonZero` / `positive` / `negative`,
//! operations `union` / `difference` / `intersection` / `xor`, joins `round` (parameter: chord
//! tolerance, mm) / `miter` (parameter: limit, × distance) / `bevel`, sides `inside` / `outside`.
//! `scale` is the integer grid, units per millimetre.

use ::polygon::{BooleanOp, FillRule, Join, Keep, Paths, PolygonError};
use wasm_bindgen::prelude::*;

/// Result paths, flat. `take_coords` / `take_lengths` move the arrays out.
#[wasm_bindgen]
pub struct PolygonPaths {
    coords: Vec<f64>,
    lengths: Vec<u32>,
}

#[wasm_bindgen]
impl PolygonPaths {
    pub fn take_coords(&mut self) -> Vec<f64> {
        core::mem::take(&mut self.coords)
    }

    pub fn take_lengths(&mut self) -> Vec<u32> {
        core::mem::take(&mut self.lengths)
    }
}

impl From<Paths> for PolygonPaths {
    fn from(paths: Paths) -> Self {
        let (coords, lengths) = paths.into_parts();
        Self { coords, lengths }
    }
}

/// A containment tree: loop indices by decreasing area, and per loop its parent (-1: none) and depth.
#[wasm_bindgen]
pub struct PolygonNesting {
    order: Vec<u32>,
    parent: Vec<i32>,
    depth: Vec<u32>,
}

#[wasm_bindgen]
impl PolygonNesting {
    pub fn take_order(&mut self) -> Vec<u32> {
        core::mem::take(&mut self.order)
    }

    pub fn take_parent(&mut self) -> Vec<i32> {
        core::mem::take(&mut self.parent)
    }

    pub fn take_depth(&mut self) -> Vec<u32> {
        core::mem::take(&mut self.depth)
    }
}

fn error(error: PolygonError) -> JsError {
    JsError::new(&error.to_string())
}

fn paths(coords: Vec<f64>, lengths: Vec<u32>) -> Result<Paths, JsError> {
    Paths::from_flat(coords, lengths).map_err(error)
}

fn fill_rule(name: &str) -> Result<FillRule, JsError> {
    match name {
        "evenOdd" => Ok(FillRule::EvenOdd),
        "nonZero" => Ok(FillRule::NonZero),
        "positive" => Ok(FillRule::Positive),
        "negative" => Ok(FillRule::Negative),
        _ => Err(JsError::new(&format!("unknown fill rule \"{name}\""))),
    }
}

/// A boolean of two regions, each filled by its fill rule: clean loops, outer boundaries
/// counter-clockwise each followed by its (clockwise) holes.
#[wasm_bindgen]
pub fn polygon_boolean(
    op: &str,
    subject_coords: Vec<f64>,
    subject_lengths: Vec<u32>,
    clip_coords: Vec<f64>,
    clip_lengths: Vec<u32>,
    fill: &str,
    scale: f64,
) -> Result<PolygonPaths, JsError> {
    let op = match op {
        "union" => BooleanOp::Union,
        "difference" => BooleanOp::Difference,
        "intersection" => BooleanOp::Intersection,
        "xor" => BooleanOp::Xor,
        _ => return Err(JsError::new(&format!("unknown boolean operation \"{op}\""))),
    };
    let subject = paths(subject_coords, subject_lengths)?;
    let clip = paths(clip_coords, clip_lengths)?;
    ::polygon::boolean(op, &subject, &clip, fill_rule(fill)?, scale)
        .map(Into::into)
        .map_err(error)
}

/// Closed loops offset by `delta` mm (positive grows the region; roles by orientation).
#[wasm_bindgen]
pub fn polygon_offset(
    coords: Vec<f64>,
    lengths: Vec<u32>,
    delta: f64,
    join: &str,
    join_parameter: f64,
    scale: f64,
) -> Result<PolygonPaths, JsError> {
    let join = match join {
        "round" => Join::Round {
            tolerance: join_parameter,
        },
        "miter" => Join::Miter {
            limit: join_parameter,
        },
        "bevel" => Join::Bevel,
        _ => return Err(JsError::new(&format!("unknown join \"{join}\""))),
    };
    ::polygon::offset(&paths(coords, lengths)?, delta, join, scale)
        .map(Into::into)
        .map_err(error)
}

/// The parts of open polylines inside (or outside) a region filled by `fill`.
#[wasm_bindgen]
pub fn polygon_clip_polylines(
    line_coords: Vec<f64>,
    line_lengths: Vec<u32>,
    region_coords: Vec<f64>,
    region_lengths: Vec<u32>,
    fill: &str,
    keep: &str,
    scale: f64,
) -> Result<PolygonPaths, JsError> {
    let keep = match keep {
        "inside" => Keep::Inside,
        "outside" => Keep::Outside,
        _ => return Err(JsError::new(&format!("unknown side \"{keep}\""))),
    };
    let lines = paths(line_coords, line_lengths)?;
    let region = paths(region_coords, region_lengths)?;
    ::polygon::clip_polylines(&lines, &region, fill_rule(fill)?, keep, scale)
        .map(Into::into)
        .map_err(error)
}

/// How closed loops nest (containment, any orientation).
#[wasm_bindgen]
pub fn polygon_nesting(coords: Vec<f64>, lengths: Vec<u32>) -> Result<PolygonNesting, JsError> {
    let nesting = ::polygon::nesting(&paths(coords, lengths)?);
    Ok(PolygonNesting {
        order: nesting.order,
        parent: nesting.parent,
        depth: nesting.depth,
    })
}
