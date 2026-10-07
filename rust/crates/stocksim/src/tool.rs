// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! A cutting tool as the simulation sees it: the cutting profile, the flutes above it (the
//! cylinder of the profile's radius up to the flute length), the non-cutting shank above the
//! flutes and the holder above the stick-out. Lengths are measured up the axis from the tip.

use crate::profile::{Profile, ProfileError};

/// The tool holder: a cylinder of `radius` from `offset` above the tip (the stick-out) up
/// `length`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Holder {
    pub radius: f64,
    pub offset: f64,
    pub length: f64,
}

/// One tool: what cuts, and what must not touch the stock.
#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    profile: Profile,
    flute_length: f64,
    shank_radius: f64,
    holder: Option<Holder>,
}

impl Tool {
    /// A tool cutting with `profile` along its whole length (no shank, no holder).
    pub fn new(profile: Profile) -> Self {
        let shank_radius = profile.radius();
        Self {
            profile,
            flute_length: f64::INFINITY,
            shank_radius,
            holder: None,
        }
    }

    /// The flutes cut up to `length` above the tip (at least the profile's own height);
    /// above them is the shank.
    pub fn with_flutes(mut self, length: f64) -> Result<Self, ProfileError> {
        if length.is_nan() || length <= 0.0 {
            return Err(ProfileError("the flute length must be positive".into()));
        }
        self.flute_length = length.max(self.profile.rim_height());
        Ok(self)
    }

    /// The radius of the shank above the flutes (the cutting radius by default; 0 for none).
    pub fn with_shank(mut self, radius: f64) -> Result<Self, ProfileError> {
        if !(radius.is_finite() && radius >= 0.0) {
            return Err(ProfileError("the shank radius must not be negative".into()));
        }
        self.shank_radius = radius;
        Ok(self)
    }

    pub fn with_holder(mut self, holder: Holder) -> Result<Self, ProfileError> {
        if !(holder.radius > 0.0 && holder.radius.is_finite()) {
            return Err(ProfileError("the holder radius must be positive".into()));
        }
        if !(holder.offset > 0.0 && holder.offset.is_finite()) {
            return Err(ProfileError(
                "the holder must sit above the tip (positive stick-out)".into(),
            ));
        }
        if holder.length.is_nan() || holder.length <= 0.0 {
            return Err(ProfileError("the holder length must be positive".into()));
        }
        self.holder = Some(holder);
        if self.flute_length > holder.offset {
            self.flute_length = holder.offset.max(self.profile.rim_height());
        }
        Ok(self)
    }

    pub fn profile(&self) -> &Profile {
        &self.profile
    }

    pub fn radius(&self) -> f64 {
        self.profile.radius()
    }

    pub fn flute_length(&self) -> f64 {
        self.flute_length
    }

    pub fn shank_radius(&self) -> f64 {
        self.shank_radius
    }

    pub fn holder(&self) -> Option<Holder> {
        self.holder
    }

    /// Whether a shank above finite flutes can touch the stock.
    pub fn has_shank(&self) -> bool {
        self.flute_length.is_finite() && self.shank_radius > 0.0
    }

    /// The farthest any part of the tool reaches from its axis (cutting or not).
    pub fn reach(&self) -> f64 {
        let mut reach = self.radius();
        if self.has_shank() {
            reach = reach.max(self.shank_radius);
        }
        if let Some(holder) = self.holder {
            reach = reach.max(holder.radius);
        }
        reach
    }

    /// The lowest height above the tip where a non-cutting part starts.
    pub fn non_cutting_start(&self) -> f64 {
        let mut start = f64::INFINITY;
        if self.has_shank() {
            start = self.flute_length;
        }
        if let Some(holder) = self.holder {
            start = start.min(holder.offset);
        }
        start
    }
}
