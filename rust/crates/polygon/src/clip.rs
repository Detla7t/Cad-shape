// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

use crate::boolean::FillRule;
use crate::grid::check_scale;
use crate::{Paths, Result};

/// Which side of a region `clip_polylines` keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Keep {
    /// The parts in the region, its boundary included.
    #[default]
    Inside,
    /// The parts off the region (and off its boundary).
    Outside,
}

/// The parts of open polylines inside (or outside) a region filled by `fill` over its loops.
///
/// Every input polyline yields its own pieces, in order and in its direction, joined across
/// its vertices; crossing or overlapping polylines never merge. Pieces end exactly where the
/// polyline crosses the region's boundary; a stretch running along the boundary counts as
/// inside (when the region lies on either side of it). Points closer than half a grid unit
/// (0.5 / `scale` mm) are merged, and a stretch shorter than that between two crossings goes
/// with the stretch after it, so grazing a region's corner does not split a piece.
pub fn clip_polylines(
    lines: &Paths,
    region: &Paths,
    fill: FillRule,
    keep: Keep,
    scale: f64,
) -> Result<Paths> {
    check_scale(scale)?;
    let eps = 0.5 / scale;
    let index = RegionIndex::new(region);
    let mut clipper = Clipper {
        index: &index,
        fill,
        keep,
        eps,
        stamp: vec![0; index.edges.len()],
        visit: 0,
        params: Vec::new(),
        runs: Vec::new(),
    };
    let mut out = Paths::new();
    for coords in lines.iter() {
        clipper.clip(coords, &mut out);
    }
    Ok(out)
}

#[derive(Clone, Copy)]
struct Edge {
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
}

/// The region's edges, bucketed by horizontal bands.
struct RegionIndex {
    edges: Vec<Edge>,
    bands: Vec<Vec<u32>>,
    y0: f64,
    band_height: f64,
}

impl RegionIndex {
    fn new(region: &Paths) -> Self {
        let mut edges = Vec::new();
        for coords in region.iter() {
            let n = coords.len() / 2;
            if n < 2 {
                continue;
            }
            for i in 0..n {
                let j = (i + 1) % n;
                let (ax, ay, bx, by) = (coords[2 * i], coords[2 * i + 1], coords[2 * j], coords[2 * j + 1]);
                if ax != bx || ay != by {
                    edges.push(Edge { ax, ay, bx, by });
                }
            }
        }
        let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
        for e in &edges {
            min_y = min_y.min(e.ay.min(e.by));
            max_y = max_y.max(e.ay.max(e.by));
        }
        let count = ((edges.len() as f64).sqrt().ceil() as usize).clamp(1, 1024);
        let mut index = Self {
            bands: vec![Vec::new(); count],
            y0: if min_y.is_finite() { min_y } else { 0.0 },
            band_height: if max_y > min_y {
                (max_y - min_y) / count as f64
            } else {
                1.0
            },
            edges,
        };
        for (i, e) in index.edges.iter().enumerate() {
            let (first, last) = index.band_range(e.ay.min(e.by), e.ay.max(e.by));
            for band in &mut index.bands[first..=last] {
                band.push(i as u32);
            }
        }
        index
    }

    fn band(&self, y: f64) -> usize {
        let k = ((y - self.y0) / self.band_height).floor();
        if k <= 0.0 {
            0
        } else {
            (k as usize).min(self.bands.len() - 1)
        }
    }

    fn band_range(&self, min_y: f64, max_y: f64) -> (usize, usize) {
        (self.band(min_y), self.band(max_y))
    }

    /// The winding number of the region's loops around `(x, y)` (a ray towards +x).
    fn winding(&self, x: f64, y: f64) -> i32 {
        let mut winding = 0;
        if self.edges.is_empty() {
            return winding;
        }
        for &i in &self.bands[self.band(y)] {
            let e = &self.edges[i as usize];
            if (e.ay <= y) != (e.by <= y) {
                let at = e.ax + (y - e.ay) * (e.bx - e.ax) / (e.by - e.ay);
                if at > x {
                    winding += if e.by > e.ay { 1 } else { -1 };
                }
            }
        }
        winding
    }

    /// Whether `(x, y)` lies within `eps` of an edge.
    fn on_boundary(&self, x: f64, y: f64, eps: f64) -> bool {
        if self.edges.is_empty() {
            return false;
        }
        let (first, last) = self.band_range(y - eps, y + eps);
        self.bands[first..=last].iter().flatten().any(|&i| {
            let e = &self.edges[i as usize];
            if x < e.ax.min(e.bx) - eps
                || x > e.ax.max(e.bx) + eps
                || y < e.ay.min(e.by) - eps
                || y > e.ay.max(e.by) + eps
            {
                return false;
            }
            segment_distance_sq(x, y, e) <= eps * eps
        })
    }
}

fn segment_distance_sq(x: f64, y: f64, e: &Edge) -> f64 {
    let (dx, dy) = (e.bx - e.ax, e.by - e.ay);
    let length_sq = dx * dx + dy * dy;
    let t = if length_sq > 0.0 {
        (((x - e.ax) * dx + (y - e.ay) * dy) / length_sq).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (px, py) = (e.ax + t * dx - x, e.ay + t * dy - y);
    px * px + py * py
}

struct Clipper<'a> {
    index: &'a RegionIndex,
    fill: FillRule,
    keep: Keep,
    eps: f64,
    /// Per edge: the query that last saw it (an edge sits in several bands).
    stamp: Vec<u32>,
    visit: u32,
    params: Vec<f64>,
    /// The current segment's stretches: (end parameter, kept).
    runs: Vec<(f64, bool)>,
}

impl Clipper<'_> {
    fn clip(&mut self, coords: &[f64], out: &mut Paths) {
        let n = coords.len() / 2;
        let point = |i: usize| [coords[2 * i], coords[2 * i + 1]];
        let mut piece: Vec<[f64; 2]> = Vec::new();
        for i in 1..n {
            let (p, q) = (point(i - 1), point(i));
            let length = (q[0] - p[0]).hypot(q[1] - p[1]);
            if length <= self.eps {
                continue;
            }
            self.classify(p, q, length);
            let mut t0 = 0.0;
            for k in 0..self.runs.len() {
                let (t1, kept) = self.runs[k];
                if kept {
                    if piece.is_empty() || t0 > 0.0 {
                        flush(&mut piece, out, self.eps);
                        piece.push(lerp(p, q, t0));
                    }
                    piece.push(if t1 >= 1.0 { q } else { lerp(p, q, t1) });
                } else {
                    flush(&mut piece, out, self.eps);
                }
                t0 = t1;
            }
        }
        flush(&mut piece, out, self.eps);
    }

    /// Splits segment p→q where it crosses the region's edges into maximal stretches on one
    /// side, into `runs`.
    fn classify(&mut self, p: [f64; 2], q: [f64; 2], length: f64) {
        self.crossings(p, q, length);
        self.runs.clear();
        let mut t0 = 0.0;
        let mut pending = false;
        for k in 0..self.params.len() {
            let t1 = self.params[k];
            if (t1 - t0) * length <= self.eps {
                // Too short to judge: it goes with the next stretch (or the last one).
                pending = true;
                continue;
            }
            let kept = self.kept(p, q, (t0 + t1) / 2.0);
            match self.runs.last_mut() {
                Some(last) if last.1 == kept => last.0 = t1,
                _ => self.runs.push((t1, kept)),
            }
            pending = false;
            t0 = t1;
        }
        if pending || self.runs.is_empty() {
            match self.runs.last_mut() {
                Some(last) => last.0 = 1.0,
                None => {
                    let kept = self.kept(p, q, 0.5);
                    self.runs.push((1.0, kept));
                }
            }
        }
    }

    /// Sorted crossing parameters of p→q with the region's edges, ending with 1.
    fn crossings(&mut self, p: [f64; 2], q: [f64; 2], length: f64) {
        self.params.clear();
        let index = self.index;
        if !index.edges.is_empty() {
            self.visit = self.visit.wrapping_add(1);
            if self.visit == 0 {
                self.stamp.fill(0);
                self.visit = 1;
            }
            let eps = self.eps;
            let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
            let (min_x, max_x) = (p[0].min(q[0]) - eps, p[0].max(q[0]) + eps);
            let (min_y, max_y) = (p[1].min(q[1]) - eps, p[1].max(q[1]) + eps);
            let (first, last) = index.band_range(min_y, max_y);
            for band in &index.bands[first..=last] {
                for &i in band {
                    let i = i as usize;
                    if self.stamp[i] == self.visit {
                        continue;
                    }
                    self.stamp[i] = self.visit;
                    let e = &index.edges[i];
                    if e.ax.max(e.bx) < min_x
                        || e.ax.min(e.bx) > max_x
                        || e.ay.max(e.by) < min_y
                        || e.ay.min(e.by) > max_y
                    {
                        continue;
                    }
                    let (ex, ey) = (e.bx - e.ax, e.by - e.ay);
                    let (wx, wy) = (e.ax - p[0], e.ay - p[1]);
                    let denominator = dx * ey - dy * ex;
                    let edge_length = ex.hypot(ey);
                    if denominator.abs() <= 1e-12 * length * edge_length {
                        // Parallel: where a collinear edge starts and ends along the segment.
                        if (wx * dy - wy * dx).abs() <= eps * length {
                            let along =
                                |x: f64, y: f64| ((x - p[0]) * dx + (y - p[1]) * dy) / (length * length);
                            for t in [along(e.ax, e.ay), along(e.bx, e.by)] {
                                if t > 0.0 && t < 1.0 {
                                    self.params.push(t);
                                }
                            }
                        }
                        continue;
                    }
                    let t = (wx * ey - wy * ex) / denominator;
                    let u = (wx * dy - wy * dx) / denominator;
                    if t > 0.0 && t < 1.0 && (-1e-9..=1.0 + 1e-9).contains(&u) {
                        self.params.push(t);
                    }
                }
            }
        }
        self.params.sort_unstable_by(f64::total_cmp);
        self.params.push(1.0);
    }

    /// Whether the point at `t` along p→q is on the kept side.
    fn kept(&self, p: [f64; 2], q: [f64; 2], t: f64) -> bool {
        let [x, y] = lerp(p, q, t);
        let index = self.index;
        let filled = |x: f64, y: f64| self.fill.fills(index.winding(x, y));
        let inside = if index.on_boundary(x, y, self.eps) {
            // Along the boundary: in the region when either side is.
            let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
            let scale = 2.0 * self.eps / dx.hypot(dy);
            let (nx, ny) = (-dy * scale, dx * scale);
            filled(x + nx, y + ny) || filled(x - nx, y - ny)
        } else {
            filled(x, y)
        };
        inside == (self.keep == Keep::Inside)
    }
}

fn lerp(p: [f64; 2], q: [f64; 2], t: f64) -> [f64; 2] {
    if t <= 0.0 {
        p
    } else {
        [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    }
}

/// Ends a piece: merges points closer than `eps` and keeps it when two points remain.
fn flush(piece: &mut Vec<[f64; 2]>, out: &mut Paths, eps: f64) {
    if piece.is_empty() {
        return;
    }
    let mut kept: Vec<[f64; 2]> = Vec::with_capacity(piece.len());
    for &p in piece.iter() {
        match kept.last() {
            Some(last) if (p[0] - last[0]).hypot(p[1] - last[1]) <= eps => {}
            _ => kept.push(p),
        }
    }
    if kept.len() >= 2 {
        out.push(kept);
    }
    piece.clear();
}
