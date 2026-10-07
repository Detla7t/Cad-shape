// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! What a stock representation must do for the simulator. The Z-map (`ZMap`) is the 3-axis
//! one; a tri-dexel model (three orthogonal dexel grids, for tilted tools and undercuts)
//! implements the same trait, takes the same moves — `Sweep` carries the tool axis at both
//! ends — and plugs into the same `Simulator`.

use crate::mesh::{MeshOptions, StockMesh};
use crate::tool::Tool;

/// One straight move of the tool tip, with the tool axis (unit, tip → spindle) at its ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sweep {
    pub from: [f64; 3],
    pub to: [f64; 3],
    pub axis_from: [f64; 3],
    pub axis_to: [f64; 3],
}

impl Sweep {
    /// A 3-axis move: the tool along +Z.
    pub fn vertical(from: [f64; 3], to: [f64; 3]) -> Self {
        Self {
            from,
            to,
            axis_from: [0.0, 0.0, 1.0],
            axis_to: [0.0, 0.0, 1.0],
        }
    }

    /// Whether the tool stays along +Z (what a Z-map can cut).
    pub fn is_vertical(&self) -> bool {
        let vertical = |a: [f64; 3]| {
            let n = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
            n > 0.0 && a[2] / n > 1.0 - 1e-9
        };
        vertical(self.axis_from) && vertical(self.axis_to)
    }
}

/// The deepest interference of a non-cutting part of the tool with the stock in one move.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Contact {
    /// How far the stock reached into it, mm.
    pub depth: f64,
    /// Where: the stock's top at the cell (x, y, z).
    pub at: [f64; 3],
}

impl Contact {
    pub(crate) fn deeper(current: Option<Contact>, depth: f64, at: [f64; 3]) -> Option<Contact> {
        match current {
            Some(contact) if contact.depth >= depth => Some(contact),
            _ => Some(Contact { depth, at }),
        }
    }
}

/// Cells one move cut below the part.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GougeReport {
    pub cells: u32,
    /// The deepest, mm below the part, and where (x, y, the cut's z).
    pub depth: f64,
    pub at: [f64; 3],
}

/// What one move did to the stock.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CutReport {
    /// Removed material, mm³.
    pub removed: f64,
    /// The deepest cut into one column, mm, and the cut point there.
    pub max_depth: f64,
    pub deepest: [f64; 3],
    pub shank: Option<Contact>,
    pub holder: Option<Contact>,
    pub gouge: Option<GougeReport>,
    /// The model cannot cut this move (a tilted tool on a Z-map); nothing was changed.
    pub unsupported: bool,
}

/// The stock compared with the part.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Comparison {
    /// Material left above the part, mm³, and its thickest spot, mm.
    pub excess_volume: f64,
    pub max_excess: f64,
    /// Material missing below the part (beyond the tolerance), mm³, the deepest gouge, mm.
    pub gouge_volume: f64,
    pub max_gouge: f64,
    pub max_gouge_at: [f64; 3],
    pub gouge_cells: usize,
}

/// A stock representation (see the module notes).
pub trait MaterialModel {
    /// A saved state, for seeking back during playback.
    type Snapshot;

    /// Removes what the tool sweeps in one move and reports what it hit.
    fn cut(&mut self, tool: &Tool, sweep: &Sweep) -> CutReport;
    fn snapshot(&self) -> Self::Snapshot;
    fn restore(&mut self, snapshot: &Self::Snapshot);
    /// Memory one snapshot takes, bytes.
    fn snapshot_bytes(&self) -> usize;
    /// The material's volume, mm³.
    fn volume(&self) -> f64;
    /// A triangle mesh of the material.
    fn mesh(&self, options: &MeshOptions) -> StockMesh;
    /// The material compared with the part, when one is set.
    fn comparison(&self) -> Option<Comparison>;
}
