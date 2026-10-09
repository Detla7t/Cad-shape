// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! Stock material-removal simulation for CAM.
//!
//! The stock is a material model ([`MaterialModel`]); the 3-axis one is a Z-map ([`ZMap`]): a
//! grid of material columns, each cut down to the exact lower envelope of the tool swept
//! along a straight move ([`Profile::sweep_low`] — closed forms for flat, ball, bull nose and
//! cone/drill profiles, a bracketed one-dimensional minimisation for any other convex APT
//! chain). Tools ([`Tool`]) add the flutes' length, the shank and the holder, which are
//! checked against the material they pass over. The [`Simulator`] cuts a program of moves a
//! range at a time, records what each move removed and warns of rapids that cut, shank and
//! holder collisions and — against a part rasterised into the same grid — gouges; the stock
//! comes out as a decimated triangle mesh ([`StockMesh`]) with a per-vertex deviation from the
//! part. Moves carry a tool axis, so a tri-dexel model for tilted tools can implement
//! [`MaterialModel`] and reuse the rest.
//!
//! Units: millimetres; the moves' frame (the setup's WCS) is the model's.

pub mod grid;
pub mod mesh;
pub mod model;
pub mod profile;
pub mod raster;
pub mod sim;
pub mod tool;
pub mod zmap;

pub use grid::Grid;
pub use mesh::{MeshOptions, StockMesh};
pub use model::{Comparison, Contact, CutReport, GougeReport, MaterialModel, Sweep};
pub use profile::{Piece, Profile, ProfileError, ProfileKind};
pub use sim::{Move, MoveRecord, SimOptions, Simulator, Warning, WarningKind};
pub use tool::{Holder, Tool};
pub use zmap::{ZMap, ZMapOptions};

/// Why a simulation input was refused.
#[derive(Clone, Debug, PartialEq)]
pub struct SimError(pub String);

impl SimError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SimError {}

impl From<ProfileError> for SimError {
    fn from(error: ProfileError) -> Self {
        Self(error.0)
    }
}
