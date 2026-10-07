// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! Triangles into a Z-map: the highest triangle above each cell centre (the part's top
//! surface as a 3-axis tool sees it). Triangles that are vertical in XY (walls) add nothing —
//! their top edges are shared with the faces around them.

use crate::SimError;
use crate::grid::Grid;

/// Checks a triangle soup: `positions` xyz triples, `indices` three per triangle.
pub fn check_triangles(positions: &[f32], indices: &[u32]) -> Result<(), SimError> {
    if !positions.len().is_multiple_of(3) {
        return Err(SimError::new("positions must be xyz triples"));
    }
    if !indices.len().is_multiple_of(3) {
        return Err(SimError::new("indices must come three per triangle"));
    }
    let count = (positions.len() / 3) as u64;
    if indices.iter().any(|&index| index as u64 >= count) {
        return Err(SimError::new("a triangle index is out of range"));
    }
    if positions.iter().any(|value| !value.is_finite()) {
        return Err(SimError::new("a position is not finite"));
    }
    Ok(())
}

/// Raises `out` (one height per cell, row-major) to the triangles' upper envelope sampled at
/// each cell centre shifted by `(dx, dy)`; cells no triangle covers keep their value.
pub fn rasterize_top(grid: &Grid, positions: &[f32], indices: &[u32], dx: f64, dy: f64, out: &mut [f32]) {
    let point = |index: u32| {
        let k = index as usize * 3;
        (
            positions[k] as f64,
            positions[k + 1] as f64,
            positions[k + 2] as f64,
        )
    };
    for triangle in indices.chunks_exact(3) {
        let (x0, y0, z0) = point(triangle[0]);
        let (x1, y1, z1) = point(triangle[1]);
        let (x2, y2, z2) = point(triangle[2]);
        let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        let scale = ((x1 - x0).abs() + (x2 - x0).abs()) * ((y1 - y0).abs() + (y2 - y0).abs());
        if area.abs() <= 1e-12 * scale.max(1e-300) {
            continue;
        }
        let sign = area.signum();
        let slack = -1e-12 * area.abs();
        let min_x = x0.min(x1).min(x2) - dx;
        let max_x = x0.max(x1).max(x2) - dx;
        let min_y = y0.min(y1).min(y2) - dy;
        let max_y = y0.max(y1).max(y2) - dy;
        let (Some((i0, i1)), Some((j0, j1))) = (grid.columns(min_x, max_x), grid.rows(min_y, max_y)) else {
            continue;
        };
        for j in j0..=j1 {
            let py = grid.center_y(j) + dy;
            for i in i0..=i1 {
                let px = grid.center_x(i) + dx;
                let w0 = sign * ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1));
                let w1 = sign * ((x0 - x2) * (py - y2) - (y0 - y2) * (px - x2));
                let w2 = sign * ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0));
                if w0 < slack || w1 < slack || w2 < slack {
                    continue;
                }
                let z = (w0 * z0 + w1 * z1 + w2 * z2) / (w0 + w1 + w2);
                let cell = &mut out[grid.index(i, j)];
                if z as f32 > *cell {
                    *cell = z as f32;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_a_tilted_square() {
        let grid = Grid::covering(0.0, 0.0, 10.0, 10.0, 1.0).unwrap();
        // z = x / 2 over [2, 8]², two triangles.
        let positions = [2.0, 2.0, 1.0, 8.0, 2.0, 4.0, 8.0, 8.0, 4.0, 2.0, 8.0, 1.0f32];
        let indices = [0, 1, 2, 0, 2, 3u32];
        check_triangles(&positions, &indices).unwrap();
        let mut out = vec![f32::NEG_INFINITY; grid.len()];
        rasterize_top(&grid, &positions, &indices, 0.0, 0.0, &mut out);
        assert_eq!(out[grid.index(0, 0)], f32::NEG_INFINITY);
        assert_eq!(out[grid.index(2, 5)], 1.25);
        assert_eq!(out[grid.index(7, 7)], 3.75);
        assert_eq!(out[grid.index(8, 7)], f32::NEG_INFINITY);
        assert!(check_triangles(&positions, &[0, 1, 9]).is_err());
    }
}
