// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! Timing of a full-size simulation: a 200 × 200 mm stock at 0.25 mm cells (640 000 columns),
//! 10 000 moves — Z-level roughing with a Ø10 end mill in 5 mm segments at three depths, then
//! parallel finishing of a wavy surface with a Ø6 ball — and the stock's mesh.
//! `cargo run --release --example bench -p stocksim`

use std::time::Instant;

use stocksim::{MaterialModel, MeshOptions, Move, Profile, Simulator, Tool, ZMap};

/// The program as (from, to, tool, rapid) moves: exactly 10 000 of them.
pub fn program() -> Vec<([f64; 3], [f64; 3], usize, bool)> {
    let mut moves = Vec::new();
    let go = |moves: &mut Vec<([f64; 3], [f64; 3], usize, bool)>, to: [f64; 3], tool: usize, rapid: bool| {
        let from = moves.last().map_or([10.0, 10.0, 10.0], |m| m.1);
        moves.push((from, to, tool, rapid));
    };
    // Roughing: zig-zag over [10, 190]² at three depths, 6 mm stepover, 5 mm segments.
    for level in 1..=3 {
        let z = -2.0 * level as f64;
        go(&mut moves, [10.0, 10.0, 5.0], 0, true);
        go(&mut moves, [10.0, 10.0, z], 0, false);
        let mut forward = true;
        let mut y = 10.0;
        while y <= 190.0 + 1e-9 {
            for k in 1..=36 {
                let x = if forward {
                    10.0 + 5.0 * k as f64
                } else {
                    190.0 - 5.0 * k as f64
                };
                go(&mut moves, [x, y, z], 0, false);
            }
            y += 6.0;
            if y <= 190.0 + 1e-9 {
                go(&mut moves, [if forward { 190.0 } else { 10.0 }, y, z], 0, false);
            }
            forward = !forward;
        }
        let at = moves.last().unwrap().1;
        go(&mut moves, [at[0], at[1], 5.0], 0, true);
    }
    // Finishing: a wavy floor, lines 0.5 apart along x, whatever segment length fills the rest.
    let surface = |x: f64, y: f64| -8.0 + 1.5 * (x / 15.0).sin() * (y / 20.0).cos();
    let remaining = 10_000 - moves.len() - 2;
    let lines = 361;
    let per_line = remaining / lines;
    let extra = remaining - per_line * lines;
    go(&mut moves, [10.0, 10.0, 5.0], 1, true);
    go(&mut moves, [10.0, 10.0, surface(10.0, 10.0)], 1, false);
    for line in 0..lines {
        let y = 10.0 + 0.5 * line as f64;
        let forward = line % 2 == 0;
        // The step over to this line is the line's first move.
        let count = per_line + usize::from(line < extra);
        for k in 0..count {
            let t = if count > 1 {
                k as f64 / (count - 1) as f64
            } else {
                1.0
            };
            let x = if forward {
                10.0 + 180.0 * t
            } else {
                190.0 - 180.0 * t
            };
            go(&mut moves, [x, y, surface(x, y)], 1, false);
        }
    }
    moves
}

fn main() {
    let started = Instant::now();
    let model = ZMap::new_box([0.0, 0.0, -30.0], [200.0, 200.0, 0.0], 0.25).unwrap();
    let mut sim = Simulator::new(model);
    sim.add_tool(Tool::new(Profile::flat(5.0).unwrap()).with_flutes(25.0).unwrap());
    sim.add_tool(Tool::new(Profile::ball(3.0).unwrap()).with_flutes(15.0).unwrap());
    let program = program();
    for &(from, to, tool, rapid) in &program {
        sim.push_move(Move {
            from,
            to,
            tool,
            rapid,
            axis: None,
        })
        .unwrap();
    }
    let grid = *sim.model().grid();
    println!(
        "stock {} × {} cells, {} moves (setup {:.1} ms)",
        grid.nx,
        grid.ny,
        program.len(),
        ms(started)
    );
    let cut = Instant::now();
    let roughing = program.iter().filter(|m| m.2 == 0).count();
    sim.run(roughing);
    let rough_ms = ms(cut);
    sim.run(usize::MAX);
    let total_ms = ms(cut);
    let removed: f64 = sim.records().iter().map(|r| r.removed).sum();
    println!(
        "cut: {total_ms:.0} ms ({rough_ms:.0} ms roughing {roughing} moves, {:.0} ms finishing), removed {removed:.0} mm³, {} warnings",
        total_ms - rough_ms,
        sim.warnings().len()
    );
    for step in [1, 2] {
        let mesh_started = Instant::now();
        let mesh = sim.model().mesh(&MeshOptions {
            step,
            ..Default::default()
        });
        println!(
            "mesh step {step}: {:.0} ms, {} vertices, {} triangles",
            ms(mesh_started),
            mesh.vertex_count(),
            mesh.triangle_count()
        );
    }
    let seek_started = Instant::now();
    sim.seek(5_000);
    let back = ms(seek_started);
    let seek_started = Instant::now();
    sim.seek(9_000);
    println!(
        "seek back to 5000: {back:.0} ms, forward to 9000: {:.0} ms",
        ms(seek_started)
    );
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}
