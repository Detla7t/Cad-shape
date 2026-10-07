// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

use crate::{PolygonError, Result};

/// A list of paths, flat: `coords` holds x0, y0, x1, y1, … of every path in turn and `lengths`
/// the point count of each. A closed loop does not repeat its first point.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Paths {
    coords: Vec<f64>,
    lengths: Vec<u32>,
}

impl Paths {
    pub fn new() -> Self {
        Self::default()
    }

    /// Paths from flat parts, checked: twice as many coordinates as points, all finite.
    pub fn from_flat(coords: Vec<f64>, lengths: Vec<u32>) -> Result<Self> {
        let points: usize = lengths.iter().map(|&n| n as usize).sum();
        if coords.len() != 2 * points {
            return Err(PolygonError::LengthMismatch {
                coordinates: coords.len(),
                points,
            });
        }
        if coords.iter().any(|c| !c.is_finite()) {
            return Err(PolygonError::NonFinite);
        }
        Ok(Self { coords, lengths })
    }

    /// Paths from point lists.
    pub fn from_points<P: AsRef<[[f64; 2]]>>(paths: &[P]) -> Self {
        let mut out = Self::new();
        for path in paths {
            out.push(path.as_ref().iter().copied());
        }
        out
    }

    /// Appends one path.
    pub fn push(&mut self, points: impl IntoIterator<Item = [f64; 2]>) {
        let start = self.coords.len();
        for [x, y] in points {
            self.coords.push(x);
            self.coords.push(y);
        }
        self.lengths.push(((self.coords.len() - start) / 2) as u32);
    }

    /// The number of paths.
    pub fn len(&self) -> usize {
        self.lengths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lengths.is_empty()
    }

    /// Every path as its flat coordinate slice (x0, y0, x1, y1, …).
    pub fn iter(&self) -> impl Iterator<Item = &[f64]> + Clone + '_ {
        let mut start = 0;
        self.lengths.iter().map(move |&n| {
            let end = start + 2 * n as usize;
            let slice = &self.coords[start..end];
            start = end;
            slice
        })
    }

    /// Every path as a point list.
    pub fn to_points(&self) -> Vec<Vec<[f64; 2]>> {
        self.iter().map(points_of).collect()
    }

    pub fn coords(&self) -> &[f64] {
        &self.coords
    }

    pub fn lengths(&self) -> &[u32] {
        &self.lengths
    }

    pub fn into_parts(self) -> (Vec<f64>, Vec<u32>) {
        (self.coords, self.lengths)
    }
}

/// The points of a flat coordinate slice.
pub(crate) fn points_of(coords: &[f64]) -> Vec<[f64; 2]> {
    coords.chunks_exact(2).map(|c| [c[0], c[1]]).collect()
}

/// Shoelace area of a closed loop (flat coordinates): positive when counter-clockwise.
pub fn signed_area(coords: &[f64]) -> f64 {
    let n = coords.len() / 2;
    if n < 3 {
        return 0.0;
    }
    let (x0, y0) = (coords[0], coords[1]);
    let mut twice = 0.0;
    for i in 1..n - 1 {
        let (ax, ay) = (coords[2 * i] - x0, coords[2 * i + 1] - y0);
        let (bx, by) = (coords[2 * i + 2] - x0, coords[2 * i + 3] - y0);
        twice += ax * by - bx * ay;
    }
    twice / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_parts_are_checked() {
        assert_eq!(
            Paths::from_flat(vec![0.0; 5], vec![3]),
            Err(PolygonError::LengthMismatch {
                coordinates: 5,
                points: 3
            })
        );
        assert_eq!(
            Paths::from_flat(vec![0.0, f64::NAN], vec![1]),
            Err(PolygonError::NonFinite)
        );
        let paths = Paths::from_flat(vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0], vec![1, 2]).unwrap();
        assert_eq!(
            paths.to_points(),
            vec![vec![[0.0, 1.0]], vec![[2.0, 3.0], [4.0, 5.0]]]
        );
    }

    #[test]
    fn signed_area_follows_orientation() {
        let square = [0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 2.0];
        assert_eq!(signed_area(&square), 4.0);
        let reversed = [0.0, 2.0, 2.0, 2.0, 2.0, 0.0, 0.0, 0.0];
        assert_eq!(signed_area(&reversed), -4.0);
        assert_eq!(signed_area(&[0.0, 0.0, 1.0, 1.0]), 0.0);
    }
}
