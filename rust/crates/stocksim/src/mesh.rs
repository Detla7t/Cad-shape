// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! A Z-map as a triangle mesh. The top surface runs through the cell centres (every `step`-th
//! one for a lighter mesh; the outer row and column are pulled out to the stock box's edges):
//!
//! - squares of four equal heights — floors, faced tops, the uncut stock — are merged into
//!   maximal rectangles (with an equal deviation from the part too, so colours stay exact),
//!   two triangles each, with their own vertices facing straight up; neighbouring triangles
//!   meet them only at points on their edges, at the same height, so no cracks open;
//! - steep squares (walls) get their own vertices and flat normals, so edges stay crisp;
//! - everything else shares vertices whose normals are central differences that leave out
//!   steep neighbours (smooth curved surfaces without walls bleeding into them).
//!
//! Vertical side walls (merged along runs of equal height) and a bottom (merged rectangles)
//! close the mesh; squares with no material at all are left out, so through-cuts show as
//! holes. With a part set, every vertex carries the deviation of its cell
//! (`ZMap::deviation`; NaN on the bottom).

use crate::zmap::ZMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeshOptions {
    /// Use every `step`-th cell centre (1 = all).
    pub step: usize,
    /// A square rising more than `crease` × its size is a wall (sharp edges).
    pub crease: f64,
    /// Include the per-vertex deviation (when a part is set).
    pub deviation: bool,
}

impl Default for MeshOptions {
    fn default() -> Self {
        Self {
            step: 1,
            crease: 3.0,
            deviation: true,
        }
    }
}

/// A triangle mesh: xyz positions and normals per vertex, three indices per triangle, and
/// (with a part) the signed deviation per vertex — empty otherwise.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StockMesh {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub deviation: Vec<f32>,
}

impl StockMesh {
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
}

const FLAT: f32 = 1e-5;
const EMPTY: f32 = 1e-4;
const SAME_DEVIATION: f32 = 1e-3;

#[derive(Clone, Copy, PartialEq)]
enum Square {
    Empty,
    Flat,
    Smooth,
    Steep,
}

struct Builder {
    mesh: StockMesh,
    deviation: bool,
}

impl Builder {
    fn vertex(&mut self, p: [f64; 3], n: [f64; 3], deviation: f32) -> u32 {
        let index = (self.mesh.positions.len() / 3) as u32;
        self.mesh
            .positions
            .extend([p[0] as f32, p[1] as f32, p[2] as f32]);
        self.mesh.normals.extend([n[0] as f32, n[1] as f32, n[2] as f32]);
        if self.deviation {
            self.mesh.deviation.push(deviation);
        }
        index
    }

    fn triangle(&mut self, a: u32, b: u32, c: u32) {
        self.mesh.indices.extend([a, b, c]);
    }

    /// A planar quad `p0 p1 p2 p3` (in order around it) facing `normal`.
    fn quad(&mut self, p: [[f64; 3]; 4], normal: [f64; 3], deviation: [f32; 4]) {
        let u = sub(p[1], p[0]);
        let v = sub(p[2], p[0]);
        let facing = dot(cross(u, v), normal) >= 0.0;
        let ids: Vec<u32> = (0..4).map(|k| self.vertex(p[k], normal, deviation[k])).collect();
        if facing {
            self.triangle(ids[0], ids[1], ids[2]);
            self.triangle(ids[0], ids[2], ids[3]);
        } else {
            self.triangle(ids[0], ids[2], ids[1]);
            self.triangle(ids[0], ids[3], ids[2]);
        }
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize(a: [f64; 3]) -> [f64; 3] {
    let n = dot(a, a).sqrt();
    if n > 0.0 {
        [a[0] / n, a[1] / n, a[2] / n]
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// Sample indices along one axis: every `step`-th, always the last, at least two.
fn samples(n: usize, step: usize) -> Vec<usize> {
    let mut out: Vec<usize> = (0..n).step_by(step.max(1)).collect();
    if *out.last().unwrap() != n - 1 {
        out.push(n - 1);
    }
    if out.len() == 1 {
        out.push(out[0]);
    }
    out
}

pub(crate) fn zmap_mesh(zmap: &ZMap, options: &MeshOptions) -> StockMesh {
    let grid = zmap.grid();
    let xs = samples(grid.nx, options.step);
    let ys = samples(grid.ny, options.step);
    let (na, nb) = (xs.len(), ys.len());
    let px: Vec<f64> = (0..na)
        .map(|a| {
            if a == 0 {
                grid.x0
            } else if a == na - 1 {
                grid.max_x()
            } else {
                grid.center_x(xs[a])
            }
        })
        .collect();
    let py: Vec<f64> = (0..nb)
        .map(|b| {
            if b == 0 {
                grid.y0
            } else if b == nb - 1 {
                grid.max_y()
            } else {
                grid.center_y(ys[b])
            }
        })
        .collect();
    let heights = zmap.heights();
    let with_deviation = options.deviation && zmap.has_part();
    let mut h = Vec::with_capacity(na * nb);
    let mut dev = Vec::with_capacity(if with_deviation { na * nb } else { 0 });
    for &j in &ys {
        for &i in &xs {
            let index = grid.index(i, j);
            h.push(heights[index]);
            if with_deviation {
                dev.push(zmap.deviation(index));
            }
        }
    }
    let at = |a: usize, b: usize| h[b * na + a];
    let dev_at = |a: usize, b: usize| if with_deviation { dev[b * na + a] } else { f32::NAN };
    let bottom = zmap.bottom();
    let bottom64 = bottom as f64;
    let empty = |v: f32| v <= bottom + EMPTY;
    let same_dev =
        |x: f32, y: f32| !with_deviation || (x - y).abs() <= SAME_DEVIATION || (x.is_nan() && y.is_nan());
    let crease = options.crease.max(0.1);

    let (sa, sb) = (na - 1, nb - 1);
    let mut class = vec![Square::Empty; sa * sb];
    for b in 0..sb {
        for a in 0..sa {
            let c = [at(a, b), at(a + 1, b), at(a, b + 1), at(a + 1, b + 1)];
            if c.iter().all(|&v| empty(v)) {
                continue;
            }
            let lo = c.iter().copied().fold(f32::INFINITY, f32::min);
            let hi = c.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            let d = [
                dev_at(a, b),
                dev_at(a + 1, b),
                dev_at(a, b + 1),
                dev_at(a + 1, b + 1),
            ];
            let size = (px[a + 1] - px[a]).min(py[b + 1] - py[b]);
            class[b * sa + a] = if hi - lo <= FLAT && d.iter().all(|&x| same_dev(x, d[0])) {
                Square::Flat
            } else if (hi - lo) as f64 > crease * size {
                Square::Steep
            } else {
                Square::Smooth
            };
        }
    }

    let mut out = Builder {
        mesh: StockMesh::default(),
        deviation: with_deviation,
    };
    let up = [0.0, 0.0, 1.0];

    // Flat squares merged into maximal rectangles.
    let mut visited = vec![false; sa * sb];
    for b in 0..sb {
        for a in 0..sa {
            let seed = b * sa + a;
            if visited[seed] || class[seed] != Square::Flat {
                continue;
            }
            let (height, deviation) = (at(a, b), dev_at(a, b));
            let same = |s: usize, visited: &[bool]| {
                let (sa_, sb_) = (s % sa, s / sa);
                class[s] == Square::Flat
                    && !visited[s]
                    && (at(sa_, sb_) - height).abs() <= FLAT
                    && same_dev(dev_at(sa_, sb_), deviation)
            };
            let mut w = 1;
            while a + w < sa && same(seed + w, &visited) {
                w += 1;
            }
            let mut rows = 1;
            'grow: while b + rows < sb {
                for k in 0..w {
                    if !same((b + rows) * sa + a + k, &visited) {
                        break 'grow;
                    }
                }
                rows += 1;
            }
            for r in 0..rows {
                for k in 0..w {
                    visited[(b + r) * sa + a + k] = true;
                }
            }
            let z = height as f64;
            out.quad(
                [
                    [px[a], py[b], z],
                    [px[a + w], py[b], z],
                    [px[a + w], py[b + rows], z],
                    [px[a], py[b + rows], z],
                ],
                up,
                [deviation; 4],
            );
        }
    }

    // Smooth and steep squares.
    let slope = |values: [Option<(f32, f64)>; 2], here: f32| {
        let mut sum = 0.0;
        let mut count = 0;
        for (value, run) in values.into_iter().flatten() {
            let s = (here as f64 - value as f64) / run;
            if s.abs() <= crease {
                sum += s;
                count += 1;
            }
        }
        if count == 0 { 0.0 } else { sum / count as f64 }
    };
    let mut shared = vec![u32::MAX; na * nb];
    let mut shared_vertex = |a: usize, b: usize, out: &mut Builder| -> u32 {
        let k = b * na + a;
        if shared[k] != u32::MAX {
            return shared[k];
        }
        let here = at(a, b);
        let sx = slope(
            [
                (a > 0).then(|| (at(a - 1, b), px[a] - px[a - 1])),
                (a + 1 < na).then(|| (at(a + 1, b), px[a] - px[a + 1])),
            ],
            here,
        );
        let sy = slope(
            [
                (b > 0).then(|| (at(a, b - 1), py[b] - py[b - 1])),
                (b + 1 < nb).then(|| (at(a, b + 1), py[b] - py[b + 1])),
            ],
            here,
        );
        let index = out.vertex(
            [px[a], py[b], here as f64],
            normalize([-sx, -sy, 1.0]),
            dev_at(a, b),
        );
        shared[k] = index;
        index
    };
    for b in 0..sb {
        for a in 0..sa {
            let kind = class[b * sa + a];
            if kind != Square::Smooth && kind != Square::Steep {
                continue;
            }
            let corner = |a: usize, b: usize| [px[a], py[b], at(a, b) as f64];
            let (h00, h10, h01, h11) = (at(a, b), at(a + 1, b), at(a, b + 1), at(a + 1, b + 1));
            // Split along the diagonal whose ends are closer in height.
            let triangles: [[(usize, usize); 3]; 2] = if (h00 - h11).abs() <= (h10 - h01).abs() {
                [
                    [(a, b), (a + 1, b), (a + 1, b + 1)],
                    [(a, b), (a + 1, b + 1), (a, b + 1)],
                ]
            } else {
                [
                    [(a, b), (a + 1, b), (a, b + 1)],
                    [(a + 1, b), (a + 1, b + 1), (a, b + 1)],
                ]
            };
            for triangle in triangles {
                if triangle.iter().all(|&(a, b)| empty(at(a, b))) {
                    continue;
                }
                if kind == Square::Smooth {
                    let ids = triangle.map(|(a, b)| shared_vertex(a, b, &mut out));
                    out.triangle(ids[0], ids[1], ids[2]);
                } else {
                    let p = triangle.map(|(a, b)| corner(a, b));
                    let normal = normalize(cross(sub(p[1], p[0]), sub(p[2], p[0])));
                    let ids =
                        [0, 1, 2].map(|k| out.vertex(p[k], normal, dev_at(triangle[k].0, triangle[k].1)));
                    out.triangle(ids[0], ids[1], ids[2]);
                }
            }
        }
    }

    // Side walls, merged along runs of equal height.
    type Side = (Vec<(usize, usize)>, [f64; 3]);
    let sides: [Side; 4] = [
        ((0..na).map(|a| (a, 0)).collect(), [0.0, -1.0, 0.0]),
        ((0..na).map(|a| (a, nb - 1)).collect(), [0.0, 1.0, 0.0]),
        ((0..nb).map(|b| (0, b)).collect(), [-1.0, 0.0, 0.0]),
        ((0..nb).map(|b| (na - 1, b)).collect(), [1.0, 0.0, 0.0]),
    ];
    for (points, normal) in sides {
        let n = points.len();
        let mut k = 0;
        while k + 1 < n {
            let (p, q) = (points[k], points[k + 1]);
            let (hp, hq) = (at(p.0, p.1), at(q.0, q.1));
            if empty(hp) && empty(hq) {
                k += 1;
                continue;
            }
            let mut l = k + 1;
            let dp = dev_at(p.0, p.1);
            if (hp - hq).abs() <= FLAT && same_dev(dp, dev_at(q.0, q.1)) {
                while l + 1 < n {
                    let next = points[l + 1];
                    if (at(next.0, next.1) - hp).abs() > FLAT || !same_dev(dev_at(next.0, next.1), dp) {
                        break;
                    }
                    l += 1;
                }
            }
            let q = points[l];
            let hq = at(q.0, q.1);
            let dq = dev_at(q.0, q.1);
            out.quad(
                [
                    [px[p.0], py[p.1], bottom64],
                    [px[q.0], py[q.1], bottom64],
                    [px[q.0], py[q.1], hq as f64],
                    [px[p.0], py[p.1], hp as f64],
                ],
                normal,
                [dp, dq, dq, dp],
            );
            k = l;
        }
    }

    // The bottom under every square holding material.
    let mut covered = vec![false; sa * sb];
    for b in 0..sb {
        for a in 0..sa {
            let seed = b * sa + a;
            if covered[seed] || class[seed] == Square::Empty {
                continue;
            }
            let open = |s: usize, covered: &[bool]| class[s] != Square::Empty && !covered[s];
            let mut w = 1;
            while a + w < sa && open(seed + w, &covered) {
                w += 1;
            }
            let mut rows = 1;
            'grow: while b + rows < sb {
                for k in 0..w {
                    if !open((b + rows) * sa + a + k, &covered) {
                        break 'grow;
                    }
                }
                rows += 1;
            }
            for r in 0..rows {
                for k in 0..w {
                    covered[(b + r) * sa + a + k] = true;
                }
            }
            out.quad(
                [
                    [px[a], py[b], bottom64],
                    [px[a + w], py[b], bottom64],
                    [px[a + w], py[b + rows], bottom64],
                    [px[a], py[b + rows], bottom64],
                ],
                [0.0, 0.0, -1.0],
                [f32::NAN; 4],
            );
        }
    }
    out.mesh
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::MaterialModel;

    #[test]
    fn an_uncut_box_is_twelve_triangles_and_closed() {
        let zmap = ZMap::new_box([0.0, 0.0, -10.0], [40.0, 30.0, 0.0], 0.5).unwrap();
        let mesh = zmap.mesh(&MeshOptions::default());
        // Top, bottom and four sides: two triangles each.
        assert_eq!(mesh.triangle_count(), 12);
        assert!(mesh.deviation.is_empty());
        let xs: Vec<f32> = mesh.positions.chunks(3).map(|p| p[0]).collect();
        assert_eq!(xs.iter().copied().fold(f32::INFINITY, f32::min), 0.0);
        assert_eq!(xs.iter().copied().fold(f32::NEG_INFINITY, f32::max), 40.0);
        // Closed: the signed volume of the triangles is the box's.
        let p = |k: u32| {
            let k = k as usize * 3;
            [
                mesh.positions[k] as f64,
                mesh.positions[k + 1] as f64,
                mesh.positions[k + 2] as f64,
            ]
        };
        let volume: f64 = mesh
            .indices
            .chunks(3)
            .map(|t| dot(p(t[0]), cross(p(t[1]), p(t[2]))) / 6.0)
            .sum::<f64>()
            .abs();
        assert!((volume - 12_000.0).abs() < 1e-6, "{volume}");
    }
}
