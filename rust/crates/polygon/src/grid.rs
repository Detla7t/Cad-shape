// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

use crate::{Paths, PolygonError, Result};
use i_overlay::i_float::int::point::IntPoint;
use i_overlay::i_shape::int::shape::IntShapes;

/// How far from the origin grid coordinates may reach (offset joins included): 2²⁹ units,
/// half of i_overlay's 32-bit safe range (±2³⁰), leaving room for joins and rounding.
const LIMIT: f64 = (1u64 << 29) as f64;

/// The integer grid booleans and offsets run on: `scale` units per millimetre, the origin a
/// grid point near the input's centre (so a result's coordinates are multiples of 1/`scale`
/// whatever the input's position, and the range is centred on it).
pub(crate) struct Grid {
    scale: f64,
    origin_x: f64,
    origin_y: f64,
}

pub(crate) fn check_scale(scale: f64) -> Result<()> {
    if scale.is_finite() && scale > 0.0 && (1.0 / scale).is_finite() {
        Ok(())
    } else {
        Err(PolygonError::InvalidParameter(
            "the grid scale must be positive and finite",
        ))
    }
}

impl Grid {
    /// A grid for `inputs`, whose coordinates may grow by `reach` mm (an offset's).
    pub(crate) fn new(scale: f64, inputs: &[&Paths], reach: f64) -> Result<Self> {
        check_scale(scale)?;
        let mut min = [f64::INFINITY; 2];
        let mut max = [f64::NEG_INFINITY; 2];
        for paths in inputs {
            for xy in paths.coords().chunks_exact(2) {
                for k in 0..2 {
                    min[k] = min[k].min(xy[k]);
                    max[k] = max[k].max(xy[k]);
                }
            }
        }
        if min[0] > max[0] {
            return Ok(Self {
                scale,
                origin_x: 0.0,
                origin_y: 0.0,
            });
        }
        let origin_x = ((min[0] + max[0]) / 2.0 * scale).round();
        let origin_y = ((min[1] + max[1]) / 2.0 * scale).round();
        let half = (max[0] * scale - origin_x)
            .max(origin_x - min[0] * scale)
            .max(max[1] * scale - origin_y)
            .max(origin_y - min[1] * scale);
        let extent = half / scale + reach;
        if !extent.is_finite() || extent * scale >= LIMIT {
            return Err(PolygonError::OutOfRange {
                extent,
                limit: LIMIT / scale,
            });
        }
        Ok(Self {
            scale,
            origin_x,
            origin_y,
        })
    }

    pub(crate) fn scale(&self) -> f64 {
        self.scale
    }

    #[inline]
    pub(crate) fn point(&self, x: f64, y: f64) -> IntPoint<i32> {
        IntPoint::new(
            ((x * self.scale).round() - self.origin_x) as i32,
            ((y * self.scale).round() - self.origin_y) as i32,
        )
    }

    #[inline]
    pub(crate) fn mm(&self, p: IntPoint<i32>) -> [f64; 2] {
        [
            (p.x as f64 + self.origin_x) / self.scale,
            (p.y as f64 + self.origin_y) / self.scale,
        ]
    }

    /// Closed loops on the grid: repeated points (and a closing repeat) dropped, loops left
    /// with fewer than three points skipped.
    pub(crate) fn contours(&self, paths: &Paths) -> Vec<Vec<IntPoint<i32>>> {
        paths
            .iter()
            .filter_map(|coords| {
                let mut contour: Vec<IntPoint<i32>> = Vec::with_capacity(coords.len() / 2);
                for xy in coords.chunks_exact(2) {
                    let p = self.point(xy[0], xy[1]);
                    if contour.last() != Some(&p) {
                        contour.push(p);
                    }
                }
                while contour.len() > 1 && contour.first() == contour.last() {
                    contour.pop();
                }
                (contour.len() >= 3).then_some(contour)
            })
            .collect()
    }

    /// Appends result shapes as loops: each outer loop, then its holes.
    pub(crate) fn push_shapes(&self, shapes: &IntShapes<i32>, out: &mut Paths) {
        for shape in shapes {
            for contour in shape {
                out.push(contour.iter().map(|&p| self.mm(p)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_origin_is_a_grid_point_so_results_keep_the_absolute_grid() {
        let paths = Paths::from_points(&[vec![[1000.00013, 2.5], [1000.5, 3.0]]]);
        let grid = Grid::new(1e4, &[&paths], 0.0).unwrap();
        let p = grid.point(1000.00013, 2.5);
        assert_eq!(grid.mm(p), [1000.0001, 2.5]);
    }

    #[test]
    fn the_range_is_checked_with_the_reach() {
        let paths = Paths::from_points(&[vec![[0.0, 0.0], [120_000.0, 0.0]]]);
        assert!(matches!(
            Grid::new(1e4, &[&paths], 0.0),
            Err(PolygonError::OutOfRange { .. })
        ));
        let small = Paths::from_points(&[vec![[0.0, 0.0], [1000.0, 0.0]]]);
        assert!(Grid::new(1e4, &[&small], 0.0).is_ok());
        assert!(matches!(
            Grid::new(1e4, &[&small], 60_000.0),
            Err(PolygonError::OutOfRange { .. })
        ));
        assert!(matches!(
            Grid::new(0.0, &[&small], 0.0),
            Err(PolygonError::InvalidParameter(_))
        ));
    }
}
