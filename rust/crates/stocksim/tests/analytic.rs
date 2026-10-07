// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! Simulations with answers known in closed form.

use std::f64::consts::PI;

use stocksim::{Holder, MaterialModel, MeshOptions, Move, Profile, Simulator, Tool, WarningKind, ZMap};

const STOCK_MIN: [f64; 3] = [0.0, 0.0, -20.0];
const STOCK_MAX: [f64; 3] = [60.0, 40.0, 0.0];

fn simulator(cell: f64) -> Simulator {
    Simulator::new(ZMap::new_box(STOCK_MIN, STOCK_MAX, cell).unwrap())
}

/// Feeds a polyline (rapid flags per segment) with one tool.
fn path(sim: &mut Simulator, tool: usize, points: &[[f64; 3]], rapid: &[bool]) {
    for (k, pair) in points.windows(2).enumerate() {
        sim.push_move(Move {
            from: pair[0],
            to: pair[1],
            tool,
            rapid: rapid[k],
            axis: None,
        })
        .unwrap();
    }
}

fn feed(sim: &mut Simulator, tool: usize, points: &[[f64; 3]]) {
    path(sim, tool, points, &vec![false; points.len() - 1]);
}

fn run_all(sim: &mut Simulator) -> f64 {
    let before = sim.model().volume();
    sim.run(usize::MAX);
    let removed: f64 = sim.records().iter().map(|r| r.removed).sum();
    assert!(
        (before - sim.model().volume() - removed).abs() < 1e-6 * before,
        "records add up"
    );
    removed
}

fn close(actual: f64, expected: f64, relative: f64) {
    assert!(
        ((actual - expected) / expected).abs() <= relative,
        "{actual} is not within {:.2}% of {expected}",
        relative * 100.0
    );
}

/// A box as 12 triangles (for the part).
fn box_mesh(min: [f32; 3], max: [f32; 3]) -> (Vec<f32>, Vec<u32>) {
    let mut positions = Vec::new();
    for k in 0..8 {
        positions.extend([
            if k & 1 == 0 { min[0] } else { max[0] },
            if k & 2 == 0 { min[1] } else { max[1] },
            if k & 4 == 0 { min[2] } else { max[2] },
        ]);
    }
    let faces = [
        [0, 2, 3, 1],
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [2, 6, 7, 3],
        [0, 4, 6, 2],
        [1, 3, 7, 5],
    ];
    let mut indices = Vec::new();
    for f in faces {
        indices.extend([f[0], f[1], f[2], f[0], f[2], f[3]]);
    }
    (positions, indices)
}

#[test]
fn a_flat_end_mill_slot_removes_width_by_length_by_depth() {
    // Straight through the stock, 3 deep with a Ø10 end mill: exactly 60 × 10 × 3.
    let mut sim = simulator(0.25);
    let tool = sim.add_tool(Tool::new(Profile::flat(5.0).unwrap()));
    feed(
        &mut sim,
        tool,
        &[
            [-10.0, 20.0, 5.0],
            [-10.0, 20.0, -3.0],
            [70.0, 20.0, -3.0],
            [70.0, 20.0, 5.0],
        ],
    );
    let removed = run_all(&mut sim);
    assert!((removed - 1800.0).abs() < 1e-3, "{removed}");
    let grid = *sim.model().grid();
    let h = |x: f64, y: f64| {
        let (i, j) = grid.cell_of(x, y);
        sim.model().heights()[grid.index(i, j)]
    };
    assert_eq!(h(30.0, 20.0), -3.0);
    assert_eq!(h(30.0, 15.1), -3.0);
    assert_eq!(h(30.0, 14.9), 0.0);

    // A slot ending inside: its ends are half discs.
    let mut sim = simulator(0.1);
    let tool = sim.add_tool(Tool::new(Profile::flat(5.0).unwrap()));
    feed(
        &mut sim,
        tool,
        &[
            [20.0, 20.0, 5.0],
            [20.0, 20.0, -3.0],
            [40.0, 20.0, -3.0],
            [40.0, 20.0, 5.0],
        ],
    );
    close(run_all(&mut sim), 3.0 * (20.0 * 10.0 + PI * 25.0), 0.002);
}

#[test]
fn a_ball_groove_has_the_circular_segment_for_its_section() {
    let (r, depth) = (3.0f64, 2.0f64);
    let segment = r * r * ((r - depth) / r).acos() - (r - depth) * (2.0 * r * depth - depth * depth).sqrt();
    let mut sim = simulator(0.05);
    let tool = sim.add_tool(Tool::new(Profile::ball(r).unwrap()));
    feed(&mut sim, tool, &[[-10.0, 20.0, -depth], [70.0, 20.0, -depth]]);
    let removed = run_all(&mut sim);
    close(removed / 60.0, segment, 0.002);
    // One row across the groove integrates the same section.
    let grid = *sim.model().grid();
    let i = grid.cell_of(30.0, 0.0).0;
    let section: f64 = (0..grid.ny)
        .map(|j| -(sim.model().heights()[grid.index(i, j)] as f64) * grid.cy)
        .sum();
    close(section, segment, 0.003);
}

#[test]
fn a_bull_nose_groove_loses_its_corners() {
    // Section of a Ø10 r2 bull nose 4 deep: the rectangle minus the two corners outside the arcs.
    let (r, corner, depth) = (5.0, 2.0, 4.0);
    let section = 2.0 * r * depth - (4.0 - PI) * corner * corner / 2.0;
    let mut sim = simulator(0.05);
    let tool = sim.add_tool(Tool::new(Profile::bull(r, corner).unwrap()));
    feed(&mut sim, tool, &[[-10.0, 20.0, -depth], [70.0, 20.0, -depth]]);
    close(run_all(&mut sim) / 60.0, section, 0.002);
}

#[test]
fn a_rectangular_pocket_has_tool_radius_corners() {
    // A 30 × 20 pocket, 4 deep, from (15, 10), cleared with a Ø6 end mill: zig-zag over the
    // tool centre's rectangle, then a pass around it.
    let (x0, y0, w, h, r, depth) = (15.0, 10.0, 30.0, 20.0, 3.0, 4.0);
    let mut sim = simulator(0.1);
    let tool = sim.add_tool(Tool::new(Profile::flat(r).unwrap()));
    let (cx0, cx1, cy0, cy1) = (x0 + r, x0 + w - r, y0 + r, y0 + h - r);
    let mut points = vec![[cx0, cy0, 5.0], [cx0, cy0, -depth]];
    let mut y = cy0;
    let mut forward = true;
    while y < cy1 {
        let x = if forward { cx1 } else { cx0 };
        points.push([x, y, -depth]);
        y = (y + 4.0).min(cy1);
        points.push([x, y, -depth]);
        forward = !forward;
    }
    points.push([if forward { cx1 } else { cx0 }, cy1, -depth]);
    points.extend([
        [cx0, cy1, -depth],
        [cx0, cy0, -depth],
        [cx1, cy0, -depth],
        [cx1, cy1, -depth],
    ]);
    points.push([cx1, cy1, 5.0]);
    feed(&mut sim, tool, &points);
    let expected = depth * (w * h - (4.0 - PI) * r * r);
    close(run_all(&mut sim), expected, 0.002);
    let grid = *sim.model().grid();
    let at = |x: f64, y: f64| sim.model().heights()[grid.index(grid.cell_of(x, y).0, grid.cell_of(x, y).1)];
    assert_eq!(at(16.0, 15.0), -4.0);
    assert_eq!(at(44.0, 29.0), -4.0);
    assert_eq!(at(15.3, 10.3), 0.0, "the corner keeps the tool's radius");
    assert_eq!(at(14.9, 15.0), 0.0);
}

#[test]
fn a_drilled_hole_is_a_cylinder_with_a_cone_bottom() {
    let (r, point, depth) = (4.0, 118.0f64, 15.0);
    let cone = r / (point.to_radians() / 2.0).tan();
    let mut sim = simulator(0.05);
    let tool = sim.add_tool(
        Tool::new(Profile::drill(r, point).unwrap())
            .with_flutes(50.0)
            .unwrap(),
    );
    feed(
        &mut sim,
        tool,
        &[
            [30.0, 20.0, 5.0],
            [30.0, 20.0, 2.0],
            [30.0, 20.0, -depth],
            [30.0, 20.0, 5.0],
        ],
    );
    let expected = PI * r * r * (depth - cone) + PI * r * r * cone / 3.0;
    close(run_all(&mut sim), expected, 0.003);
    let grid = *sim.model().grid();
    let (i, j) = grid.cell_of(30.0, 20.0);
    // The cell centre next to the axis is 0.025√2 off it.
    let next_to_axis = -depth + 0.025 * 2f64.sqrt() / (point.to_radians() / 2.0).tan();
    assert!((sim.model().heights()[grid.index(i, j)] as f64 - next_to_axis).abs() < 1e-5);
    assert!(sim.warnings().is_empty());
}

#[test]
fn a_cone_along_an_edge_cuts_a_chamfer() {
    // A 90° V tool with its tip 2 below the top, along the stock's y = 0 edge: a 2 × 2 chamfer.
    let mut sim = simulator(0.25);
    let tool = sim.add_tool(Tool::new(Profile::cone(6.0, 90.0, 0.0).unwrap()));
    feed(&mut sim, tool, &[[-10.0, 0.0, -2.0], [70.0, 0.0, -2.0]]);
    let removed = run_all(&mut sim);
    assert!((removed - 120.0).abs() < 1e-3, "{removed}");
    let grid = *sim.model().grid();
    let (i, _) = grid.cell_of(30.0, 0.0);
    assert_eq!(sim.model().heights()[grid.index(i, 0)], -1.875);
    assert_eq!(sim.model().heights()[grid.index(i, 8)], 0.0);

    // With a 1 mm flat tip and 60° the section is the trapezoid under the flank.
    let mut sim = simulator(0.05);
    let slope = 1.0 / 30f64.to_radians().tan();
    let tool = sim.add_tool(Tool::new(Profile::cone(6.0, 60.0, 1.0).unwrap()));
    feed(&mut sim, tool, &[[-10.0, 0.0, -2.0], [70.0, 0.0, -2.0]]);
    let flank = 2.0 / slope;
    close(run_all(&mut sim) / 60.0, 0.5 * 2.0 + flank * 2.0 / 2.0, 0.002);
}

#[test]
fn a_rapid_into_the_stock_is_flagged_and_a_feed_plunge_is_not() {
    let mut sim = simulator(0.25);
    let tool = sim.add_tool(Tool::new(Profile::flat(3.0).unwrap()));
    path(
        &mut sim,
        tool,
        &[
            [10.0, 10.0, 10.0],
            [10.0, 10.0, 2.0],
            [10.0, 10.0, -2.0],
            [10.0, 10.0, 10.0],
            [30.0, 10.0, 10.0],
        ],
        &[true, false, true, true],
    );
    path(
        &mut sim,
        tool,
        &[[30.0, 10.0, 10.0], [30.0, 10.0, -2.0], [30.0, 10.0, 10.0]],
        &[true, true],
    );
    run_all(&mut sim);
    let rapids: Vec<_> = sim
        .warnings()
        .iter()
        .filter(|w| w.kind == WarningKind::RapidInStock)
        .collect();
    assert_eq!(rapids.len(), 1);
    assert_eq!(rapids[0].move_index, 4);
    assert!((rapids[0].depth - 2.0).abs() < 1e-6);
    close(rapids[0].amount, PI * 9.0 * 2.0, 0.03);
}

#[test]
fn a_holder_running_into_the_stock_is_flagged_with_its_depth() {
    let holder_tool = || {
        Tool::new(Profile::flat(3.0).unwrap())
            .with_flutes(15.0)
            .unwrap()
            .with_holder(Holder {
                radius: 10.0,
                offset: 20.0,
                length: 40.0,
            })
            .unwrap()
    };
    let mut sim = simulator(0.25);
    let tool = sim.add_tool(holder_tool());
    // A plunge 25 deep: the flutes clear their own hole (no shank collision), but the
    // holder's face ends 5 below the stock top — and is still there when the retract starts.
    feed(
        &mut sim,
        tool,
        &[[30.0, 20.0, 5.0], [30.0, 20.0, -25.0], [30.0, 20.0, 5.0]],
    );
    run_all(&mut sim);
    let kinds: Vec<_> = sim.warnings().iter().map(|w| (w.kind, w.move_index)).collect();
    assert_eq!(
        kinds,
        vec![
            (WarningKind::HolderCollision, 0),
            (WarningKind::HolderCollision, 1)
        ]
    );
    assert!((sim.warnings()[0].depth - 5.0).abs() < 1e-6);
    // 2 mm less deep the holder clears.
    let mut sim = simulator(0.25);
    let tool = sim.add_tool(holder_tool());
    feed(
        &mut sim,
        tool,
        &[[30.0, 20.0, 5.0], [30.0, 20.0, -19.0], [30.0, 20.0, 5.0]],
    );
    run_all(&mut sim);
    assert!(sim.warnings().is_empty());
}

#[test]
fn a_cut_deeper_than_the_flutes_is_a_shank_collision() {
    let mut sim = simulator(0.25);
    let short = sim.add_tool(Tool::new(Profile::flat(3.0).unwrap()).with_flutes(8.0).unwrap());
    let long = sim.add_tool(Tool::new(Profile::flat(3.0).unwrap()).with_flutes(30.0).unwrap());
    // Sideways into the stock 10 deep: 2 mm of the cut is above the short tool's flutes.
    feed(&mut sim, short, &[[-10.0, 10.0, -10.0], [70.0, 10.0, -10.0]]);
    feed(&mut sim, long, &[[-10.0, 30.0, -10.0], [70.0, 30.0, -10.0]]);
    run_all(&mut sim);
    assert_eq!(sim.warnings().len(), 1);
    let warning = sim.warnings()[0];
    assert_eq!(
        (warning.kind, warning.move_index),
        (WarningKind::ShankCollision, 0)
    );
    assert!((warning.depth - 2.0).abs() < 1e-6);
}

#[test]
fn a_toolpath_offset_from_the_part_does_not_gouge() {
    // Part: a block whose top is 5 below the stock's; facing 4.5 down leaves 0.5 everywhere.
    let mut sim = simulator(0.25);
    let (positions, indices) = box_mesh([0.0, 0.0, -20.0], [60.0, 40.0, -5.0]);
    sim.model_mut()
        .unwrap()
        .set_part_triangles(&positions, &indices)
        .unwrap();
    let tool = sim.add_tool(Tool::new(Profile::flat(5.0).unwrap()));
    let mut points = vec![[-6.0, 0.0, 5.0], [-6.0, 0.0, -4.5]];
    let mut y = 0.0;
    while y <= 44.0 {
        points.push([66.0, y, -4.5]);
        points.push([66.0, y + 4.0, -4.5]);
        points.push([-6.0, y + 4.0, -4.5]);
        points.push([-6.0, y + 8.0, -4.5]);
        y += 8.0;
    }
    feed(&mut sim, tool, &points);
    run_all(&mut sim);
    assert!(sim.warnings().is_empty(), "{:?}", sim.warnings());
    let comparison = sim.model().comparison().unwrap();
    assert_eq!(comparison.gouge_cells, 0);
    assert!((comparison.max_excess - 0.5).abs() < 1e-6);
    close(comparison.excess_volume, 0.5 * 60.0 * 40.0, 1e-6);
    let mesh = sim.model().mesh(&MeshOptions::default());
    assert_eq!(mesh.deviation.len(), mesh.vertex_count());
    assert!(
        mesh.deviation
            .iter()
            .filter(|d| !d.is_nan())
            .all(|&d| (d - 0.5).abs() < 1e-5 || d > 0.5)
    );
}

#[test]
fn a_deliberate_gouge_is_found_with_its_depth_and_move() {
    let mut sim = simulator(0.25);
    let (positions, indices) = box_mesh([10.0, 10.0, -20.0], [50.0, 30.0, -5.0]);
    sim.model_mut()
        .unwrap()
        .set_part_triangles(&positions, &indices)
        .unwrap();
    let tool = sim.add_tool(Tool::new(Profile::flat(3.0).unwrap()));
    // Move 1 passes over the part 0.5 above it, move 3 goes 1.2 into it.
    feed(
        &mut sim,
        tool,
        &[[-5.0, 20.0, -4.5], [65.0, 20.0, -4.5], [65.0, 24.0, -4.5]],
    );
    feed(&mut sim, tool, &[[65.0, 24.0, -6.2], [-5.0, 24.0, -6.2]]);
    run_all(&mut sim);
    let gouges: Vec<_> = sim
        .warnings()
        .iter()
        .filter(|w| w.kind == WarningKind::Gouge)
        .collect();
    assert_eq!(gouges.len(), 1);
    assert_eq!(gouges[0].move_index, 2);
    assert!((gouges[0].depth - 1.2).abs() < 1e-5, "{}", gouges[0].depth);
    // Over the part's 40 mm, 6 mm wide.
    let cells = gouges[0].amount;
    assert_eq!(cells, (40.0 / 0.25) * (6.0 / 0.25));
    let comparison = sim.model().comparison().unwrap();
    assert!((comparison.max_gouge - 1.2).abs() < 1e-5);
    assert_eq!(comparison.gouge_cells as f64, cells);
}

#[test]
fn seeking_back_and_forth_gives_the_same_stock() {
    let mut sim = Simulator::with_options(
        ZMap::new_box(STOCK_MIN, STOCK_MAX, 0.5).unwrap(),
        stocksim::SimOptions {
            checkpoint_interval: 7,
            ..Default::default()
        },
    );
    let tool = sim.add_tool(Tool::new(Profile::ball(2.0).unwrap()));
    let mut points = vec![[0.0, 0.0, 5.0]];
    for k in 0..60 {
        let t = k as f64 * 0.37;
        points.push([
            30.0 + 25.0 * t.cos(),
            20.0 + 15.0 * t.sin(),
            -1.0 - (k % 5) as f64,
        ]);
    }
    feed(&mut sim, tool, &points);
    sim.seek(40);
    let at_40 = sim.model().heights().to_vec();
    sim.run(usize::MAX);
    let end = sim.model().heights().to_vec();
    let warnings = sim.warnings().len();
    for target in [3, 40, 0, 59, 22, 40] {
        sim.seek(target);
        assert_eq!(sim.cursor(), target);
    }
    assert_eq!(sim.model().heights(), &at_40[..]);
    sim.seek(usize::MAX);
    assert_eq!(sim.model().heights(), &end[..]);
    assert_eq!(sim.warnings().len(), warnings);
    assert_eq!(sim.records().len(), 60);
    assert!(sim.model_mut().is_err(), "the stock is fixed once cut");
}

#[test]
fn a_tilted_tool_is_reported_not_cut() {
    let mut sim = simulator(0.5);
    let tool = sim.add_tool(Tool::new(Profile::flat(3.0).unwrap()));
    sim.push_move(Move {
        from: [10.0, 10.0, -2.0],
        to: [20.0, 10.0, -2.0],
        tool,
        rapid: false,
        axis: Some([0.0, 0.6, 0.8]),
    })
    .unwrap();
    let volume = sim.model().volume();
    sim.run(1);
    assert_eq!(sim.warnings()[0].kind, WarningKind::Unsupported);
    assert_eq!(sim.model().volume(), volume);
    assert!(
        sim.push_move(Move {
            from: [0.0; 3],
            to: [0.0; 3],
            tool: 5,
            rapid: false,
            axis: None
        })
        .is_err()
    );
}

#[test]
fn a_pocket_mesh_is_decimated_and_closed() {
    let mut sim = simulator(0.25);
    let tool = sim.add_tool(Tool::new(Profile::flat(3.0).unwrap()));
    feed(
        &mut sim,
        tool,
        &[
            [20.0, 15.0, 5.0],
            [20.0, 15.0, -4.0],
            [40.0, 15.0, -4.0],
            [40.0, 25.0, -4.0],
            [20.0, 25.0, -4.0],
            [20.0, 15.0, -4.0],
        ],
    );
    run_all(&mut sim);
    let mesh = sim.model().mesh(&MeshOptions::default());
    let cells = sim.model().grid().len();
    // The floor and top are a handful of rectangles; only the walls are fine.
    assert!(
        mesh.triangle_count() < cells / 4,
        "{} triangles for {cells} cells",
        mesh.triangle_count()
    );
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
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum();
    // The mesh runs through cell centres, so it is close to — not exactly — the Z-map volume.
    close(volume, sim.model().volume(), 0.002);
    let coarse = sim.model().mesh(&MeshOptions {
        step: 4,
        ..Default::default()
    });
    assert!(coarse.triangle_count() < mesh.triangle_count());
}

/// The part's top: a 60 × 40 plate at z = −5 around a square hole of side `side` centred at
/// (30, 20), its floor at −15.
fn plate_with_hole(side: f32) -> (Vec<f32>, Vec<u32>) {
    let (a, b) = (30.0 - side / 2.0, 30.0 + side / 2.0);
    let (c, d) = (20.0 - side / 2.0, 20.0 + side / 2.0);
    let rects = [
        [0.0, 0.0, a, 40.0, -5.0],
        [b, 0.0, 60.0, 40.0, -5.0],
        [a, 0.0, b, c, -5.0],
        [a, d, b, 40.0, -5.0],
        [a, c, b, d, -15.0],
    ];
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for [x0, y0, x1, y1, z] in rects {
        let k = (positions.len() / 3) as u32;
        positions.extend([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]);
        indices.extend([k, k + 1, k + 2, k, k + 2, k + 3]);
    }
    (positions, indices)
}

#[test]
fn a_cut_into_a_wall_counts_once_it_is_deeper_than_half_a_cell() {
    let plunge = |side: f32| {
        let mut sim = simulator(0.25);
        let (positions, indices) = plate_with_hole(side);
        sim.model_mut()
            .unwrap()
            .set_part_triangles(&positions, &indices)
            .unwrap();
        assert_eq!(sim.model().wall_slack(), 0.125);
        let tool = sim.add_tool(Tool::new(Profile::flat(5.0).unwrap()));
        feed(
            &mut sim,
            tool,
            &[[30.0, 20.0, 5.0], [30.0, 20.0, -15.0], [30.0, 20.0, 5.0]],
        );
        run_all(&mut sim);
        sim.warnings()
            .iter()
            .filter(|w| w.kind == WarningKind::Gouge)
            .count()
    };
    // A Ø10 plunge in a 10 mm square: just touching its walls.
    assert_eq!(plunge(10.0), 0);
    // 0.05 into the walls (a triangulation's chords cutting a round hole short): within the slack.
    assert_eq!(plunge(9.9), 0);
    // 0.3 into them: a gouge, as deep as the wall.
    assert_eq!(plunge(9.4), 1);
}
