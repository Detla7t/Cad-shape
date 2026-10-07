// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

use crate::grid::Grid;
use crate::{Paths, Result};
use i_overlay::core::fill_rule::FillRule as EngineFill;
use i_overlay::core::overlay::{Overlay, ShapeType};
use i_overlay::core::overlay_rule::OverlayRule;

/// Which points a set of loops fills, by their winding number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FillRule {
    /// An odd winding number.
    EvenOdd,
    /// Any winding number but zero.
    #[default]
    NonZero,
    /// A positive winding number (counter-clockwise loops add, clockwise ones cut).
    Positive,
    /// A negative winding number.
    Negative,
}

impl FillRule {
    pub(crate) fn engine(self) -> EngineFill {
        match self {
            Self::EvenOdd => EngineFill::EvenOdd,
            Self::NonZero => EngineFill::NonZero,
            Self::Positive => EngineFill::Positive,
            Self::Negative => EngineFill::Negative,
        }
    }

    pub(crate) fn fills(self, winding: i32) -> bool {
        match self {
            Self::EvenOdd => winding % 2 != 0,
            Self::NonZero => winding != 0,
            Self::Positive => winding > 0,
            Self::Negative => winding < 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanOp {
    Union,
    /// Subject minus clip.
    Difference,
    Intersection,
    /// In exactly one of subject and clip.
    Xor,
}

/// A boolean of two regions, each filled by `fill` over its own loops (so loops of one
/// operand may overlap or self-intersect). Returns clean loops: outer boundaries
/// counter-clockwise, each followed by its holes (clockwise), collinear points removed.
pub fn boolean(op: BooleanOp, subject: &Paths, clip: &Paths, fill: FillRule, scale: f64) -> Result<Paths> {
    let grid = Grid::new(scale, &[subject, clip], 0.0)?;
    let subject = grid.contours(subject);
    let clip = grid.contours(clip);
    let mut out = Paths::new();
    if subject.is_empty() && clip.is_empty() {
        return Ok(out);
    }
    let capacity = subject.iter().chain(&clip).map(Vec::len).sum();
    let mut overlay = Overlay::<i32>::new(capacity);
    overlay.add_source(&subject, ShapeType::Subject);
    overlay.add_source(&clip, ShapeType::Clip);
    let rule = match op {
        BooleanOp::Union => OverlayRule::Union,
        BooleanOp::Difference => OverlayRule::Difference,
        BooleanOp::Intersection => OverlayRule::Intersect,
        BooleanOp::Xor => OverlayRule::Xor,
    };
    grid.push_shapes(&overlay.overlay(rule, fill.engine()), &mut out);
    Ok(out)
}

/// The region a set of loops fills by `fill`, as clean loops (self-intersections and overlaps
/// resolved): the union of the loops alone.
pub fn simplify(loops: &Paths, fill: FillRule, scale: f64) -> Result<Paths> {
    boolean(BooleanOp::Union, loops, &Paths::new(), fill, scale)
}
