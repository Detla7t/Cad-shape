// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! Bindings of the `stocksim` crate: a stock material-removal simulator over a Z-map.

use stocksim::{
    Holder, MaterialModel, MeshOptions, Move, Profile, SimError, Simulator, Tool, ZMap, ZMapOptions,
};
use wasm_bindgen::prelude::*;

fn js(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

fn present(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v > 0.0)
}

/// A 3-axis stock simulation: a box of material cut by straight moves of tools (see the
/// `stocksim` crate). Millimetres, in the moves' frame.
#[wasm_bindgen]
pub struct StockSim {
    sim: Simulator<ZMap>,
}

/// A mesh of the stock: positions and normals (xyz per vertex), indices (three per
/// triangle) and, with a part set, the signed deviation from it per vertex.
#[wasm_bindgen]
pub struct StockSimMesh {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    deviation: Vec<f32>,
}

#[wasm_bindgen]
impl StockSimMesh {
    pub fn positions(&self) -> Vec<f32> {
        self.positions.clone()
    }

    pub fn normals(&self) -> Vec<f32> {
        self.normals.clone()
    }

    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }

    /// Empty when no part is set.
    pub fn deviation(&self) -> Vec<f32> {
        self.deviation.clone()
    }
}

#[wasm_bindgen]
impl StockSim {
    /// A box of stock from `min` to `max`, in cells of at most `cell` mm.
    #[wasm_bindgen(constructor)]
    pub fn new(
        min_x: f64,
        min_y: f64,
        min_z: f64,
        max_x: f64,
        max_y: f64,
        max_z: f64,
        cell: f64,
    ) -> Result<StockSim, JsError> {
        let model = ZMap::new_box([min_x, min_y, min_z], [max_x, max_y, max_z], cell).map_err(js)?;
        Ok(StockSim {
            sim: Simulator::new(model),
        })
    }

    /// Gouge (also the XY slack of the part comparison) and collision tolerances, mm. Set
    /// them before the part.
    pub fn set_tolerances(&mut self, gouge: f64, collision: f64) -> Result<(), JsError> {
        let model = self.sim.model_mut().map_err(js)?;
        model
            .set_options(ZMapOptions {
                gouge_tolerance: gouge,
                collision_tolerance: collision,
            })
            .map_err(js)
    }

    /// Replaces the stock's column heights (row-major, `nx × ny`, see `grid`).
    pub fn set_stock_heights(&mut self, heights: &[f32]) -> Result<(), JsError> {
        self.sim.model_mut().map_err(js)?.set_heights(heights).map_err(js)
    }

    /// Makes the stock the region under a triangulated body (xyz positions, 3 indices per
    /// triangle), within the box.
    pub fn set_stock_triangles(&mut self, positions: &[f32], indices: &[u32]) -> Result<(), JsError> {
        self.sim
            .model_mut()
            .map_err(js)?
            .set_stock_triangles(positions, indices)
            .map_err(js)
    }

    /// The part the cuts are checked against (gouges) and compared with (deviation).
    pub fn set_part(&mut self, positions: &[f32], indices: &[u32]) -> Result<(), JsError> {
        self.sim
            .model_mut()
            .map_err(js)?
            .set_part_triangles(positions, indices)
            .map_err(js)
    }

    /// Adds a tool and returns its index. `kind`: `flat`, `ball`, `bull` (`corner_radius`),
    /// `cone` (included `angle`, `tip_diameter`), `drill` (point `angle`) or `tapered`
    /// (`corner_radius`, `angle` of each flank from the axis, `tip_diameter` of the flat
    /// bottom). Absent lengths: flutes along the whole tool, a shank of the cutting diameter,
    /// no holder; a holder needs its `stickout` (its face's height above the tip).
    #[allow(clippy::too_many_arguments)]
    pub fn add_tool(
        &mut self,
        kind: &str,
        diameter: f64,
        corner_radius: Option<f64>,
        angle: Option<f64>,
        tip_diameter: Option<f64>,
        flute_length: Option<f64>,
        shank_diameter: Option<f64>,
        holder_diameter: Option<f64>,
        holder_length: Option<f64>,
        stickout: Option<f64>,
    ) -> Result<u32, JsError> {
        let radius = diameter / 2.0;
        let corner = corner_radius.unwrap_or(0.0);
        let tip = tip_diameter.unwrap_or(0.0);
        let profile = match kind {
            "flat" => Profile::flat(radius),
            "ball" => Profile::ball(radius),
            "bull" => Profile::bull(radius, corner),
            "cone" => Profile::cone(radius, angle.unwrap_or(90.0), tip),
            "drill" => Profile::drill(radius, angle.unwrap_or(118.0)),
            "tapered" => Profile::tapered(tip / 2.0, corner, angle.unwrap_or(5.0), radius),
            other => return Err(JsError::new(&format!("unknown tool profile \"{other}\""))),
        }
        .map_err(js)?;
        let mut tool = Tool::new(profile);
        if let Some(length) = present(flute_length) {
            tool = tool.with_flutes(length).map_err(js)?;
        }
        if let Some(shank) = shank_diameter.filter(|v| v.is_finite()) {
            tool = tool.with_shank(shank / 2.0).map_err(js)?;
        }
        if let (Some(diameter), Some(offset)) = (present(holder_diameter), present(stickout)) {
            let length = present(holder_length).unwrap_or(40.0);
            tool = tool
                .with_holder(Holder {
                    radius: diameter / 2.0,
                    offset,
                    length,
                })
                .map_err(js)?;
        }
        Ok(self.sim.add_tool(tool) as u32)
    }

    /// Appends a polyline of moves cut with `tool`: `points` holds n + 1 xyz points (where the
    /// tool starts, then each move's end), `rapid` n flags (non-zero: a rapid). Returns the
    /// index of its first move.
    pub fn add_moves(&mut self, tool: u32, points: &[f64], rapid: &[u8]) -> Result<u32, JsError> {
        if !points.len().is_multiple_of(3) {
            return Err(js(SimError::new("points must be xyz triples")));
        }
        let count = (points.len() / 3).saturating_sub(1);
        if rapid.len() != count {
            return Err(js(SimError::new(format!(
                "{count} moves need {count} rapid flags, got {}",
                rapid.len()
            ))));
        }
        let first = self.sim.moves().len();
        let point = |k: usize| [points[k * 3], points[k * 3 + 1], points[k * 3 + 2]];
        for (k, &flag) in rapid.iter().enumerate() {
            let m = Move {
                from: point(k),
                to: point(k + 1),
                tool: tool as usize,
                rapid: flag != 0,
                axis: None,
            };
            self.sim.push_move(m).map_err(js)?;
        }
        Ok(first as u32)
    }

    /// Cuts up to `count` more moves; returns how many are cut.
    pub fn run(&mut self, count: u32) -> u32 {
        self.sim.run(count as usize) as u32
    }

    /// Puts the stock in its state after the first `index` moves.
    pub fn seek(&mut self, index: u32) {
        self.sim.seek(index as usize);
    }

    /// The moves cut so far (the stock is after `moves[..cursor]`).
    pub fn cursor(&self) -> u32 {
        self.sim.cursor() as u32
    }

    pub fn move_count(&self) -> u32 {
        self.sim.moves().len() as u32
    }

    /// Removed volume of each move cut at least once, mm³.
    pub fn removed(&self) -> Vec<f64> {
        self.sim.records().iter().map(|record| record.removed).collect()
    }

    /// Warnings of the moves cut at least once, 7 numbers each: kind (1 rapid in stock,
    /// 2 shank collision, 3 holder collision, 4 gouge, 5 unsupported move), move index, depth
    /// (mm), amount (rapid: mm³ removed; gouge: cells), x, y, z.
    pub fn warnings(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.sim.warnings().len() * 7);
        for w in self.sim.warnings() {
            out.extend([
                w.kind as u8 as f64,
                w.move_index as f64,
                w.depth,
                w.amount,
                w.at[0],
                w.at[1],
                w.at[2],
            ]);
        }
        out
    }

    /// The stock's mesh from every `step`-th cell centre.
    pub fn mesh(&self, step: u32) -> StockSimMesh {
        let mesh = self.sim.model().mesh(&MeshOptions {
            step: step.max(1) as usize,
            ..MeshOptions::default()
        });
        StockSimMesh {
            positions: mesh.positions,
            normals: mesh.normals,
            indices: mesh.indices,
            deviation: mesh.deviation,
        }
    }

    /// The material's volume, mm³.
    pub fn volume(&self) -> f64 {
        self.sim.model().volume()
    }

    /// The stock compared with the part, 8 numbers: excess volume (mm³), thickest excess
    /// (mm), gouge volume (mm³), deepest gouge (mm), gouged cells, and the deepest gouge's
    /// x, y, z; empty without a part.
    pub fn comparison(&self) -> Vec<f64> {
        match self.sim.model().comparison() {
            None => Vec::new(),
            Some(c) => vec![
                c.excess_volume,
                c.max_excess,
                c.gouge_volume,
                c.max_gouge,
                c.gouge_cells as f64,
                c.max_gouge_at[0],
                c.max_gouge_at[1],
                c.max_gouge_at[2],
            ],
        }
    }

    /// The grid: x0, y0, cell size x, cell size y, nx, ny, bottom.
    pub fn grid(&self) -> Vec<f64> {
        let model = self.sim.model();
        let g = model.grid();
        vec![
            g.x0,
            g.y0,
            g.cx,
            g.cy,
            g.nx as f64,
            g.ny as f64,
            model.bottom() as f64,
        ]
    }

    /// The column heights, row-major.
    pub fn heights(&self) -> Vec<f32> {
        self.sim.model().heights().to_vec()
    }

    /// Each column's signed deviation from the part (NaN without one).
    pub fn deviations(&self) -> Vec<f32> {
        let model = self.sim.model();
        (0..model.heights().len())
            .map(|index| model.deviation(index))
            .collect()
    }
}
