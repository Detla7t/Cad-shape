// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

use polygon::{
    BooleanOp, DEFAULT_SCALE, FillRule, Join, Keep, Paths, PolygonError, boolean, clip_polylines, nesting,
    offset, signed_area, simplify,
};
use std::f64::consts::PI;

type Loop = Vec<[f64; 2]>;

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Loop {
    vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

fn reversed(mut points: Loop) -> Loop {
    points.reverse();
    points
}

fn circle(cx: f64, cy: f64, r: f64, n: usize) -> Loop {
    (0..n)
        .map(|i| {
            let a = 2.0 * PI * i as f64 / n as f64;
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect()
}

fn paths(loops: &[Loop]) -> Paths {
    Paths::from_points(loops)
}

fn area(loops: &Paths) -> f64 {
    loops.iter().map(signed_area).sum()
}

fn bounds(points: &[[f64; 2]]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in points {
        b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
    }
    b
}

/// Distance from a point to the boundary of the axis-aligned box [x0, x1] × [y0, y1], outside it.
fn outside_distance(p: [f64; 2], b: [f64; 4]) -> f64 {
    let dx = (b[0] - p[0]).max(p[0] - b[2]).max(0.0);
    let dy = (b[1] - p[1]).max(p[1] - b[3]).max(0.0);
    dx.hypot(dy)
}

const ROUND: Join = Join::Round { tolerance: 0.002 };

mod offsets {
    use super::*;

    #[test]
    fn a_square_grows_by_round_joins_and_every_vertex_is_exactly_the_distance_out() {
        let out = offset(&paths(&[rect(0.0, 0.0, 10.0, 10.0)]), 2.0, ROUND, DEFAULT_SCALE).unwrap();
        assert_eq!(out.len(), 1);
        let ring = &out.to_points()[0];
        assert_eq!(bounds(ring), [-2.0, -2.0, 12.0, 12.0]);
        for &p in ring {
            assert!(
                (outside_distance(p, [0.0, 0.0, 10.0, 10.0]) - 2.0).abs() < 1e-4,
                "{p:?}"
            );
        }
        // Inscribed arcs: the area falls short of the exact rounded square by at most the
        // chords' sagitta (0.002) times the arcs' length.
        let exact = 100.0 + 4.0 * 10.0 * 2.0 + PI * 4.0;
        let a = area(&out);
        assert!(a < exact && a > exact - 0.002 * 2.0 * PI * 2.0, "{a}");
    }

    #[test]
    fn round_joins_follow_the_chord_tolerance() {
        for (radius, tolerance) in [(2.0, 0.002), (5.0, 0.01), (0.5, 0.001)] {
            let join = Join::Round { tolerance };
            let out = offset(&paths(&[rect(0.0, 0.0, 10.0, 10.0)]), radius, join, DEFAULT_SCALE).unwrap();
            let ring = &out.to_points()[0];
            // The four arcs together are the perimeter less the four straight sides.
            let mut perimeter = 0.0;
            let mut chords = 0;
            for i in 0..ring.len() {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                let length = (b[0] - a[0]).hypot(b[1] - a[1]);
                perimeter += length;
                if length < 9.0 {
                    chords += 1;
                    // Every chord stays within the tolerance of its arc.
                    let half = length / 2.0;
                    let sagitta = radius - (radius * radius - half * half).sqrt();
                    assert!(
                        sagitta <= tolerance * 1.01 + 1e-4,
                        "{radius} {tolerance}: {sagitta}"
                    );
                }
            }
            let arcs = perimeter - 40.0;
            let full = 2.0 * PI * radius;
            assert!(
                arcs < full && arcs > full * (1.0 - tolerance / radius),
                "{arcs} vs {full}"
            );
            // As few chords as the tolerance allows (each spans up to the full step angle).
            let step = 2.0 * (1.0 - tolerance / radius).acos();
            let fewest = 4 * (PI / 2.0 / step).ceil() as usize;
            assert!(chords >= fewest && chords <= fewest + 8, "{chords} vs {fewest}");
        }
    }

    #[test]
    fn mitres_keep_corners_sharp_in_and_out() {
        let square = paths(&[rect(0.0, 0.0, 20.0, 20.0)]);
        let grown = offset(&square, 1.0, Join::Miter { limit: 3.0 }, DEFAULT_SCALE).unwrap();
        assert_eq!(
            grown.to_points(),
            vec![vec![[-1.0, 21.0], [-1.0, -1.0], [21.0, -1.0], [21.0, 21.0]]]
        );
        let frame = paths(&[rect(0.0, 0.0, 20.0, 20.0), reversed(rect(5.0, 5.0, 15.0, 15.0))]);
        let inset = offset(&frame, -0.225, Join::Miter { limit: 3.0 }, 1000.0)
            .unwrap()
            .to_points();
        assert_eq!(inset.len(), 2);
        assert_eq!(bounds(&inset[0]), [0.225, 0.225, 19.775, 19.775]);
        assert_eq!(bounds(&inset[1]), [4.775, 4.775, 15.225, 15.225]);
        assert!(signed_area(Paths::from_points(&inset[1..]).coords()) < 0.0);
        assert!(inset.iter().all(|ring| ring.len() == 4));
    }

    #[test]
    fn a_mitre_past_its_limit_is_cut_at_that_reach() {
        // A spike with a 10° tip at the origin, pointing down -y.
        let half = 5f64.to_radians();
        let spike = vec![[0.0, 0.0], [20.0 * half.tan(), 20.0], [-20.0 * half.tan(), 20.0]];
        let d = 1.0;
        let full = offset(
            &paths(std::slice::from_ref(&spike)),
            d,
            Join::Miter { limit: 100.0 },
            DEFAULT_SCALE,
        )
        .unwrap();
        let tip = bounds(&full.to_points()[0])[1];
        assert!((tip + d / half.sin()).abs() < 1e-3, "{tip}");
        let cut = offset(&paths(&[spike]), d, Join::Miter { limit: 2.0 }, DEFAULT_SCALE).unwrap();
        // The cut corners lie at the limit's reach from the tip.
        let near: Vec<f64> = cut.to_points()[0]
            .iter()
            .filter(|p| p[1] < -0.5)
            .map(|p| p[0].hypot(p[1]))
            .collect();
        let reach = near.iter().copied().fold(0.0, f64::max);
        assert_eq!(near.len(), 2);
        let tip = bounds(&cut.to_points()[0])[1];
        assert!((reach - 2.0 * d).abs() < 1e-3 && tip < -1.5 * d, "{reach} {tip}");
    }

    #[test]
    fn bevels_cut_each_corner_by_a_chord() {
        let out = offset(
            &paths(&[rect(0.0, 0.0, 10.0, 10.0)]),
            2.0,
            Join::Bevel,
            DEFAULT_SCALE,
        )
        .unwrap();
        assert_eq!(out.to_points()[0].len(), 8);
        assert!((area(&out) - (100.0 + 80.0 + 4.0 * 2.0)).abs() < 1e-6);
    }

    #[test]
    fn shrinking_keeps_sharp_corners_and_grows_holes() {
        let loops = paths(&[rect(0.0, 0.0, 40.0, 30.0), reversed(circle(20.0, 15.0, 5.0, 720))]);
        let out = offset(&loops, -3.0, ROUND, DEFAULT_SCALE).unwrap().to_points();
        assert_eq!(out.len(), 2);
        assert_eq!(bounds(&out[0]), [3.0, 3.0, 37.0, 27.0]);
        assert_eq!(out[0].len(), 4);
        for p in &out[1] {
            assert!(((p[0] - 20.0).hypot(p[1] - 15.0) - 8.0).abs() < 1e-3);
        }
    }

    #[test]
    fn a_loop_thinner_than_twice_the_inset_vanishes_and_a_waist_splits() {
        assert!(
            offset(&paths(&[rect(0.0, 0.0, 4.0, 4.0)]), -2.5, ROUND, DEFAULT_SCALE)
                .unwrap()
                .is_empty()
        );
        let dumbbell = vec![
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 4.0],
            [12.0, 4.0],
            [12.0, 0.0],
            [22.0, 0.0],
            [22.0, 10.0],
            [12.0, 10.0],
            [12.0, 6.0],
            [10.0, 6.0],
            [10.0, 10.0],
            [0.0, 10.0],
        ];
        let out = offset(&paths(&[dumbbell]), -1.5, ROUND, DEFAULT_SCALE)
            .unwrap()
            .to_points();
        assert_eq!(out.len(), 2);
        // Each half reaches into the waist where the arcs around its corners meet.
        let reach = 10.0 - 1.25f64.sqrt();
        let (left, right) = (bounds(&out[0]), bounds(&out[1]));
        assert_eq!([left[0], left[1], left[3]], [1.5, 1.5, 8.5]);
        assert!((left[2] - reach).abs() < 2e-3, "{left:?}");
        assert_eq!([right[1], right[2], right[3]], [1.5, 20.5, 8.5]);
        assert!((right[0] - (22.0 - reach)).abs() < 2e-3, "{right:?}");
    }

    #[test]
    fn offsetting_offsets_ring_after_ring_keeps_vertices_few_and_exact() {
        // A pocket around a round island, cleared ring by ring: each ring offsets the last.
        let island = reversed(circle(30.0, 30.0, 10.0, 600));
        let mut loops = paths(&[rect(0.0, 0.0, 100.0, 60.0), island]);
        for k in 1..=12 {
            loops = offset(&loops, -1.5, ROUND, DEFAULT_SCALE).unwrap();
            let points: u32 = loops.lengths().iter().sum();
            // Joins at the island's small turns are chords: without care each ring would
            // double the island's vertices.
            assert!(points < 800, "ring {k}: {points} points");
            let r = 10.0 + 1.5 * k as f64;
            for p in loops.to_points().iter().flatten() {
                let d = (p[0] - 30.0).hypot(p[1] - 30.0);
                if d < r + 0.5 {
                    assert!((d - r).abs() < 1e-3, "ring {k}: {d} for {r}");
                }
            }
        }
    }

    #[test]
    fn a_thin_part_vanishes_but_a_thin_hole_still_cuts() {
        assert!(
            offset(&paths(&[rect(0.0, 0.0, 2.9, 50.0)]), -1.5, ROUND, DEFAULT_SCALE)
                .unwrap()
                .is_empty()
        );
        let plate = paths(&[rect(0.0, 0.0, 50.0, 50.0), reversed(rect(20.0, 10.0, 21.0, 40.0))]);
        let miter = Join::Miter { limit: 4.0 };
        let shrunk = offset(&plate, -1.5, miter, DEFAULT_SCALE).unwrap().to_points();
        assert_eq!(shrunk.len(), 2);
        assert_eq!(bounds(&shrunk[1]), [18.5, 8.5, 22.5, 41.5]);
        // Growing the material by half the hole's width closes it exactly.
        let grown = offset(&plate, 0.5, miter, DEFAULT_SCALE).unwrap().to_points();
        assert_eq!(
            grown,
            vec![vec![[-0.5, 50.5], [-0.5, -0.5], [50.5, -0.5], [50.5, 50.5]]]
        );
    }

    #[test]
    fn far_from_the_origin_results_stay_on_the_absolute_grid() {
        let far = paths(&[rect(40_000.0, -30_000.0, 40_010.0, -29_990.0)]);
        let out = offset(&far, 1.25, Join::Miter { limit: 4.0 }, DEFAULT_SCALE).unwrap();
        assert_eq!(
            bounds(&out.to_points()[0]),
            [39_998.75, -30_001.25, 40_011.25, -29_988.75]
        );
    }

    #[test]
    fn bad_parameters_are_errors() {
        let square = paths(&[rect(0.0, 0.0, 1.0, 1.0)]);
        assert!(matches!(
            offset(&square, f64::NAN, ROUND, DEFAULT_SCALE),
            Err(PolygonError::InvalidParameter(_))
        ));
        let join = Join::Round { tolerance: 0.0 };
        assert!(matches!(
            offset(&square, 1.0, join, DEFAULT_SCALE),
            Err(PolygonError::InvalidParameter(_))
        ));
        let join = Join::Miter { limit: -1.0 };
        assert!(matches!(
            offset(&square, 1.0, join, DEFAULT_SCALE),
            Err(PolygonError::InvalidParameter(_))
        ));
        assert!(matches!(
            offset(&square, 1e6, ROUND, DEFAULT_SCALE),
            Err(PolygonError::OutOfRange { .. })
        ));
    }

    #[test]
    fn degenerate_loops_are_ignored() {
        let loops = paths(&[
            vec![],
            vec![[0.0, 0.0], [1.0, 1.0]],
            vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]],
        ]);
        assert!(offset(&loops, -1.0, ROUND, DEFAULT_SCALE).unwrap().is_empty());
        assert!(
            offset(&Paths::new(), 1.0, ROUND, DEFAULT_SCALE)
                .unwrap()
                .is_empty()
        );
        // Repeated points and a closing repeat change nothing.
        let repeated = paths(&[vec![
            [0.0, 0.0],
            [0.0, 0.0],
            [4.0, 0.0],
            [4.0, 4.0],
            [0.0, 4.0],
            [0.0, 0.0],
        ]]);
        let out = offset(&repeated, -1.0, ROUND, DEFAULT_SCALE).unwrap();
        assert_eq!(bounds(&out.to_points()[0]), [1.0, 1.0, 3.0, 3.0]);
    }
}

mod booleans {
    use super::*;

    fn op(op: BooleanOp, a: &[Loop], b: &[Loop], fill: FillRule) -> Paths {
        boolean(op, &paths(a), &paths(b), fill, DEFAULT_SCALE).unwrap()
    }

    #[test]
    fn union_difference_intersection_and_xor_of_two_squares() {
        let a = [rect(0.0, 0.0, 10.0, 10.0)];
        let b = [rect(5.0, 5.0, 15.0, 15.0)];
        assert_eq!(area(&op(BooleanOp::Union, &a, &b, FillRule::NonZero)), 175.0);
        assert_eq!(area(&op(BooleanOp::Difference, &a, &b, FillRule::NonZero)), 75.0);
        assert_eq!(
            area(&op(BooleanOp::Intersection, &a, &b, FillRule::NonZero)),
            25.0
        );
        let xor = op(BooleanOp::Xor, &a, &b, FillRule::NonZero);
        assert_eq!(area(&xor), 150.0);
        assert_eq!(xor.len(), 2);
        let both = op(BooleanOp::Intersection, &a, &b, FillRule::NonZero).to_points();
        assert_eq!(
            both,
            vec![vec![[5.0, 10.0], [5.0, 5.0], [10.0, 5.0], [10.0, 10.0]]]
        );
    }

    #[test]
    fn results_are_outer_loops_then_their_holes() {
        let frame = op(
            BooleanOp::Difference,
            &[rect(0.0, 0.0, 20.0, 20.0)],
            &[rect(5.0, 5.0, 15.0, 15.0)],
            FillRule::NonZero,
        );
        let loops = frame.to_points();
        assert_eq!(loops.len(), 2);
        assert_eq!(bounds(&loops[0]), [0.0, 0.0, 20.0, 20.0]);
        assert!(signed_area(frame.iter().next().unwrap()) > 0.0);
        assert_eq!(signed_area(frame.iter().nth(1).unwrap()), -100.0);
        // An island in the hole is a shape of its own, after the frame.
        let island = op(
            BooleanOp::Union,
            &loops,
            &[rect(8.0, 8.0, 12.0, 12.0)],
            FillRule::NonZero,
        );
        assert_eq!(island.len(), 3);
        assert_eq!(bounds(&island.to_points()[2]), [8.0, 8.0, 12.0, 12.0]);
        assert_eq!(area(&island), 400.0 - 100.0 + 16.0);
    }

    #[test]
    fn fill_rules_decide_overlaps_and_orientation() {
        let two = [rect(0.0, 0.0, 10.0, 10.0), rect(5.0, 5.0, 15.0, 15.0)];
        let fill = |rule| area(&simplify(&paths(&two), rule, DEFAULT_SCALE).unwrap());
        assert_eq!(fill(FillRule::NonZero), 175.0);
        assert_eq!(fill(FillRule::EvenOdd), 150.0);
        assert_eq!(fill(FillRule::Positive), 175.0);
        assert_eq!(fill(FillRule::Negative), 0.0);
        let clockwise = [reversed(rect(0.0, 0.0, 10.0, 10.0))];
        let fill = |rule| area(&simplify(&paths(&clockwise), rule, DEFAULT_SCALE).unwrap());
        assert_eq!(fill(FillRule::Positive), 0.0);
        assert_eq!(fill(FillRule::Negative), 100.0);
        assert_eq!(fill(FillRule::NonZero), 100.0);
    }

    #[test]
    fn self_intersections_resolve_by_the_fill_rule() {
        // A bow tie: two triangles of area 25 with opposite windings, crossing at (5, 5).
        let bow = [vec![[0.0, 0.0], [10.0, 10.0], [10.0, 0.0], [0.0, 10.0]]];
        let out = simplify(&paths(&bow), FillRule::NonZero, DEFAULT_SCALE).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(area(&out), 50.0);
        assert!(out.iter().all(|l| signed_area(l) > 0.0));
        assert_eq!(
            area(&simplify(&paths(&bow), FillRule::Positive, DEFAULT_SCALE).unwrap()),
            25.0
        );
        // A loop wound twice fills once.
        let twice: Loop = rect(0.0, 0.0, 4.0, 4.0).into_iter().cycle().take(8).collect();
        assert_eq!(
            area(&simplify(&paths(&[twice]), FillRule::NonZero, DEFAULT_SCALE).unwrap()),
            16.0
        );
    }

    #[test]
    fn degenerate_inputs() {
        assert!(op(BooleanOp::Union, &[], &[], FillRule::NonZero).is_empty());
        assert!(
            op(
                BooleanOp::Intersection,
                &[rect(0.0, 0.0, 1.0, 1.0)],
                &[],
                FillRule::NonZero
            )
            .is_empty()
        );
        assert_eq!(
            area(&op(
                BooleanOp::Difference,
                &[rect(0.0, 0.0, 1.0, 1.0)],
                &[],
                FillRule::NonZero
            )),
            1.0
        );
        // Zero-area and two-point loops add nothing.
        let flat = vec![[0.0, 0.0], [5.0, 0.0], [10.0, 0.0]];
        assert!(
            op(
                BooleanOp::Union,
                &[flat, vec![[0.0, 0.0], [1.0, 1.0]]],
                &[],
                FillRule::NonZero
            )
            .is_empty()
        );
        // Collinear points are dropped; touching squares merge.
        let touching = [rect(0.0, 0.0, 5.0, 5.0), rect(5.0, 0.0, 10.0, 5.0)];
        let merged = op(BooleanOp::Union, &touching, &[], FillRule::NonZero).to_points();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].len(), 4);
        // Below half a grid unit two points coincide.
        let sliver = [vec![[0.0, 0.0], [1.0, 0.0], [1.0, 0.00004]]];
        assert!(op(BooleanOp::Union, &sliver, &[], FillRule::NonZero).is_empty());
    }

    #[test]
    fn bad_input_is_an_error() {
        let bad = Paths::from_flat(vec![0.0, 0.0, 1.0], vec![2]);
        assert!(matches!(bad, Err(PolygonError::LengthMismatch { .. })));
        let infinite = Paths::from_flat(vec![0.0, 0.0, f64::INFINITY, 0.0, 1.0, 1.0], vec![3]);
        assert_eq!(infinite, Err(PolygonError::NonFinite));
        let huge = paths(&[rect(0.0, 0.0, 1e9, 1.0)]);
        assert!(matches!(
            boolean(
                BooleanOp::Union,
                &huge,
                &Paths::new(),
                FillRule::NonZero,
                DEFAULT_SCALE
            ),
            Err(PolygonError::OutOfRange { .. })
        ));
        // A coarser grid holds it.
        assert!(boolean(BooleanOp::Union, &huge, &Paths::new(), FillRule::NonZero, 0.1).is_ok());
    }
}

mod clipping {
    use super::*;

    fn clip(lines: &[Loop], region: &[Loop], keep: Keep) -> Vec<Loop> {
        clip_polylines(&paths(lines), &paths(region), FillRule::NonZero, keep, 1000.0)
            .unwrap()
            .to_points()
    }

    #[test]
    fn a_polyline_keeps_its_direction_and_joins_across_vertices() {
        let line = vec![
            [-5.0, 5.0],
            [5.0, 5.0],
            [5.0, 15.0],
            [8.0, 15.0],
            [8.0, 5.0],
            [15.0, 5.0],
        ];
        let square = [rect(0.0, 0.0, 10.0, 10.0)];
        assert_eq!(
            clip(std::slice::from_ref(&line), &square, Keep::Inside),
            vec![
                vec![[0.0, 5.0], [5.0, 5.0], [5.0, 10.0]],
                vec![[8.0, 10.0], [8.0, 5.0], [10.0, 5.0]]
            ]
        );
        assert_eq!(
            clip(&[reversed(line.clone())], &square, Keep::Inside),
            vec![
                vec![[10.0, 5.0], [8.0, 5.0], [8.0, 10.0]],
                vec![[5.0, 10.0], [5.0, 5.0], [0.0, 5.0]]
            ]
        );
        assert_eq!(
            clip(&[line], &square, Keep::Outside),
            vec![
                vec![[-5.0, 5.0], [0.0, 5.0]],
                vec![[5.0, 10.0], [5.0, 15.0], [8.0, 15.0], [8.0, 10.0]],
                vec![[10.0, 5.0], [15.0, 5.0]],
            ]
        );
    }

    #[test]
    fn crossing_and_duplicate_lines_stay_apart() {
        let big = [rect(-100.0, -100.0, 100.0, 100.0)];
        let across = vec![[-200.0, 0.0], [200.0, 0.0]];
        let down = vec![[0.0, 200.0], [0.0, -200.0]];
        assert_eq!(
            clip(&[across.clone(), down, across], &big, Keep::Inside),
            vec![
                vec![[-100.0, 0.0], [100.0, 0.0]],
                vec![[0.0, 100.0], [0.0, -100.0]],
                vec![[-100.0, 0.0], [100.0, 0.0]],
            ]
        );
        // A self-crossing polyline is one piece, in order.
        let looped = vec![
            [-200.0, 0.0],
            [50.0, 0.0],
            [50.0, 50.0],
            [0.0, 50.0],
            [0.0, -200.0],
        ];
        assert_eq!(
            clip(&[looped], &big, Keep::Inside),
            vec![vec![
                [-100.0, 0.0],
                [50.0, 0.0],
                [50.0, 50.0],
                [0.0, 50.0],
                [0.0, -100.0]
            ]]
        );
    }

    #[test]
    fn holes_and_diagonals_are_cut_exactly() {
        let frame = [rect(0.0, 0.0, 10.0, 10.0), reversed(rect(4.0, 4.0, 6.0, 6.0))];
        let diagonal = vec![[-1.0, -1.0], [11.0, 11.0]];
        assert_eq!(
            clip(&[diagonal], &frame, Keep::Inside),
            vec![vec![[0.0, 0.0], [4.0, 4.0]], vec![[6.0, 6.0], [10.0, 10.0]]]
        );
        let vertical = vec![[5.0, -3.0], [5.0, 13.0]];
        let pieces = clip(&[vertical], &frame, Keep::Inside);
        assert_eq!(
            pieces,
            vec![vec![[5.0, 0.0], [5.0, 4.0]], vec![[5.0, 6.0], [5.0, 10.0]]]
        );
    }

    #[test]
    fn stretches_along_the_boundary_are_inside() {
        let square = [rect(0.0, 0.0, 10.0, 10.0)];
        let along = vec![[-5.0, 0.0], [15.0, 0.0]];
        assert_eq!(
            clip(std::slice::from_ref(&along), &square, Keep::Inside),
            vec![vec![[0.0, 0.0], [10.0, 0.0]]]
        );
        assert_eq!(
            clip(&[along], &square, Keep::Outside),
            vec![vec![[-5.0, 0.0], [0.0, 0.0]], vec![[10.0, 0.0], [15.0, 0.0]]]
        );
        // Through a corner diagonally: one piece, not split at the vertex it grazes.
        let corner = vec![[-5.0, -5.0], [5.0, 5.0]];
        assert_eq!(
            clip(&[corner], &square, Keep::Inside),
            vec![vec![[0.0, 0.0], [5.0, 5.0]]]
        );
    }

    #[test]
    fn the_fill_rule_decides_the_region() {
        let two = paths(&[rect(0.0, 0.0, 10.0, 10.0), rect(5.0, 0.0, 15.0, 10.0)]);
        let line = paths(&[vec![[-1.0, 5.0], [16.0, 5.0]]]);
        let nonzero = clip_polylines(&line, &two, FillRule::NonZero, Keep::Inside, 1000.0).unwrap();
        assert_eq!(nonzero.to_points(), vec![vec![[0.0, 5.0], [15.0, 5.0]]]);
        let evenodd = clip_polylines(&line, &two, FillRule::EvenOdd, Keep::Inside, 1000.0).unwrap();
        assert_eq!(
            evenodd.to_points(),
            vec![vec![[0.0, 5.0], [5.0, 5.0]], vec![[10.0, 5.0], [15.0, 5.0]]]
        );
    }

    #[test]
    fn degenerate_lines_and_regions() {
        let square = [rect(0.0, 0.0, 10.0, 10.0)];
        let lines = [
            vec![],
            vec![[1.0, 1.0]],
            vec![[2.0, 2.0], [2.0, 2.0]],
            vec![[1.0, 1.0], [1.0, 1.0], [3.0, 1.0]],
        ];
        assert_eq!(
            clip(&lines, &square, Keep::Inside),
            vec![vec![[1.0, 1.0], [3.0, 1.0]]]
        );
        let line = vec![[1.0, 1.0], [3.0, 1.0]];
        assert!(clip(std::slice::from_ref(&line), &[], Keep::Inside).is_empty());
        assert_eq!(clip(std::slice::from_ref(&line), &[], Keep::Outside), vec![line]);
    }
}

mod nesting_trees {
    use super::*;

    #[test]
    fn outer_holes_and_islands_nest_by_containment() {
        let loops = paths(&[
            rect(20.0, 20.0, 80.0, 80.0),           // island in the hole
            rect(0.0, 0.0, 100.0, 100.0),           // outer
            rect(40.0, 40.0, 60.0, 60.0),           // hole in the island
            reversed(rect(10.0, 10.0, 90.0, 90.0)), // hole (orientation is ignored)
            rect(200.0, 0.0, 210.0, 10.0),          // a separate part
            vec![[0.0, 0.0], [1.0, 1.0]],           // degenerate
        ]);
        let tree = nesting(&loops);
        assert_eq!(tree.order, vec![1, 3, 0, 2, 4]);
        assert_eq!(tree.parent, vec![3, -1, 0, 1, -1, -1]);
        assert_eq!(tree.depth, vec![2, 0, 3, 1, 0, 0]);
    }

    #[test]
    fn touching_loops_still_nest() {
        // A hole sharing a corner and part of an edge with its outer boundary.
        let loops = paths(&[
            rect(0.0, 0.0, 10.0, 10.0),
            rect(0.0, 0.0, 4.0, 4.0),
            rect(4.0, 4.0, 8.0, 8.0),
        ]);
        let tree = nesting(&loops);
        assert_eq!(tree.parent, vec![-1, 0, 0]);
        // Equal loops do not contain each other.
        let twins = paths(&[rect(0.0, 0.0, 1.0, 1.0), rect(0.0, 0.0, 1.0, 1.0)]);
        assert_eq!(nesting(&twins).parent, vec![-1, -1]);
    }

    #[test]
    fn overlapping_loops_are_siblings() {
        let loops = paths(&[rect(0.0, 0.0, 10.0, 10.0), rect(5.0, 5.0, 14.0, 14.0)]);
        assert_eq!(nesting(&loops).parent, vec![-1, -1]);
    }
}
