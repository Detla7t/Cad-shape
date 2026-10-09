// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! The regular XY grid a Z-map samples: `nx × ny` cells over a rectangle, each sampled at its
//! centre. Cells are as close to the requested size as divides the rectangle exactly (so the
//! grid covers the stock box with no overhang and volumes add up).

use crate::SimError;

/// The most cells a grid may have (64 MiB of heights).
pub const MAX_CELLS: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub x0: f64,
    pub y0: f64,
    /// Cell size along x and y (each at most the requested size).
    pub cx: f64,
    pub cy: f64,
    pub nx: usize,
    pub ny: usize,
}

impl Grid {
    /// Cells of at most `cell` covering `[min_x, max_x] × [min_y, max_y]` exactly.
    pub fn covering(min_x: f64, min_y: f64, max_x: f64, max_y: f64, cell: f64) -> Result<Self, SimError> {
        if ![min_x, min_y, max_x, max_y, cell].iter().all(|v| v.is_finite()) {
            return Err(SimError::new("the stock box and cell size must be finite"));
        }
        if cell <= 0.0 {
            return Err(SimError::new("the cell size must be positive"));
        }
        let (w, h) = (max_x - min_x, max_y - min_y);
        if !(w > 0.0 && h > 0.0) {
            return Err(SimError::new("the stock box is empty"));
        }
        let nx = (w / cell - 1e-9).ceil().max(1.0);
        let ny = (h / cell - 1e-9).ceil().max(1.0);
        if nx * ny > MAX_CELLS as f64 {
            return Err(SimError::new(format!(
                "{} × {} cells is too fine for the stock: use a cell size of at least {:.3} mm",
                nx,
                ny,
                (w * h / MAX_CELLS as f64).sqrt()
            )));
        }
        let (nx, ny) = (nx as usize, ny as usize);
        Ok(Self {
            x0: min_x,
            y0: min_y,
            cx: w / nx as f64,
            cy: h / ny as f64,
            nx,
            ny,
        })
    }

    pub fn len(&self) -> usize {
        self.nx * self.ny
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn cell_area(&self) -> f64 {
        self.cx * self.cy
    }

    pub fn max_x(&self) -> f64 {
        self.x0 + self.cx * self.nx as f64
    }

    pub fn max_y(&self) -> f64 {
        self.y0 + self.cy * self.ny as f64
    }

    #[inline]
    pub fn center_x(&self, i: usize) -> f64 {
        self.x0 + (i as f64 + 0.5) * self.cx
    }

    #[inline]
    pub fn center_y(&self, j: usize) -> f64 {
        self.y0 + (j as f64 + 0.5) * self.cy
    }

    #[inline]
    pub fn index(&self, i: usize, j: usize) -> usize {
        j * self.nx + i
    }

    /// The columns whose centres lie in `[a, b]`, if any.
    #[inline]
    pub fn columns(&self, a: f64, b: f64) -> Option<(usize, usize)> {
        span(a, b, self.x0, self.cx, self.nx)
    }

    /// The rows whose centres lie in `[a, b]`, if any.
    #[inline]
    pub fn rows(&self, a: f64, b: f64) -> Option<(usize, usize)> {
        span(a, b, self.y0, self.cy, self.ny)
    }

    /// The cell containing a point (clamped to the grid).
    pub fn cell_of(&self, x: f64, y: f64) -> (usize, usize) {
        let i = ((x - self.x0) / self.cx).floor().clamp(0.0, (self.nx - 1) as f64) as usize;
        let j = ((y - self.y0) / self.cy).floor().clamp(0.0, (self.ny - 1) as f64) as usize;
        (i, j)
    }
}

#[inline]
fn span(a: f64, b: f64, origin: f64, size: f64, n: usize) -> Option<(usize, usize)> {
    let lo = ((a - origin) / size - 0.5 - 1e-9).ceil();
    let hi = ((b - origin) / size - 0.5 + 1e-9).floor();
    if lo.is_nan() || hi.is_nan() || lo > hi || hi < 0.0 || lo > (n - 1) as f64 {
        return None;
    }
    Some((lo.max(0.0) as usize, hi.min((n - 1) as f64) as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_the_box_exactly() {
        let grid = Grid::covering(-5.0, 0.0, 45.0, 30.1, 0.25).unwrap();
        assert_eq!(grid.nx, 200);
        assert_eq!(grid.ny, 121);
        assert!((grid.max_y() - 30.1).abs() < 1e-12 && grid.cy <= 0.25);
        assert_eq!(grid.columns(-5.0, -4.8), Some((0, 0)));
        assert_eq!(grid.columns(-5.0, -4.9), None);
        assert_eq!(grid.columns(-10.0, -6.0), None);
        assert_eq!(grid.columns(44.0, 100.0), Some((196, 199)));
        assert!(Grid::covering(0.0, 0.0, 0.0, 1.0, 0.1).is_err());
        assert!(Grid::covering(0.0, 0.0, 1e4, 1e4, 0.001).is_err());
    }
}
