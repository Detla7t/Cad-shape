// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

use crate::Paths;
use crate::paths::signed_area;

/// How closed loops nest: the containment tree of loops that do not cross one another (outer
/// boundaries, their holes, islands in the holes, …). Loops keep their points; nothing is
/// re-noded or united.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Nesting {
    /// The loops by decreasing area (ties in input order), without degenerate ones (fewer than
    /// three points, or no area).
    pub order: Vec<u32>,
    /// Per input loop: the index of the smallest larger loop containing it, or -1.
    pub parent: Vec<i32>,
    /// Per input loop: how many loops contain it (even for material boundaries, odd for holes
    /// by the even-odd rule; 0 for degenerate loops).
    pub depth: Vec<u32>,
}

struct Item<'a> {
    coords: &'a [f64],
    area: f64,
    min: [f64; 2],
    max: [f64; 2],
}

/// The containment tree of `loops` (any orientation). A loop lies inside another when most of
/// its vertices do (vertices on the other's boundary abstain), so loops that touch or graze one
/// another still nest.
pub fn nesting(loops: &Paths) -> Nesting {
    let mut magnitude: f64 = 1.0;
    let items: Vec<Item> = loops
        .iter()
        .map(|coords| {
            let mut min = [f64::INFINITY; 2];
            let mut max = [f64::NEG_INFINITY; 2];
            for xy in coords.chunks_exact(2) {
                for k in 0..2 {
                    min[k] = min[k].min(xy[k]);
                    max[k] = max[k].max(xy[k]);
                    magnitude = magnitude.max(xy[k].abs());
                }
            }
            Item {
                coords,
                area: signed_area(coords).abs(),
                min,
                max,
            }
        })
        .collect();
    let eps = magnitude * 1e-10;
    let n = items.len();
    let mut order: Vec<usize> = (0..n)
        .filter(|&i| items[i].coords.len() >= 6 && items[i].area > 0.0)
        .collect();
    order.sort_by(|&a, &b| items[b].area.total_cmp(&items[a].area));
    let mut parent = vec![-1i32; n];
    let mut depth = vec![0u32; n];
    for k in 0..order.len() {
        let i = order[k];
        // Larger loops come first: the first container met walking back is the smallest.
        for &j in order[..k].iter().rev() {
            if items[j].area > items[i].area && contains(&items[j], &items[i], eps) {
                parent[i] = j as i32;
                depth[i] = depth[j] + 1;
                break;
            }
        }
    }
    Nesting {
        order: order.into_iter().map(|i| i as u32).collect(),
        parent,
        depth,
    }
}

#[derive(PartialEq)]
enum Side {
    Inside,
    Outside,
    Boundary,
}

/// Whether `inner` lies inside `outer`: by a majority of up to nine sampled vertices, then of all
/// vertices and edge midpoints when those tie.
fn contains(outer: &Item, inner: &Item, eps: f64) -> bool {
    for k in 0..2 {
        if inner.min[k] < outer.min[k] - eps || inner.max[k] > outer.max[k] + eps {
            return false;
        }
    }
    let n = inner.coords.len() / 2;
    let vertex = |i: usize| [inner.coords[2 * i], inner.coords[2 * i + 1]];
    let tally = |points: &mut dyn Iterator<Item = [f64; 2]>| {
        points.fold(0i64, |balance, p| match side(p, outer.coords, eps) {
            Side::Inside => balance + 1,
            Side::Outside => balance - 1,
            Side::Boundary => balance,
        })
    };
    let samples = n.min(9);
    let mut balance = tally(&mut (0..samples).map(|s| vertex(s * n / samples)));
    if balance == 0 && samples < n {
        balance = tally(&mut (0..n).map(vertex));
    }
    if balance == 0 {
        balance = tally(&mut (0..n).map(|i| {
            let (a, b) = (vertex(i), vertex((i + 1) % n));
            [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]
        }));
    }
    balance > 0
}

/// Which side of a closed loop a point is on (crossing parity; within `eps` of an edge is the
/// boundary).
fn side(p: [f64; 2], coords: &[f64], eps: f64) -> Side {
    let n = coords.len() / 2;
    let mut inside = false;
    for i in 0..n {
        let j = if i == 0 { n - 1 } else { i - 1 };
        let (ax, ay) = (coords[2 * i], coords[2 * i + 1]);
        let (bx, by) = (coords[2 * j], coords[2 * j + 1]);
        if p[1] >= ay.min(by) - eps
            && p[1] <= ay.max(by) + eps
            && p[0] >= ax.min(bx) - eps
            && p[0] <= ax.max(bx) + eps
        {
            let (dx, dy) = (bx - ax, by - ay);
            let length_sq = dx * dx + dy * dy;
            let t = if length_sq > 0.0 {
                (((p[0] - ax) * dx + (p[1] - ay) * dy) / length_sq).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (ex, ey) = (ax + t * dx - p[0], ay + t * dy - p[1]);
            if ex * ex + ey * ey <= eps * eps {
                return Side::Boundary;
            }
        }
        if (ay > p[1]) != (by > p[1]) && p[0] < (bx - ax) * (p[1] - ay) / (by - ay) + ax {
            inside = !inside;
        }
    }
    if inside { Side::Inside } else { Side::Outside }
}
