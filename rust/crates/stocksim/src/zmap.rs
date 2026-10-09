// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! The 3-axis stock: a Z-map — one material column per grid cell, from the stock's bottom up
//! to a stored top height. A straight move of a vertical tool lowers every cell of its swept
//! footprint to the exact lower envelope of the swept profile (`Profile::sweep_low`), row by
//! row over the exact XY span of the swept capsule, skipping 16 × 16 tiles whose highest cell
//! lies below the tool's lowest point. The same pass checks the shank and holder against the
//! material they pass over, and, when a part is set, every lowered cell against the part.

use crate::grid::Grid;
use crate::mesh::{MeshOptions, StockMesh};
use crate::model::{Comparison, Contact, CutReport, GougeReport, MaterialModel, Sweep};
use crate::raster::{check_triangles, rasterize_top};
use crate::tool::Tool;
use crate::{SimError, profile::ProfileKind};

const TILE: usize = 16;

/// A part surface dropping more than this per unit of XY is a wall (about 72°).
const WALL_SLOPE: f64 = 3.0;

/// Tolerances of a Z-map's checks, mm.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ZMapOptions {
    /// A cell cut deeper than this below the part is a gouge. A cut into a part wall is
    /// reported once it goes deeper than the wall slack (`ZMap::wall_slack`) into it.
    pub gouge_tolerance: f64,
    /// Shank or holder interference shallower than this is not a collision.
    pub collision_tolerance: f64,
}

impl Default for ZMapOptions {
    fn default() -> Self {
        Self {
            gouge_tolerance: 0.01,
            collision_tolerance: 0.01,
        }
    }
}

/// The part's top surface on the stock's grid.
#[derive(Clone, Debug)]
pub(crate) struct PartMap {
    /// The highest part triangle above each cell centre (−∞ where there is none).
    pub(crate) top: Vec<f32>,
    /// What a cut is checked against: `top`, or where the part drops away steeply within the
    /// wall slack (`ZMap::wall_slack`), its lower side — so a cell centre at a wall, or inside
    /// a hole the triangulation's chords cut short, is not taken for a gouge.
    pub(crate) guard: Vec<f32>,
}

/// Highest cell per tile, refreshed lazily: heights only fall, so a stale maximum is a valid
/// (conservative) bound.
#[derive(Clone, Debug)]
struct Tiles {
    tx: usize,
    max: Vec<f32>,
    dirty: Vec<bool>,
}

impl Tiles {
    fn new(grid: &Grid, heights: &[f32]) -> Self {
        let tx = grid.nx.div_ceil(TILE);
        let ty = grid.ny.div_ceil(TILE);
        let mut tiles = Self {
            tx,
            max: vec![f32::NEG_INFINITY; tx * ty],
            dirty: vec![true; tx * ty],
        };
        for t in 0..tx * ty {
            tiles.refresh(t, grid, heights);
        }
        tiles
    }

    fn refresh(&mut self, t: usize, grid: &Grid, heights: &[f32]) {
        let (ti, tj) = (t % self.tx, t / self.tx);
        let mut max = f32::NEG_INFINITY;
        for j in tj * TILE..((tj + 1) * TILE).min(grid.ny) {
            let row = &heights[j * grid.nx + ti * TILE..j * grid.nx + ((ti + 1) * TILE).min(grid.nx)];
            for &h in row {
                max = max.max(h);
            }
        }
        self.max[t] = max;
        self.dirty[t] = false;
    }

    fn invalidate(&mut self) {
        self.dirty.iter_mut().for_each(|d| *d = true);
    }
}

/// The material as a Z-map (see the module notes).
#[derive(Clone, Debug)]
pub struct ZMap {
    grid: Grid,
    bottom: f32,
    heights: Vec<f32>,
    tiles: Tiles,
    part: Option<PartMap>,
    options: ZMapOptions,
}

/// The XY interval where the line `y = py` crosses the capsule of `radius` around the segment
/// from `(ax, ay)` along the unit `(ux, uy)` for `len`.
#[inline]
fn capsule_span(ax: f64, ay: f64, ux: f64, uy: f64, len: f64, radius: f64, py: f64) -> Option<(f64, f64)> {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut disc = |cx: f64, cy: f64| {
        let dy = py - cy;
        if dy.abs() <= radius {
            let w = (radius * radius - dy * dy).sqrt();
            lo = lo.min(cx - w);
            hi = hi.max(cx + w);
        }
    };
    disc(ax, ay);
    if len > 0.0 {
        disc(ax + ux * len, ay + uy * len);
        let dy = py - ay;
        // The band 0 ≤ (p − a)·u ≤ len, |(p − a) × u| ≤ radius, crossed by the row.
        let (mut a, mut b) = (f64::NEG_INFINITY, f64::INFINITY);
        if ux.abs() > 1e-12 {
            let (p, q) = ((-dy * uy) / ux, (len - dy * uy) / ux);
            a = a.max(p.min(q));
            b = b.min(p.max(q));
        } else if !(dy * uy >= 0.0 && dy * uy <= len) {
            b = f64::NEG_INFINITY;
        }
        if uy.abs() > 1e-12 {
            let (p, q) = ((dy * ux - radius) / uy, (dy * ux + radius) / uy);
            a = a.max(p.min(q));
            b = b.min(p.max(q));
        } else if (dy * ux).abs() > radius {
            b = f64::NEG_INFINITY;
        }
        if a <= b {
            lo = lo.min(ax + a);
            hi = hi.max(ax + b);
        }
    }
    if lo <= hi { Some((lo, hi)) } else { None }
}

/// A flat disc of radius² `r2` swept along the move: its lowest height above the point
/// (relative to the move's start), if it passes over it.
#[inline]
fn flat_low(e2: f64, s0: f64, len: f64, m: f64, r2: f64) -> Option<f64> {
    if e2 > r2 {
        return None;
    }
    let half = (r2 - e2).sqrt();
    let w_lo = (-s0).max(-half);
    let w_hi = (len - s0).min(half);
    if w_lo > w_hi {
        return None;
    }
    Some(m * s0 + if m >= 0.0 { m * w_lo } else { m * w_hi })
}

/// A move as the collision checks read it: tip height `az + m·s` along the XY travel `s`
/// (`len = 0`: a vertical move from `from_z`, lowest at `az`), and the flute length.
struct Frame {
    az: f64,
    m: f64,
    len: f64,
    from_z: f64,
    flutes: f64,
}

/// How far a column of top `h` reaches into a non-cutting part of the tool — radius² `r2`,
/// starting `offset` above the tip — during the move (≤ 0: it stays clear). Where the flutes
/// reach the cell (`entry`, their first position over it) they clear the column ahead of the
/// part above them, unless it stands higher than the flutes there; the part can still meet the
/// intact column where it passes over the cell before the flutes do (a holder wider than the
/// cutter). Cells the flutes never reach meet the part wherever it passes.
#[inline]
fn interference(h: f64, e2: f64, s0: f64, frame: &Frame, r2: f64, offset: f64, entry: Option<f64>) -> f64 {
    let Some(lowest) = flat_low(e2, s0, frame.len, frame.m, r2) else {
        return 0.0;
    };
    let lowest = frame.az + lowest + offset;
    let Some(entry) = entry else {
        return h - lowest;
    };
    let z_at = |w: f64| {
        if frame.len > 0.0 {
            frame.az + frame.m * (s0 + w)
        } else {
            frame.from_z
        }
    };
    let entry_z = z_at(entry);
    if h > entry_z + frame.flutes {
        return h - lowest;
    }
    let half = (r2 - e2).max(0.0).sqrt();
    let first = (-s0).max(-half);
    if first < entry && frame.len > 0.0 {
        return h - (z_at(first).min(entry_z) + offset);
    }
    0.0
}

impl ZMap {
    /// A box of stock: the grid over `[min.x, max.x] × [min.y, max.y]`, every column from
    /// `min.z` up to `max.z`.
    pub fn new_box(min: [f64; 3], max: [f64; 3], cell: f64) -> Result<Self, SimError> {
        let grid = Grid::covering(min[0], min[1], max[0], max[1], cell)?;
        if !(min[2].is_finite() && max[2].is_finite() && max[2] > min[2]) {
            return Err(SimError::new("the stock box has no height"));
        }
        let heights = vec![max[2] as f32; grid.len()];
        let tiles = Tiles::new(&grid, &heights);
        Ok(Self {
            grid,
            bottom: min[2] as f32,
            heights,
            tiles,
            part: None,
            options: ZMapOptions::default(),
        })
    }

    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    pub fn bottom(&self) -> f32 {
        self.bottom
    }

    pub fn heights(&self) -> &[f32] {
        &self.heights
    }

    pub fn options(&self) -> ZMapOptions {
        self.options
    }

    pub fn set_options(&mut self, options: ZMapOptions) -> Result<(), SimError> {
        if !(options.gouge_tolerance >= 0.0 && options.collision_tolerance >= 0.0) {
            return Err(SimError::new("tolerances must not be negative"));
        }
        if self.part.is_some() && options.gouge_tolerance != self.options.gouge_tolerance {
            // The part's guard samples are taken at the gouge tolerance.
            return Err(SimError::new("set the gouge tolerance before the part"));
        }
        self.options = options;
        Ok(())
    }

    /// Replaces the column heights (row-major, `nx × ny`); each is clamped to the bottom.
    pub fn set_heights(&mut self, heights: &[f32]) -> Result<(), SimError> {
        if heights.len() != self.grid.len() {
            return Err(SimError::new(format!(
                "expected {} heights ({} × {}), got {}",
                self.grid.len(),
                self.grid.nx,
                self.grid.ny,
                heights.len()
            )));
        }
        if heights.iter().any(|h| h.is_nan()) {
            return Err(SimError::new("a height is not a number"));
        }
        for (cell, &h) in self.heights.iter_mut().zip(heights) {
            *cell = h.max(self.bottom);
        }
        self.tiles.invalidate();
        Ok(())
    }

    /// Makes the stock the region under a closed triangulated body's top surface (a casting,
    /// the previous setup's result): cells outside it hold no material.
    pub fn set_stock_triangles(&mut self, positions: &[f32], indices: &[u32]) -> Result<(), SimError> {
        check_triangles(positions, indices)?;
        let mut top = vec![f32::NEG_INFINITY; self.grid.len()];
        rasterize_top(&self.grid, positions, indices, 0.0, 0.0, &mut top);
        let ceiling = self.heights.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        for (cell, h) in self.heights.iter_mut().zip(top) {
            *cell = h.min(ceiling).max(self.bottom);
        }
        self.tiles.invalidate();
        Ok(())
    }

    /// Sets the part the cuts are checked against (gouges) and compared with (excess).
    pub fn set_part_triangles(&mut self, positions: &[f32], indices: &[u32]) -> Result<(), SimError> {
        check_triangles(positions, indices)?;
        let n = self.grid.len();
        let mut top = vec![f32::NEG_INFINITY; n];
        rasterize_top(&self.grid, positions, indices, 0.0, 0.0, &mut top);
        // Sample the part again at the wall slack either side in x and y: where it drops away
        // steeply (a wall) within the slack, a cut is checked against the lower side.
        let slack = self.wall_slack();
        let mut lowest = vec![f32::INFINITY; n];
        let mut sample = vec![f32::NEG_INFINITY; n];
        for (dx, dy) in [(slack, 0.0), (-slack, 0.0), (0.0, slack), (0.0, -slack)] {
            sample.fill(f32::NEG_INFINITY);
            rasterize_top(&self.grid, positions, indices, dx, dy, &mut sample);
            for (low, s) in lowest.iter_mut().zip(&sample) {
                *low = low.min(*s);
            }
        }
        let steep = (WALL_SLOPE * slack) as f32;
        let guard = top
            .iter()
            .zip(&lowest)
            .map(|(&top, &low)| if top - low > steep { low } else { top })
            .collect();
        self.part = Some(PartMap { top, guard });
        Ok(())
    }

    /// How far into a part wall (in XY) a cut may go without being a gouge: half a cell (what
    /// a Z-map resolves, and more than a triangulation's chords stray), or the gouge tolerance
    /// if larger.
    pub fn wall_slack(&self) -> f64 {
        (0.5 * self.grid.cx.min(self.grid.cy)).max(self.options.gouge_tolerance)
    }

    pub fn has_part(&self) -> bool {
        self.part.is_some()
    }

    /// The part's top above each cell (−∞ where none), when a part is set.
    pub fn part_top(&self) -> Option<&[f32]> {
        self.part.as_ref().map(|part| part.top.as_slice())
    }

    /// Signed deviation of a cell from the part: the material left above the part (≥ 0),
    /// or, where a cut went deeper than the tolerance below it, minus the gouge depth. Down
    /// to minus the tolerance is on the part. Without a part below, the material's
    /// thickness; NaN without a part at all.
    #[inline]
    pub fn deviation(&self, index: usize) -> f32 {
        let Some(part) = &self.part else {
            return f32::NAN;
        };
        let h = self.heights[index];
        let top = part.top[index];
        if top == f32::NEG_INFINITY {
            return h - self.bottom;
        }
        let tolerance = self.options.gouge_tolerance as f32;
        let guard = part.guard[index];
        if h < guard - tolerance {
            return h - guard;
        }
        (h - top).max(-tolerance)
    }

    fn tile_max(&mut self, ti: usize, tj: usize) -> f32 {
        let t = tj * self.tiles.tx + ti;
        if self.tiles.dirty[t] {
            self.tiles.refresh(t, &self.grid, &self.heights);
        }
        self.tiles.max[t]
    }

    /// Cuts one straight move of a vertical tool (see the module notes).
    fn cut_vertical(&mut self, tool: &Tool, from: [f64; 3], to: [f64; 3]) -> CutReport {
        let mut report = CutReport::default();
        let [ax, ay, az0] = from;
        let (dx, dy) = (to[0] - ax, to[1] - ay);
        let xy = dx.hypot(dy);
        let z_min = az0.min(to[2]);
        // A move without XY travel is cut from its lower end (the tool passes every height between).
        let (ux, uy, len, m, az) = if xy < 1e-9 {
            (1.0, 0.0, 0.0, 0.0, z_min)
        } else {
            (dx / xy, dy / xy, xy, (to[2] - az0) / xy, az0)
        };
        let reach = tool.reach();
        let radius = tool.radius();
        let profile = tool.profile();
        let r2 = tool.radius() * tool.radius();
        let flat_tool = profile.kind() == ProfileKind::Flat;
        let shank_r2 = tool.has_shank().then(|| tool.shank_radius().powi(2));
        let holder = tool
            .holder()
            .map(|holder| (holder.radius * holder.radius, holder.offset));
        let non_cutting = tool.non_cutting_start();
        let collision_tolerance = self.options.collision_tolerance;
        let gouge_tolerance = self.options.gouge_tolerance;
        let bottom = self.bottom as f64;
        let area = self.grid.cell_area();
        let grid = self.grid;
        let Some((j0, j1)) = grid.rows(ay.min(to[1]) - reach, ay.max(to[1]) + reach) else {
            return report;
        };
        let mut removed = 0.0f64;
        let mut gouge = GougeReport::default();
        for j in j0..=j1 {
            let py = grid.center_y(j);
            let Some((xa, xb)) = capsule_span(ax, ay, ux, uy, len, reach, py) else {
                continue;
            };
            let Some((i0, i1)) = grid.columns(xa, xb) else {
                continue;
            };
            // The columns the cutter itself sweeps (the reach is wider with a shank or holder).
            let cut = if reach > radius {
                capsule_span(ax, ay, ux, uy, len, radius, py).and_then(|(a, b)| grid.columns(a, b))
            } else {
                Some((i0, i1))
            };
            let tj = j / TILE;
            let ry = py - ay;
            let mut i = i0;
            while i <= i1 {
                let ti = i / TILE;
                let end = ((ti + 1) * TILE - 1).min(i1);
                let top = self.tile_max(ti, tj) as f64;
                if top <= z_min {
                    i = end + 1;
                    continue;
                }
                // Below the shank and the holder all over the tile: only the cutter's columns matter.
                let (first, last) = if top <= z_min + non_cutting {
                    match cut {
                        Some((c0, c1)) => (i.max(c0), end.min(c1)),
                        None => (1, 0),
                    }
                } else {
                    (i, end)
                };
                for k in first..=last {
                    let index = j * grid.nx + k;
                    let h = self.heights[index] as f64;
                    if h <= z_min {
                        continue;
                    }
                    let rx = grid.center_x(k) - ax;
                    let s0 = rx * ux + ry * uy;
                    let cross = rx * uy - ry * ux;
                    let e2 = cross * cross;
                    // Where the flutes first reach the cell (in the move's direction), if they do.
                    let entry = if e2 <= r2 {
                        let half = (r2 - e2).sqrt();
                        let (w_lo, w_hi) = ((-s0).max(-half), (len - s0).min(half));
                        (w_lo <= w_hi).then_some(w_lo)
                    } else {
                        None
                    };
                    if h > z_min + non_cutting {
                        let frame = Frame {
                            az,
                            m,
                            len,
                            from_z: az0,
                            flutes: tool.flute_length(),
                        };
                        let at = [grid.center_x(k), py, h];
                        if let Some(r2) = shank_r2 {
                            let depth = interference(h, e2, s0, &frame, r2, frame.flutes, entry);
                            if depth > collision_tolerance {
                                report.shank = Contact::deeper(report.shank, depth, at);
                            }
                        }
                        if let Some((r2, offset)) = holder {
                            let depth = interference(h, e2, s0, &frame, r2, offset, entry);
                            if depth > collision_tolerance {
                                report.holder = Contact::deeper(report.holder, depth, at);
                            }
                        }
                    }
                    if entry.is_none() {
                        continue;
                    }
                    let low = if flat_tool {
                        flat_low(e2, s0, len, m, r2)
                    } else {
                        profile.sweep_low(e2, s0, len, m)
                    };
                    let Some(low) = low else {
                        continue;
                    };
                    let z = (az + low).max(bottom);
                    if z >= h {
                        continue;
                    }
                    let stored = z as f32;
                    self.heights[index] = stored;
                    let t = tj * self.tiles.tx + ti;
                    self.tiles.dirty[t] = true;
                    let depth = h - stored as f64;
                    removed += depth;
                    if depth > report.max_depth {
                        report.max_depth = depth;
                        report.deepest = [grid.center_x(k), py, stored as f64];
                    }
                    if let Some(part) = &self.part {
                        let below = part.guard[index] as f64 - stored as f64;
                        if below > gouge_tolerance {
                            gouge.cells += 1;
                            if below > gouge.depth {
                                gouge.depth = below;
                                gouge.at = [grid.center_x(k), py, stored as f64];
                            }
                        }
                    }
                }
                i = end + 1;
            }
        }
        report.removed = removed * area;
        if gouge.cells > 0 {
            report.gouge = Some(gouge);
        }
        report
    }
}

impl MaterialModel for ZMap {
    type Snapshot = Vec<f32>;

    fn cut(&mut self, tool: &Tool, sweep: &Sweep) -> CutReport {
        if !sweep.is_vertical() {
            return CutReport {
                unsupported: true,
                ..CutReport::default()
            };
        }
        self.cut_vertical(tool, sweep.from, sweep.to)
    }

    fn snapshot(&self) -> Vec<f32> {
        self.heights.clone()
    }

    fn restore(&mut self, snapshot: &Vec<f32>) {
        self.heights.copy_from_slice(snapshot);
        self.tiles.invalidate();
    }

    fn snapshot_bytes(&self) -> usize {
        self.heights.len() * std::mem::size_of::<f32>()
    }

    fn volume(&self) -> f64 {
        let bottom = self.bottom as f64;
        self.heights.iter().map(|&h| h as f64 - bottom).sum::<f64>() * self.grid.cell_area()
    }

    fn mesh(&self, options: &MeshOptions) -> StockMesh {
        crate::mesh::zmap_mesh(self, options)
    }

    fn comparison(&self) -> Option<Comparison> {
        self.part.as_ref()?;
        let area = self.grid.cell_area();
        let mut result = Comparison::default();
        for index in 0..self.heights.len() {
            let deviation = self.deviation(index) as f64;
            if deviation > 0.0 {
                result.excess_volume += deviation * area;
                if deviation > result.max_excess {
                    result.max_excess = deviation;
                }
            } else if deviation < -self.options.gouge_tolerance {
                result.gouge_cells += 1;
                result.gouge_volume -= deviation * area;
                if -deviation > result.max_gouge {
                    result.max_gouge = -deviation;
                    let (i, j) = (index % self.grid.nx, index / self.grid.nx);
                    result.max_gouge_at = [
                        self.grid.center_x(i),
                        self.grid.center_y(j),
                        self.heights[index] as f64,
                    ];
                }
            }
        }
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capsule_spans_match_point_tests() {
        let cases = [
            (0.0, 0.0, 1.0, 0.0, 10.0),
            (1.0, 2.0, 0.6, 0.8, 7.0),
            (1.0, 2.0, 0.0, -1.0, 5.0),
            (3.0, 3.0, 1.0, 0.0, 0.0),
        ];
        for (ax, ay, ux, uy, len) in cases {
            let radius = 2.5;
            for row in -40..=40 {
                let py = ay + row as f64 * 0.25;
                let span = capsule_span(ax, ay, ux, uy, len, radius, py);
                for col in -200..=200 {
                    let px = ax + col as f64 * 0.1;
                    let (rx, ry) = (px - ax, py - ay);
                    let s = (rx * ux + ry * uy).clamp(0.0, len);
                    let d = (rx - s * ux).hypot(ry - s * uy);
                    let inside = d <= radius - 1e-9;
                    let spanned = span.is_some_and(|(a, b)| px >= a - 1e-9 && px <= b + 1e-9);
                    if inside {
                        assert!(spanned, "({px}, {py}) inside but not spanned: {span:?}");
                    }
                    if d > radius + 1e-9 {
                        assert!(!spanned, "({px}, {py}) outside but spanned: {span:?}");
                    }
                }
            }
        }
    }
}
