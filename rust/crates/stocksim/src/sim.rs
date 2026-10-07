// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! The simulator: a program of straight moves, each with its tool, cut into a material model
//! a range at a time. It keeps what each move removed and the warnings it raised — a rapid
//! that cut material, the shank or holder running into the stock, a cut below the part — and
//! snapshots of the material every so many moves, so playback can seek back without cutting
//! from the start. Seeking re-cuts deterministically: a move's record and warnings are made
//! the first time it is cut and stay valid.

use crate::SimError;
use crate::model::{CutReport, MaterialModel, Sweep};
use crate::tool::Tool;
use crate::zmap::ZMap;

/// One straight move of the tool tip.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Move {
    pub from: [f64; 3],
    pub to: [f64; 3],
    /// Index of the move's tool (`Simulator::add_tool`).
    pub tool: usize,
    pub rapid: bool,
    /// Tool axis at the end of the move (unit, tip → spindle); `None` is +Z.
    pub axis: Option<[f64; 3]>,
}

/// What one move did.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MoveRecord {
    /// Removed volume, mm³.
    pub removed: f64,
    /// Deepest cut into one column, mm.
    pub depth: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarningKind {
    /// A rapid move removed material.
    RapidInStock = 1,
    /// The shank (above the flutes) ran into the stock.
    ShankCollision = 2,
    /// The holder ran into the stock.
    HolderCollision = 3,
    /// The move cut below the part.
    Gouge = 4,
    /// The model cannot simulate the move (a tilted tool on a Z-map).
    Unsupported = 5,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Warning {
    pub kind: WarningKind,
    pub move_index: usize,
    /// Rapid and gouge: how deep, mm; collisions: how far the stock reached into the shank or
    /// holder, mm.
    pub depth: f64,
    /// Rapid: removed volume, mm³; gouge: cells cut below the part.
    pub amount: f64,
    /// Where (x, y, z).
    pub at: [f64; 3],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimOptions {
    /// A rapid removing more than this (mm³) is a warning.
    pub rapid_volume: f64,
    /// A snapshot every this many moves (doubled whenever the budget below is reached).
    pub checkpoint_interval: usize,
    /// The memory snapshots may take, bytes.
    pub checkpoint_budget: usize,
}

impl Default for SimOptions {
    fn default() -> Self {
        Self {
            rapid_volume: 1e-3,
            checkpoint_interval: 250,
            checkpoint_budget: 64 * 1024 * 1024,
        }
    }
}

pub struct Simulator<M: MaterialModel = ZMap> {
    model: M,
    tools: Vec<Tool>,
    moves: Vec<Move>,
    records: Vec<MoveRecord>,
    warnings: Vec<Warning>,
    cursor: usize,
    checkpoints: Vec<(usize, M::Snapshot)>,
    interval: usize,
    options: SimOptions,
}

impl<M: MaterialModel> Simulator<M> {
    pub fn new(model: M) -> Self {
        Self::with_options(model, SimOptions::default())
    }

    pub fn with_options(model: M, options: SimOptions) -> Self {
        Self {
            model,
            tools: Vec::new(),
            moves: Vec::new(),
            records: Vec::new(),
            warnings: Vec::new(),
            cursor: 0,
            checkpoints: Vec::new(),
            interval: options.checkpoint_interval.max(1),
            options,
        }
    }

    pub fn model(&self) -> &M {
        &self.model
    }

    /// The material, for setting it up (stock shape, part) before the first move is cut.
    pub fn model_mut(&mut self) -> Result<&mut M, SimError> {
        if !self.records.is_empty() {
            return Err(SimError::new("the stock cannot change once moves have been cut"));
        }
        Ok(&mut self.model)
    }

    pub fn add_tool(&mut self, tool: Tool) -> usize {
        self.tools.push(tool);
        self.tools.len() - 1
    }

    pub fn tools(&self) -> &[Tool] {
        &self.tools
    }

    /// Appends a move; its tool must have been added.
    pub fn push_move(&mut self, m: Move) -> Result<usize, SimError> {
        if m.tool >= self.tools.len() {
            return Err(SimError::new(format!(
                "move {} names tool {} of {}",
                self.moves.len(),
                m.tool,
                self.tools.len()
            )));
        }
        if !m.from.iter().chain(&m.to).all(|v| v.is_finite()) {
            return Err(SimError::new(format!(
                "move {} has a coordinate that is not finite",
                self.moves.len()
            )));
        }
        if let Some(axis) = m.axis
            && (!axis.iter().all(|v| v.is_finite()) || axis.iter().all(|&v| v == 0.0))
        {
            return Err(SimError::new(format!(
                "move {} has no tool axis direction",
                self.moves.len()
            )));
        }
        self.moves.push(m);
        Ok(self.moves.len() - 1)
    }

    pub fn moves(&self) -> &[Move] {
        &self.moves
    }

    /// The moves cut so far (the material is the stock after `moves[..cursor]`).
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// Records of every move cut at least once, in order.
    pub fn records(&self) -> &[MoveRecord] {
        &self.records
    }

    /// Warnings of every move cut at least once, in move order.
    pub fn warnings(&self) -> &[Warning] {
        &self.warnings
    }

    /// Cuts up to `count` more moves; returns the new cursor.
    pub fn run(&mut self, count: usize) -> usize {
        let end = self.cursor.saturating_add(count).min(self.moves.len());
        while self.cursor < end {
            self.step();
        }
        self.cursor
    }

    /// Puts the material in its state after the first `index` moves (clamped to the program).
    pub fn seek(&mut self, index: usize) {
        let index = index.min(self.moves.len());
        if index < self.cursor {
            let position = self.checkpoints.iter().rposition(|(at, _)| *at <= index);
            if let Some(position) = position {
                let (at, snapshot) = &self.checkpoints[position];
                self.model.restore(snapshot);
                self.cursor = *at;
            }
        }
        self.run(index - self.cursor.min(index));
    }

    fn step(&mut self) {
        let index = self.cursor;
        let first_pass = index == self.records.len();
        if first_pass && self.checkpoint_due(index) {
            self.checkpoint(index);
        }
        let m = self.moves[index];
        let axis_from = if index > 0 {
            self.moves[index - 1].axis
        } else {
            None
        }
        .unwrap_or([0.0, 0.0, 1.0]);
        let axis_to = m.axis.unwrap_or([0.0, 0.0, 1.0]);
        let sweep = Sweep {
            from: m.from,
            to: m.to,
            axis_from,
            axis_to,
        };
        let report = self.model.cut(&self.tools[m.tool], &sweep);
        if first_pass {
            self.records.push(MoveRecord {
                removed: report.removed,
                depth: report.max_depth,
            });
            self.record_warnings(index, &m, &report);
        }
        self.cursor += 1;
    }

    fn checkpoint_due(&self, index: usize) -> bool {
        match self.checkpoints.last() {
            None => true,
            Some((at, _)) => index >= at + self.interval,
        }
    }

    fn checkpoint(&mut self, index: usize) {
        let bytes = self.model.snapshot_bytes().max(1);
        let budget = (self.options.checkpoint_budget / bytes).max(2);
        if self.checkpoints.len() >= budget {
            // Keep the first and every other one; snapshot half as often from now on.
            let mut keep = 0;
            self.checkpoints.retain(|_| {
                keep += 1;
                keep % 2 == 1
            });
            self.interval *= 2;
            if !self.checkpoint_due(index) {
                return;
            }
        }
        self.checkpoints.push((index, self.model.snapshot()));
    }

    fn record_warnings(&mut self, index: usize, m: &Move, report: &CutReport) {
        let warning = |kind, depth, amount, at| Warning {
            kind,
            move_index: index,
            depth,
            amount,
            at,
        };
        if report.unsupported {
            self.warnings
                .push(warning(WarningKind::Unsupported, 0.0, 0.0, m.to));
            return;
        }
        if m.rapid && report.removed > self.options.rapid_volume {
            self.warnings.push(warning(
                WarningKind::RapidInStock,
                report.max_depth,
                report.removed,
                report.deepest,
            ));
        }
        if let Some(contact) = report.shank {
            self.warnings.push(warning(
                WarningKind::ShankCollision,
                contact.depth,
                0.0,
                contact.at,
            ));
        }
        if let Some(contact) = report.holder {
            self.warnings.push(warning(
                WarningKind::HolderCollision,
                contact.depth,
                0.0,
                contact.at,
            ));
        }
        if let Some(gouge) = report.gouge {
            self.warnings.push(warning(
                WarningKind::Gouge,
                gouge.depth,
                gouge.cells as f64,
                gouge.at,
            ));
        }
    }
}
