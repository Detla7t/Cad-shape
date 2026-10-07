// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

use crate::grid::{Grid, check_scale};
use crate::{Paths, PolygonError, Result};
use core::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};
use i_overlay::i_float::int::angle::Angle;
use i_overlay::i_float::int::point::IntPoint;
use i_overlay::mesh::int::arc::ArcOptions;
use i_overlay::mesh::int::outline::offset::IntOutlineOffset;
use i_overlay::mesh::int::style::{IntLineJoin, IntOutlineStyle};
use i_overlay::mesh::math::MathMode;

/// How an offset closes the gap at a convex corner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Join {
    /// An arc around the corner, as chords within `tolerance` mm of it: every vertex lies
    /// exactly the offset distance from the input.
    Round { tolerance: f64 },
    /// The offset edges extended to meet; a corner whose mitre would reach further than
    /// `limit` × the distance from the vertex is cut square where its sides reach that far.
    /// Turns under 5° are bevelled (a mitre there hangs on rounding).
    Miter { limit: f64 },
    /// A straight chord across the corner.
    Bevel,
}

/// Offsets closed loops by `delta` mm: positive grows the filled region (outer loops move out,
/// holes shrink), negative shrinks it. Roles follow orientation, like the results of
/// [`crate::boolean`]: counter-clockwise loops bound material, clockwise loops are holes. Loops
/// may overlap; the offsets are united (positive fill), so a loop thinner than twice an inward
/// offset vanishes and a waist splits in two. Result vertices within a grid unit of the chord
/// around them are dropped, so offsetting an offset again does not pile up vertices (every kept
/// vertex is still exactly where the offset put it).
pub fn offset(loops: &Paths, delta: f64, join: Join, scale: f64) -> Result<Paths> {
    if !delta.is_finite() {
        return Err(PolygonError::InvalidParameter(
            "the offset distance must be finite",
        ));
    }
    check_scale(scale)?;
    let distance = delta.abs();
    let (join, reach) = match join {
        Join::Bevel => (IntLineJoin::Bevel, distance),
        Join::Round { tolerance } => {
            if !(tolerance.is_finite() && tolerance > 0.0) {
                return Err(PolygonError::InvalidParameter(
                    "the round-join tolerance must be positive and finite",
                ));
            }
            let options = ArcOptions {
                max_step: Angle::from_radians(arc_step(distance, tolerance)).unwrap_or(ArcOptions::MAX_STEP),
                ..ArcOptions::default()
            };
            (IntLineJoin::Round(options), distance)
        }
        Join::Miter { limit } => {
            if !(limit.is_finite() && limit > 0.0) {
                return Err(PolygonError::InvalidParameter(
                    "the mitre limit must be positive and finite",
                ));
            }
            // The interior angle below which the mitre reaches past `limit` × distance.
            let angle = if limit > 1.0 {
                2.0 * (1.0 / limit).asin()
            } else {
                PI
            };
            let angle = Angle::from_radians(angle).unwrap_or(Angle::HALF_TURN);
            (IntLineJoin::Miter(angle), distance * limit.max(1.0))
        }
    };
    let grid = Grid::new(scale, &[loops], reach + 4.0 / scale)?;
    let distance = (delta * grid.scale()).round() as i32;
    // A loop its offset shrinks (an outer boundary moving in, a hole closing) vanishes when it is
    // no wider than twice the distance; skip it rather than resolve its offset's tangle.
    let contours: Vec<_> = grid
        .contours(loops)
        .into_iter()
        .filter(|contour| !vanishes(contour, distance))
        .collect();
    let mut out = Paths::new();
    if contours.is_empty() {
        return Ok(out);
    }
    let style = IntOutlineStyle::new(distance)
        .line_join(join)
        .math(MathMode::Float);
    let mut shapes = contours
        .outline(&style)
        .map_err(|_| PolygonError::InvalidParameter("the offset leaves the grid's range"))?;
    for shape in &mut shapes {
        for contour in shape.iter_mut() {
            simplify_closed(contour, SIMPLIFY_UNITS);
        }
        if shape.first().is_some_and(|outer| outer.len() < 3) {
            shape.clear();
        }
        shape.retain(|contour| contour.len() >= 3);
    }
    grid.push_shapes(&shapes, &mut out);
    Ok(out)
}

/// Offset results drop vertices within this many grid units of their neighbours' chord.
/// A join at a turn below the arc step is a chord, which adds a vertex: without this, every
/// offset of a curved loop would double its vertices (ring after ring of a pocket), until edges
/// a grid unit long turn their offsets into tangles.
const SIMPLIFY_UNITS: f64 = 1.0;

/// Whether a loop's offset by `distance` grid units shrinks it to nothing.
fn vanishes(contour: &[IntPoint<i32>], distance: i32) -> bool {
    let mut twice_area = 0i64;
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for (i, p) in contour.iter().enumerate() {
        let q = contour[(i + 1) % contour.len()];
        twice_area += p.x as i64 * q.y as i64 - q.x as i64 * p.y as i64;
        (min_x, min_y, max_x, max_y) = (min_x.min(p.x), min_y.min(p.y), max_x.max(p.x), max_y.max(p.y));
    }
    let shrinks = (twice_area > 0 && distance < 0) || (twice_area < 0 && distance > 0);
    let reach = 2 * (distance as i64).abs();
    shrinks && ((max_x as i64 - min_x as i64) <= reach || (max_y as i64 - min_y as i64) <= reach)
}

/// Douglas–Peucker on a closed contour: vertices within `epsilon` of the chord between the
/// vertices kept around them go. Anchored at the lowest-leftmost vertex (a hull corner) and
/// the vertex farthest from it; the kept vertices are a subset, in order.
fn simplify_closed(contour: &mut Vec<IntPoint<i32>>, epsilon: f64) {
    let n = contour.len();
    if n <= 3 {
        return;
    }
    let at = |i: usize| contour[i % n];
    let start = (0..n).min_by_key(|&i| (contour[i].y, contour[i].x)).unwrap_or(0);
    let far = (0..n)
        .max_by_key(|&i| contour[i].sqr_distance(contour[start]))
        .unwrap_or(0);
    let far = if far < start { far + n } else { far };
    let mut keep = vec![false; n];
    keep[start] = true;
    keep[far % n] = true;
    let mut stack = vec![(start, far), (far, start + n)];
    while let Some((a, b)) = stack.pop() {
        let (pa, pb) = (at(a), at(b));
        let (dx, dy) = ((pb.x - pa.x) as f64, (pb.y - pa.y) as f64);
        let length_sq = dx * dx + dy * dy;
        let mut best = (epsilon * epsilon, usize::MAX);
        for k in a + 1..b {
            let p = at(k);
            let (px, py) = ((p.x - pa.x) as f64, (p.y - pa.y) as f64);
            let t = if length_sq > 0.0 {
                ((px * dx + py * dy) / length_sq).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (ex, ey) = (px - t * dx, py - t * dy);
            let d = ex * ex + ey * ey;
            if d > best.0 {
                best = (d, k);
            }
        }
        if best.1 != usize::MAX {
            keep[best.1 % n] = true;
            stack.push((a, best.1));
            stack.push((best.1, b));
        }
    }
    let mut i = 0;
    contour.retain(|_| {
        i += 1;
        keep[i - 1]
    });
}

/// The largest angle between round-join points whose chords stay within `tolerance` of an arc
/// of `radius` (i_overlay keeps steps between 0.35° and 45°).
fn arc_step(radius: f64, tolerance: f64) -> f64 {
    if radius <= tolerance {
        FRAC_PI_2
    } else {
        (2.0 * (1.0 - tolerance / radius).acos()).min(FRAC_PI_4)
    }
}
