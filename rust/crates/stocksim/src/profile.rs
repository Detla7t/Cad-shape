// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! Tool profiles: the lower surface of an axially symmetric cutter as the height `h(d)` of its
//! cutting surface above the tip at radial distance `d` from the axis, for `0 ≤ d ≤ R`. Every
//! profile is a chain of pieces — straight lines (flat bottoms, cones) and lower circular arcs
//! (ball and corner radii) — that is continuous, non-decreasing and convex, as APT tool
//! definitions are. Above the profile the cutter is the cylinder of its radius.
//!
//! The one question the simulation asks of a profile is the lower envelope of the tool swept
//! along a straight move, above one point: in the move's vertical plane through the point the
//! tool tip travels along `z(s) = z₀ + m·s` and the point sits at a distance
//! `d(s) = √(e² + (s − s₀)²)` from the axis, so the envelope is `min_s z(s) + h(d(s))`. With `h`
//! convex and non-decreasing and `d` convex in `s`, that is a convex one-dimensional problem:
//! [`Profile::sweep_low`] solves it in closed form for flat, ball, bull nose and cone (V-bit,
//! chamfer, drill) profiles, and by bracketed bisection on the monotone derivative for any other
//! convex chain.

/// One piece of a profile, over `d0 ≤ d ≤ d1`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Piece {
    /// `h = h0 + slope·(d − d0)`.
    Line { d0: f64, d1: f64, h0: f64, slope: f64 },
    /// The lower arc of the circle centred at `(cd, ch)` with radius `rho`:
    /// `h = ch − √(rho² − (d − cd)²)`.
    Arc {
        d0: f64,
        d1: f64,
        cd: f64,
        ch: f64,
        rho: f64,
    },
}

impl Piece {
    fn start(&self) -> f64 {
        match *self {
            Piece::Line { d0, .. } | Piece::Arc { d0, .. } => d0,
        }
    }

    fn end(&self) -> f64 {
        match *self {
            Piece::Line { d1, .. } | Piece::Arc { d1, .. } => d1,
        }
    }

    fn height(&self, d: f64) -> f64 {
        match *self {
            Piece::Line { d0, h0, slope, .. } => h0 + slope * (d - d0),
            Piece::Arc { cd, ch, rho, .. } => {
                let u = d - cd;
                ch - (rho * rho - u * u).max(0.0).sqrt()
            }
        }
    }

    fn slope(&self, d: f64) -> f64 {
        match *self {
            Piece::Line { slope, .. } => slope,
            Piece::Arc { cd, rho, .. } => {
                let u = d - cd;
                let w = rho * rho - u * u;
                if w <= 0.0 { f64::INFINITY } else { u / w.sqrt() }
            }
        }
    }
}

/// Which closed form [`Profile::sweep_low`] uses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ProfileKind {
    /// Flat end mill: `h = 0`.
    Flat,
    /// Ball end mill: `h = R − √(R² − d²)`.
    Ball,
    /// Bull nose (torus): a flat bottom of radius `flat`, then a corner of radius `corner`.
    Bull { flat: f64, corner: f64 },
    /// V-bit, chamfer mill, spot drill, drill: a flat tip of radius `flat` (0 for a point),
    /// then a cone rising `slope` (cot of the half angle) per unit of radius.
    Cone { flat: f64, slope: f64 },
    /// Any other convex chain of lines and arcs (a tapered ball mill, an APT definition).
    General,
}

/// Why a profile could not be made.
#[derive(Clone, Debug, PartialEq)]
pub struct ProfileError(pub String);

impl std::fmt::Display for ProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProfileError {}

fn err<T>(message: impl Into<String>) -> Result<T, ProfileError> {
    Err(ProfileError(message.into()))
}

fn positive(value: f64, what: &str) -> Result<f64, ProfileError> {
    if value.is_finite() && value > 0.0 {
        Ok(value)
    } else {
        err(format!("{what} must be positive"))
    }
}

/// An axially symmetric cutting profile (see the module notes).
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    kind: ProfileKind,
    radius: f64,
    pieces: Vec<Piece>,
}

/// The cot of half an included angle given in degrees (1° … 179°).
fn half_angle_slope(included_degrees: f64) -> Result<f64, ProfileError> {
    if !(included_degrees.is_finite() && included_degrees > 0.0 && included_degrees < 180.0) {
        return err("the included angle must be between 0° and 180°");
    }
    Ok(1.0 / (included_degrees.to_radians() / 2.0).tan())
}

impl Profile {
    /// A flat end mill of radius `radius`.
    pub fn flat(radius: f64) -> Result<Self, ProfileError> {
        let radius = positive(radius, "the tool radius")?;
        Ok(Self {
            kind: ProfileKind::Flat,
            radius,
            pieces: vec![Piece::Line {
                d0: 0.0,
                d1: radius,
                h0: 0.0,
                slope: 0.0,
            }],
        })
    }

    /// A ball end mill of radius `radius`.
    pub fn ball(radius: f64) -> Result<Self, ProfileError> {
        let radius = positive(radius, "the tool radius")?;
        Ok(Self {
            kind: ProfileKind::Ball,
            radius,
            pieces: vec![Piece::Arc {
                d0: 0.0,
                d1: radius,
                cd: 0.0,
                ch: radius,
                rho: radius,
            }],
        })
    }

    /// A bull nose (torus) end mill: radius `radius`, corner radius `corner`. A corner of 0 is
    /// a flat end mill, one of the full radius a ball.
    pub fn bull(radius: f64, corner: f64) -> Result<Self, ProfileError> {
        let radius = positive(radius, "the tool radius")?;
        if !(corner.is_finite() && corner >= 0.0) {
            return err("the corner radius must not be negative");
        }
        if corner <= radius * 1e-9 {
            return Self::flat(radius);
        }
        if corner >= radius * (1.0 - 1e-9) {
            return Self::ball(radius);
        }
        let flat = radius - corner;
        Ok(Self {
            kind: ProfileKind::Bull { flat, corner },
            radius,
            pieces: vec![
                Piece::Line {
                    d0: 0.0,
                    d1: flat,
                    h0: 0.0,
                    slope: 0.0,
                },
                Piece::Arc {
                    d0: flat,
                    d1: radius,
                    cd: flat,
                    ch: corner,
                    rho: corner,
                },
            ],
        })
    }

    /// A cone (V-bit, chamfer mill, spot drill, engraver): `included_degrees` between the
    /// cutting edges, a flat tip of `tip_diameter` (0 for a sharp point), out to `radius`.
    pub fn cone(radius: f64, included_degrees: f64, tip_diameter: f64) -> Result<Self, ProfileError> {
        let radius = positive(radius, "the tool radius")?;
        let slope = half_angle_slope(included_degrees)?;
        if !(tip_diameter.is_finite() && tip_diameter >= 0.0) {
            return err("the tip diameter must not be negative");
        }
        let flat = tip_diameter / 2.0;
        if flat >= radius {
            return Self::flat(radius);
        }
        let mut pieces = Vec::with_capacity(2);
        if flat > 0.0 {
            pieces.push(Piece::Line {
                d0: 0.0,
                d1: flat,
                h0: 0.0,
                slope: 0.0,
            });
        }
        pieces.push(Piece::Line {
            d0: flat,
            d1: radius,
            h0: 0.0,
            slope,
        });
        Ok(Self {
            kind: ProfileKind::Cone { flat, slope },
            radius,
            pieces,
        })
    }

    /// A twist drill: a point of `point_degrees` (118°, 135°) out to `radius`.
    pub fn drill(radius: f64, point_degrees: f64) -> Result<Self, ProfileError> {
        Self::cone(radius, point_degrees, 0.0)
    }

    /// A tapered mill: a flat bottom of radius `flat`, a corner of radius `corner`, then flanks
    /// leaning out `taper_degrees` from the axis direction (per side) up to `radius` — a tapered
    /// ball mill has `flat = 0`. Evaluated by the general minimisation.
    pub fn tapered(flat: f64, corner: f64, taper_degrees: f64, radius: f64) -> Result<Self, ProfileError> {
        if !(flat.is_finite() && flat >= 0.0 && corner.is_finite() && corner >= 0.0) {
            return err("the flat and corner radii must not be negative");
        }
        if !(taper_degrees.is_finite() && taper_degrees > 0.0 && taper_degrees < 90.0) {
            return err("the taper angle must be between 0° and 90°");
        }
        let radius = positive(radius, "the tool radius")?;
        // The flank's slope dh/dd is cot(taper); the corner arc runs until its slope matches.
        let slope = 1.0 / taper_degrees.to_radians().tan();
        let hyp = (1.0 + slope * slope).sqrt();
        let arc_end = flat + corner * slope / hyp;
        let arc_end_height = corner * (1.0 - 1.0 / hyp);
        if arc_end >= radius {
            return err("the tool radius ends before the corner reaches the flank");
        }
        let mut pieces = Vec::with_capacity(3);
        if flat > 0.0 {
            pieces.push(Piece::Line {
                d0: 0.0,
                d1: flat,
                h0: 0.0,
                slope: 0.0,
            });
        }
        if corner > 0.0 {
            pieces.push(Piece::Arc {
                d0: flat,
                d1: arc_end,
                cd: flat,
                ch: corner,
                rho: corner,
            });
        }
        pieces.push(Piece::Line {
            d0: arc_end,
            d1: radius,
            h0: arc_end_height,
            slope,
        });
        Self::general(pieces)
    }

    /// Any profile as a chain of pieces from the axis outwards: it must start at the tip
    /// (`d = 0`, `h = 0`), be continuous, and its slope must never decrease (convex).
    pub fn general(pieces: Vec<Piece>) -> Result<Self, ProfileError> {
        let Some(first) = pieces.first() else {
            return err("a profile needs at least one piece");
        };
        if first.start().abs() > 1e-12 || first.height(first.start()).abs() > 1e-9 {
            return err("a profile starts at the tool tip");
        }
        let mut last_slope = 0.0;
        for (index, piece) in pieces.iter().enumerate() {
            let (d0, d1) = (piece.start(), piece.end());
            if !(d0.is_finite() && d1.is_finite() && d1 > d0) {
                return err(format!("profile piece {index} is empty"));
            }
            if let Piece::Arc { cd, ch, rho, .. } = *piece
                && !(rho > 0.0 && d0 >= cd - 1e-9 && d1 <= cd + rho + 1e-9 && ch.is_finite())
            {
                return err(format!(
                    "profile piece {index} is not a lower arc rising outwards"
                ));
            }
            if index > 0 {
                let previous = pieces[index - 1];
                if (previous.end() - d0).abs() > 1e-9 {
                    return err(format!(
                        "profile piece {index} does not start where piece {} ends",
                        index - 1
                    ));
                }
                if (previous.height(d0) - piece.height(d0)).abs() > 1e-6 {
                    return err(format!(
                        "profile piece {index} is not continuous with piece {}",
                        index - 1
                    ));
                }
            }
            let (s0, s1) = (piece.slope(d0), piece.slope(d1));
            if s0 < last_slope - 1e-9 || s1 < s0 - 1e-9 || s0 < -1e-12 {
                return err(format!(
                    "profile piece {index} makes the profile concave or falling"
                ));
            }
            last_slope = s1;
        }
        let radius = pieces.last().map(Piece::end).unwrap_or_default();
        Ok(Self {
            kind: ProfileKind::General,
            radius,
            pieces,
        })
    }

    /// The same chain evaluated by the general minimisation (for cross-checks).
    pub fn as_general(&self) -> Self {
        Self {
            kind: ProfileKind::General,
            ..self.clone()
        }
    }

    pub fn kind(&self) -> ProfileKind {
        self.kind
    }

    /// The footprint radius.
    pub fn radius(&self) -> f64 {
        self.radius
    }

    pub fn pieces(&self) -> &[Piece] {
        &self.pieces
    }

    fn piece_at(&self, d: f64) -> &Piece {
        self.pieces
            .iter()
            .find(|piece| d <= piece.end())
            .unwrap_or_else(|| self.pieces.last().unwrap())
    }

    /// Height of the cutting surface above the tip at radial distance `d` (clamped to the
    /// footprint).
    pub fn height(&self, d: f64) -> f64 {
        let d = d.clamp(0.0, self.radius);
        match self.kind {
            ProfileKind::Flat => 0.0,
            ProfileKind::Ball => self.radius - (self.radius * self.radius - d * d).max(0.0).sqrt(),
            _ => self.piece_at(d).height(d),
        }
    }

    /// Height of the profile at its rim (where the cylinder of the flutes starts).
    pub fn rim_height(&self) -> f64 {
        self.height(self.radius)
    }

    /// `dh/dd` at `d`: infinite where an arc turns vertical. At a kink, the outer piece's.
    pub fn slope(&self, d: f64) -> f64 {
        let d = d.clamp(0.0, self.radius);
        let piece = self
            .pieces
            .iter()
            .find(|piece| d < piece.end())
            .unwrap_or_else(|| self.pieces.last().unwrap());
        piece.slope(d)
    }

    /// The lowest point of the swept tool's lower surface above a point, relative to the
    /// move's start height (see the module notes): `e2` is the squared distance of the point
    /// from the move's line in XY, `s0` its position along it, `len` the move's XY length and
    /// `m` its slope (dz per unit of XY travel). `None` when the tool never covers the point.
    #[inline]
    pub fn sweep_low(&self, e2: f64, s0: f64, len: f64, m: f64) -> Option<f64> {
        let r2 = self.radius * self.radius;
        if e2 > r2 {
            return None;
        }
        let half = (r2 - e2).sqrt();
        // w = s − s0: the tool's position along the move relative to the point's projection.
        let w_lo = (-s0).max(-half);
        let w_hi = (len - s0).min(half);
        if w_lo > w_hi {
            return None;
        }
        let base = m * s0;
        let value = match self.kind {
            ProfileKind::Flat => {
                if m >= 0.0 {
                    m * w_lo
                } else {
                    m * w_hi
                }
            }
            _ if m == 0.0 => {
                let w = 0f64.clamp(w_lo, w_hi);
                self.height((e2 + w * w).sqrt())
            }
            ProfileKind::Ball => {
                // The vertical plane cuts the sphere in a circle of radius `half`; a line of
                // slope m touches it where (s − s0) = −m·half / √(1 + m²).
                let w = (-m * half / (1.0 + m * m).sqrt()).clamp(w_lo, w_hi);
                m * w + self.radius - (half * half - w * w).max(0.0).sqrt()
            }
            ProfileKind::Bull { flat, corner } => {
                let d = bull_contact(flat, corner, e2, m);
                let w = (-m.signum() * (d * d - e2).max(0.0).sqrt()).clamp(w_lo, w_hi);
                m * w + self.height((e2 + w * w).sqrt())
            }
            ProfileKind::Cone { flat, slope } => {
                let w = cone_contact(flat, slope, e2, half, m).clamp(w_lo, w_hi);
                m * w + self.height((e2 + w * w).sqrt())
            }
            ProfileKind::General => self.minimise(e2, w_lo, w_hi, m),
        };
        Some(base + value)
    }

    /// The general case: the minimum over `[w_lo, w_hi]` of the convex `m·w + h(√(e2 + w²))`,
    /// by bisection on the sign of its (monotone, possibly jumping) derivative.
    fn minimise(&self, e2: f64, w_lo: f64, w_hi: f64, m: f64) -> f64 {
        let derivative = |w: f64| {
            let d = (e2 + w * w).sqrt();
            if d <= 1e-300 {
                return m;
            }
            let slope = self.slope(d);
            if slope.is_infinite() {
                return if w > 0.0 {
                    f64::INFINITY
                } else if w < 0.0 {
                    f64::NEG_INFINITY
                } else {
                    m
                };
            }
            m + slope * w / d
        };
        let value = |w: f64| m * w + self.height((e2 + w * w).sqrt());
        if derivative(w_lo) >= 0.0 {
            return value(w_lo);
        }
        if derivative(w_hi) <= 0.0 {
            return value(w_hi);
        }
        let (mut lo, mut hi) = (w_lo, w_hi);
        let tolerance = 1e-10 * self.radius.max(1.0);
        for _ in 0..100 {
            if hi - lo <= tolerance {
                break;
            }
            let mid = 0.5 * (lo + hi);
            let g = derivative(mid);
            if g > 0.0 {
                hi = mid;
            } else if g < 0.0 {
                lo = mid;
            } else {
                return value(mid);
            }
        }
        value(lo).min(value(hi)).min(value(0.5 * (lo + hi)))
    }
}

/// The unconstrained minimiser `w` of a cone profile's `m·w + h(√(e2 + w²))` on
/// `|w| ≤ half` (`m ≠ 0`).
#[inline]
fn cone_contact(flat: f64, slope: f64, e2: f64, half: f64, m: f64) -> f64 {
    let sign = m.signum();
    if m.abs() >= slope {
        // Steeper than the flank: the lowest point is at the rim.
        return -sign * half;
    }
    let root = (slope * slope - m * m).sqrt();
    let e = e2.sqrt();
    let d = e * slope / root;
    if d <= flat {
        // The flank's tangent point would lie inside the flat tip: the edge of the tip.
        return -sign * (flat * flat - e2).max(0.0).sqrt();
    }
    let w = -sign * m.abs() * e / root;
    if w.abs() > half { -sign * half } else { w }
}

/// The radial distance of a bull nose's contact with a line of slope `m` (≠ 0) passing at
/// distance √e2 from its axis: the unique root, in the corner's meridian sine
/// `t ∈ [|m|/√(1+m²), 1]`, of `(flat + corner·t)²·((1+m²)t² − m²) = e2·t²` — a quartic, solved
/// in closed form (Ferrari) and polished; a safeguarded Newton iteration on the monotone
/// form takes over should the closed form lose the root to rounding.
#[inline]
fn bull_contact(flat: f64, corner: f64, e2: f64, m: f64) -> f64 {
    let a = 1.0 + m * m;
    let b = m * m;
    let t_min = (b / a).sqrt();
    // g(t) = (flat + corner·t)²(a − b/t²) − e2 is increasing on [t_min, 1].
    let g = |t: f64| {
        let d = flat + corner * t;
        d * d * (a - b / (t * t)) - e2
    };
    let dg = |t: f64| {
        let d = flat + corner * t;
        2.0 * corner * d * (a - b / (t * t)) + d * d * 2.0 * b / (t * t * t)
    };
    if g(1.0) <= 0.0 {
        return flat + corner;
    }
    if g(t_min) >= 0.0 {
        return flat + corner * t_min;
    }
    let scale = (flat + corner).powi(2);
    let mut lo = t_min;
    let mut hi = 1.0;
    let mut t = bull_quartic_root(flat, corner, e2, m).unwrap_or(f64::NAN);
    if !t.is_finite() {
        t = 0.5 * (lo + hi);
    }
    // Polish (and, when the closed form failed, converge): Newton kept inside the bracket.
    for _ in 0..60 {
        let value = g(t);
        if value.abs() <= 1e-15 * scale {
            break;
        }
        if value < 0.0 {
            lo = t;
        } else {
            hi = t;
        }
        let slope = dg(t);
        let mut next = t - value / slope;
        if !(next > lo && next < hi) {
            next = 0.5 * (lo + hi);
        }
        if (next - t).abs() <= 1e-16 {
            t = next;
            break;
        }
        t = next;
    }
    flat + corner * t
}

/// The closed-form (Ferrari) root of the bull nose contact quartic in `[t_min, 1]` (see
/// `bull_contact`), unpolished; `None` if rounding lost it.
fn bull_quartic_root(flat: f64, corner: f64, e2: f64, m: f64) -> Option<f64> {
    let a = 1.0 + m * m;
    let b = m * m;
    let t_min = (b / a).sqrt();
    let (roots, count) = quartic_roots(
        a * corner * corner,
        2.0 * a * flat * corner,
        a * flat * flat - b * corner * corner - e2,
        -2.0 * b * flat * corner,
        -b * flat * flat,
    );
    roots[..count]
        .iter()
        .copied()
        .find(|&root| root >= t_min - 1e-9 && root <= 1.0 + 1e-9)
        .map(|t| t.clamp(t_min, 1.0))
}

/// Real roots of `c4·x⁴ + c3·x³ + c2·x² + c1·x + c0` (Ferrari's method; lower degrees when the
/// leading coefficients vanish).
pub fn quartic_roots(c4: f64, c3: f64, c2: f64, c1: f64, c0: f64) -> ([f64; 4], usize) {
    let mut out = [0.0; 4];
    let scale = c4.abs().max(c3.abs()).max(c2.abs()).max(c1.abs()).max(c0.abs());
    if scale == 0.0 {
        return (out, 0);
    }
    if c4.abs() <= 1e-14 * scale {
        let (roots, count) = cubic_roots(c3, c2, c1, c0);
        out[..count].copy_from_slice(&roots[..count]);
        return (out, count);
    }
    let a = c3 / c4;
    let b = c2 / c4;
    let c = c1 / c4;
    let d = c0 / c4;
    // x = y − a/4: y⁴ + p y² + q y + r = 0.
    let a2 = a * a;
    let p = b - 3.0 * a2 / 8.0;
    let q = c - a * b / 2.0 + a2 * a / 8.0;
    let r = d - a * c / 4.0 + a2 * b / 16.0 - 3.0 * a2 * a2 / 256.0;
    let shift = -a / 4.0;
    let mut count = 0;
    let mut push = |y: f64, count: &mut usize| {
        if *count < 4 {
            out[*count] = y + shift;
            *count += 1;
        }
    };
    let magnitude = p.abs().max(r.abs().sqrt()).max(1e-300);
    if q.abs() <= 1e-14 * magnitude * magnitude.sqrt() {
        // Biquadratic: y² = (−p ± √(p² − 4r)) / 2.
        let disc = p * p - 4.0 * r;
        if disc >= 0.0 {
            let root = disc.sqrt();
            for z in [(-p + root) / 2.0, (-p - root) / 2.0] {
                if z >= 0.0 {
                    let y = z.sqrt();
                    push(y, &mut count);
                    push(-y, &mut count);
                }
            }
        }
        return (out, count);
    }
    // Resolvent: z³ + 2p z² + (p² − 4r) z − q² = 0 has a positive root z = α².
    let (roots, n) = cubic_roots(1.0, 2.0 * p, p * p - 4.0 * r, -q * q);
    let z = roots[..n].iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if z.is_nan() || z <= 0.0 {
        return (out, 0);
    }
    let alpha = z.sqrt();
    let beta = (p + z - q / alpha) / 2.0;
    let gamma = (p + z + q / alpha) / 2.0;
    for (linear, constant) in [(alpha, beta), (-alpha, gamma)] {
        let disc = linear * linear - 4.0 * constant;
        if disc >= 0.0 {
            let root = disc.sqrt();
            push((-linear + root) / 2.0, &mut count);
            push((-linear - root) / 2.0, &mut count);
        }
    }
    (out, count)
}

/// Real roots of `c3·x³ + c2·x² + c1·x + c0`, Newton-polished.
pub fn cubic_roots(c3: f64, c2: f64, c1: f64, c0: f64) -> ([f64; 3], usize) {
    let mut out = [0.0; 3];
    let scale = c3.abs().max(c2.abs()).max(c1.abs()).max(c0.abs());
    if scale == 0.0 {
        return (out, 0);
    }
    if c3.abs() <= 1e-14 * scale {
        if c2.abs() <= 1e-14 * scale {
            if c1 == 0.0 {
                return (out, 0);
            }
            out[0] = -c0 / c1;
            return (out, 1);
        }
        let disc = c1 * c1 - 4.0 * c2 * c0;
        if disc < 0.0 {
            return (out, 0);
        }
        let root = disc.sqrt();
        let q = -0.5 * (c1 + c1.signum() * root);
        let mut count = 0;
        if q != 0.0 {
            out[count] = q / c2;
            count += 1;
            out[count] = c0 / q;
            count += 1;
        } else {
            out[count] = 0.0;
            count += 1;
        }
        return (out, count);
    }
    let a = c2 / c3;
    let b = c1 / c3;
    let c = c0 / c3;
    // x = t − a/3: t³ + P t + Q = 0.
    let p = b - a * a / 3.0;
    let q = 2.0 * a * a * a / 27.0 - a * b / 3.0 + c;
    let shift = -a / 3.0;
    let disc = (q / 2.0).powi(2) + (p / 3.0).powi(3);
    let count;
    if disc > 0.0 {
        let root = disc.sqrt();
        let u = (-q / 2.0 + root).cbrt();
        let v = (-q / 2.0 - root).cbrt();
        out[0] = u + v + shift;
        count = 1;
    } else if p == 0.0 {
        out[0] = shift;
        count = 1;
    } else {
        let radius = 2.0 * (-p / 3.0).sqrt();
        let cos = ((3.0 * q) / (p * radius)).clamp(-1.0, 1.0);
        let phi = cos.acos() / 3.0;
        for (k, root) in out.iter_mut().enumerate() {
            *root = radius * (phi - 2.0 * std::f64::consts::PI * k as f64 / 3.0).cos() + shift;
        }
        count = 3;
    }
    for root in out.iter_mut().take(count) {
        for _ in 0..2 {
            let x = *root;
            let f = ((x + a) * x + b) * x + c;
            let df = (3.0 * x + 2.0 * a) * x + b;
            if df != 0.0 {
                let next = x - f / df;
                if next.is_finite() {
                    *root = next;
                }
            }
        }
    }
    if count == 3 {
        out.sort_by(|x, y| y.total_cmp(x));
    }
    (out, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The envelope by dense sampling of the tool's positions along the move.
    fn brute(profile: &Profile, e2: f64, s0: f64, len: f64, m: f64) -> Option<f64> {
        let n = 200_000;
        let mut best: Option<f64> = None;
        for i in 0..=n {
            let s = len * i as f64 / n as f64;
            let d2 = e2 + (s - s0) * (s - s0);
            if d2 > profile.radius() * profile.radius() {
                continue;
            }
            let z = m * s + profile.height(d2.sqrt());
            best = Some(best.map_or(z, |b: f64| b.min(z)));
        }
        best
    }

    fn profiles() -> Vec<Profile> {
        vec![
            Profile::flat(5.0).unwrap(),
            Profile::ball(3.0).unwrap(),
            Profile::bull(5.0, 1.0).unwrap(),
            Profile::bull(4.0, 3.0).unwrap(),
            Profile::cone(6.0, 90.0, 0.0).unwrap(),
            Profile::cone(6.0, 60.0, 1.0).unwrap(),
            Profile::drill(4.0, 118.0).unwrap(),
            Profile::tapered(0.0, 1.5, 10.0, 4.0).unwrap(),
            Profile::tapered(1.0, 0.5, 30.0, 3.0).unwrap(),
        ]
    }

    #[test]
    fn closed_forms_match_the_general_minimisation_and_sampling() {
        let mut seed = 12345u64;
        let mut random = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        for profile in profiles() {
            let general = profile.as_general();
            let r = profile.radius();
            for case in 0..400 {
                let len = if case % 7 == 0 { 0.0 } else { random() * 20.0 };
                let s0 = -r + random() * (len + 2.0 * r);
                let e = random() * r * 1.02;
                let m = match case % 5 {
                    0 => 0.0,
                    1 => (random() - 0.5) * 0.4,
                    2 => (random() - 0.5) * 4.0,
                    3 => (random() - 0.5) * 40.0,
                    _ => (random() - 0.5) * 2.0,
                };
                let closed = profile.sweep_low(e * e, s0, len, m);
                let solved = general.sweep_low(e * e, s0, len, m);
                assert_eq!(
                    closed.is_some(),
                    solved.is_some(),
                    "{profile:?} e={e} s0={s0} len={len} m={m}"
                );
                if let (Some(a), Some(b)) = (closed, solved) {
                    assert!(
                        (a - b).abs() < 1e-7,
                        "{:?}: closed {a} general {b} (e={e} s0={s0} m={m})",
                        profile.kind()
                    );
                    if case % 20 == 0 {
                        let c = brute(&profile, e * e, s0, len, m).unwrap_or(a);
                        // Sampling can only find the minimum or a higher value.
                        assert!(
                            c >= a - 1e-9 && c - a < 1e-3 * (1.0 + m.abs()),
                            "brute {c} vs {a}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn ball_contact_is_the_sphere_tangent() {
        let ball = Profile::ball(3.0).unwrap();
        // A 45° ramp passing straight over the point: the swept sphere's lowest point there is
        // its centre line minus the radius measured perpendicular to the axis: R·(√2 − 1)
        // below the tip line plus R.
        let z = ball.sweep_low(0.0, 10.0, 20.0, 1.0).unwrap();
        let expected = 10.0 + 3.0 - 3.0 * 2f64.sqrt();
        assert!((z - expected).abs() < 1e-12);
    }

    #[test]
    fn quartic_finds_known_roots() {
        // (x − 1)(x + 2)(x − 0.5)(x + 3) = x⁴ + 3.5x³ − x² − 6.5x + 3
        let (roots, count) = quartic_roots(1.0, 3.5, -1.0, -6.5, 3.0);
        let mut found: Vec<f64> = roots[..count].to_vec();
        found.sort_by(f64::total_cmp);
        assert_eq!(count, 4);
        for (x, y) in found.iter().zip([-3.0, -2.0, 0.5, 1.0]) {
            assert!((x - y).abs() < 1e-9, "{found:?}");
        }
        let (roots, count) = cubic_roots(2.0, -4.0, -22.0, 24.0); // 2(x − 1)(x + 3)(x − 4)
        assert_eq!(count, 3);
        assert!((roots[0] - 4.0).abs() < 1e-12 && (roots[2] + 3.0).abs() < 1e-12);
    }

    #[test]
    fn the_bull_contact_quartic_is_solved_in_closed_form() {
        let mut seed = 99u64;
        let mut random = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut worst: f64 = 0.0;
        for _ in 0..20_000 {
            let corner = 0.2 + random() * 5.0;
            let flat = random() * 6.0;
            let r = flat + corner;
            let e = random() * r;
            let m = (random() - 0.5) * 10f64.powf(random() * 4.0 - 2.0);
            if m == 0.0 {
                continue;
            }
            let t = bull_quartic_root(flat, corner, e * e, m).expect("the closed form finds the root");
            let d = flat + corner * t;
            let polished = bull_contact(flat, corner, e * e, m);
            worst = worst.max((d - polished).abs() / r);
        }
        assert!(
            worst < 1e-6,
            "closed form off by {worst} of the radius before polishing"
        );
    }

    #[test]
    fn rejects_bad_profiles() {
        assert!(Profile::flat(0.0).is_err());
        assert!(Profile::cone(3.0, 180.0, 0.0).is_err());
        assert!(Profile::bull(3.0, -1.0).is_err());
        let concave = vec![
            Piece::Line {
                d0: 0.0,
                d1: 1.0,
                h0: 0.0,
                slope: 1.0,
            },
            Piece::Line {
                d0: 1.0,
                d1: 2.0,
                h0: 1.0,
                slope: 0.5,
            },
        ];
        assert!(Profile::general(concave).is_err());
        assert_eq!(Profile::bull(3.0, 0.0).unwrap().kind(), ProfileKind::Flat);
        assert_eq!(Profile::bull(3.0, 3.0).unwrap().kind(), ProfileKind::Ball);
    }
}
