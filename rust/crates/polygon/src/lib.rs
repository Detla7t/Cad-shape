// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! 2D polygon operations for the CAM kernels, in millimetres.
//!
//! Booleans and offsets run on [i_overlay](https://github.com/iShape-Rust/iOverlay) (MIT /
//! Apache-2.0): coordinates snap to a fixed integer grid of `scale` units per millimetre
//! (anchored on a grid point near the input's centre, so results land on the same absolute grid
//! whatever the input), and i_overlay's 32-bit engine resolves every intersection exactly on it.
//! Results come back as loops in the CAM orientation: outer boundaries counter-clockwise, holes
//! clockwise, each outer loop followed by its holes.
//!
//! Open-path clipping and loop nesting are exact float geometry here: i_overlay clips open
//! paths through one shared graph, so crossing input lines are spliced into one another at
//! their crossing and duplicates collapse — wrong for toolpaths, which must keep every input
//! polyline's identity and direction.
//!
//! Paths cross the API as [`Paths`]: flat `x, y` coordinates and a point count per path — the
//! layout the WebAssembly boundary passes as typed arrays.

mod boolean;
mod clip;
mod grid;
mod nesting;
mod offset;
mod paths;

pub use boolean::{BooleanOp, FillRule, boolean, simplify};
pub use clip::{Keep, clip_polylines};
pub use nesting::{Nesting, nesting};
pub use offset::{Join, offset};
pub use paths::{Paths, signed_area};

/// The default grid: 10 000 units per millimetre (0.1 µm), ±53 m around the input's centre.
pub const DEFAULT_SCALE: f64 = 1e4;

/// Why an operation refused its input.
#[derive(Debug, Clone, PartialEq)]
pub enum PolygonError {
    /// The coordinate count is not twice the sum of the path lengths.
    LengthMismatch { coordinates: usize, points: usize },
    /// A coordinate is NaN or infinite.
    NonFinite,
    /// The input (plus the offset) does not fit the integer grid at this scale.
    OutOfRange { extent: f64, limit: f64 },
    /// A parameter is out of its domain (the message names it).
    InvalidParameter(&'static str),
}

impl core::fmt::Display for PolygonError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::LengthMismatch { coordinates, points } => write!(
                f,
                "{coordinates} coordinates do not match path lengths totalling {points} points"
            ),
            Self::NonFinite => f.write_str("coordinates must be finite"),
            Self::OutOfRange { extent, limit } => write!(
                f,
                "the geometry spans {extent} mm from its centre, beyond the {limit} mm the grid holds"
            ),
            Self::InvalidParameter(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for PolygonError {}

pub type Result<T> = core::result::Result<T, PolygonError>;
