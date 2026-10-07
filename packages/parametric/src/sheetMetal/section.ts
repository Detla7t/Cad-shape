// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IFace } from "@chili3d/core";
import { type Arena, kernel, SheetError, type Vec3, vec, xyz } from "./frame";
import type { FlangeElement, V2 } from "./model";

/**
 * Planar cross-sections built in a local (s, z) frame and embedded in 3D: the folded
 * strip of a flange profile (straights and bends of a sheet of thickness t), the arc strip
 * of a bead, and the annulus sectors of bends and rolls. Prisming or revolving one of these
 * gives the formed solid.
 */

export interface LocalFrame {
    readonly origin: Vec3;
    /** Unit in-section axes; `s × z` is the prism direction for a positive extent. */
    readonly s: Vec3;
    readonly z: Vec3;
}

export type Piece =
    | { readonly kind: "line"; readonly a: V2; readonly b: V2 }
    /** Arc around `center`, from angle `from` sweeping `sweep` radians (positive = counter-clockwise in (s, z)). */
    | {
          readonly kind: "arc";
          readonly center: V2;
          readonly radius: number;
          readonly from: number;
          readonly sweep: number;
      };

function at(frame: LocalFrame, p: V2): Vec3 {
    return vec.add(frame.origin, vec.add(vec.scale(frame.s, p[0]), vec.scale(frame.z, p[1])));
}

/** A face bounded by connected pieces (orientation of each piece does not matter). */
export function sectionFace(arena: Arena, frame: LocalFrame, pieces: readonly Piece[]): IFace {
    const normal = vec.cross(frame.s, frame.z);
    const edges = pieces
        .filter(
            (piece) =>
                piece.kind === "arc" || Math.hypot(piece.a[0] - piece.b[0], piece.a[1] - piece.b[1]) > 1e-9,
        )
        .map((piece) => {
            if (piece.kind === "line")
                return arena.track(
                    kernel(
                        shapeFactory.line(xyz(at(frame, piece.a)), xyz(at(frame, piece.b))),
                        "section line",
                    ),
                );
            const from = piece.sweep >= 0 ? piece.from : piece.from + piece.sweep;
            const start: V2 = [
                piece.center[0] + piece.radius * Math.cos(from),
                piece.center[1] + piece.radius * Math.sin(from),
            ];
            const degrees = (Math.abs(piece.sweep) * 180) / Math.PI;
            return arena.track(
                kernel(
                    shapeFactory.arc(
                        xyz(normal),
                        xyz(at(frame, piece.center)),
                        xyz(at(frame, start)),
                        degrees,
                    ),
                    "section arc",
                ),
            );
        });
    const wire = arena.track(kernel(shapeFactory.wire(edges), "section outline"));
    return arena.track(kernel(shapeFactory.face([wire]), "section face"));
}

const rotate = (p: V2, c: V2, angle: number): V2 => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
};

export interface StripSection {
    readonly pieces: Piece[];
    /** Bend zone centers along the developed (flat) strip, for marking bend lines. */
    readonly bendCenters: number[];
    /** Developed length of the strip. */
    readonly flatLength: number;
}

/**
 * The cross-section of a sheet of thickness `t` formed through `elements`, starting at
 * s = 0 with the sheet occupying z ∈ [0, t] and heading +s. A positive bend folds toward
 * +z (the inner surface is then the top), a negative one toward −z; `kFactor` places the
 * neutral layer for the developed length.
 */
export function stripSection(elements: readonly FlangeElement[], t: number, kFactor: number): StripSection {
    let bottom: V2 = [0, 0];
    let top: V2 = [0, t];
    let direction = 0;
    const bottomPieces: Piece[] = [];
    const topPieces: Piece[] = [];
    const bendCenters: number[] = [];
    let developed = 0;
    for (const element of elements) {
        if (element.kind === "straight") {
            if (element.length <= 0) continue;
            const d: V2 = [Math.cos(direction) * element.length, Math.sin(direction) * element.length];
            const nextBottom: V2 = [bottom[0] + d[0], bottom[1] + d[1]];
            const nextTop: V2 = [top[0] + d[0], top[1] + d[1]];
            bottomPieces.push({ kind: "line", a: bottom, b: nextBottom });
            topPieces.push({ kind: "line", a: top, b: nextTop });
            bottom = nextBottom;
            top = nextTop;
            developed += element.length;
            continue;
        }
        const theta = (element.angle * Math.PI) / 180;
        if (Math.abs(theta) < 1e-9) continue;
        if (element.radius <= 0) throw new SheetError("Bend radius must be positive");
        const left: V2 = [-Math.sin(direction), Math.cos(direction)];
        // Up: the axis sits above the top surface; down: below the bottom surface.
        const center: V2 =
            theta > 0
                ? [top[0] + left[0] * element.radius, top[1] + left[1] * element.radius]
                : [bottom[0] - left[0] * element.radius, bottom[1] - left[1] * element.radius];
        const angleOf = (p: V2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
        const bendLength = Math.abs(theta) * (element.radius + kFactor * t);
        bendCenters.push(developed + bendLength / 2);
        developed += bendLength;
        bottomPieces.push({
            kind: "arc",
            center,
            radius: Math.hypot(bottom[0] - center[0], bottom[1] - center[1]),
            from: angleOf(bottom),
            sweep: theta,
        });
        topPieces.push({
            kind: "arc",
            center,
            radius: Math.hypot(top[0] - center[0], top[1] - center[1]),
            from: angleOf(top),
            sweep: theta,
        });
        bottom = rotate(bottom, center, theta);
        top = rotate(top, center, theta);
        direction += theta;
    }
    if (bottomPieces.length === 0) throw new SheetError("The edge profile is empty");
    const pieces: Piece[] = [
        ...bottomPieces,
        { kind: "line", a: bottom, b: top },
        ...topPieces,
        { kind: "line", a: [0, t], b: [0, 0] },
    ];
    return { pieces, bendCenters, flatLength: developed };
}

/** An annulus sector (radii `inner`..`outer`) around `center`, from angle `from` sweeping `sweep`. */
export function annulusSector(
    center: V2,
    inner: number,
    outer: number,
    from: number,
    sweep: number,
): Piece[] {
    const point = (radius: number, angle: number): V2 => [
        center[0] + radius * Math.cos(angle),
        center[1] + radius * Math.sin(angle),
    ];
    return [
        { kind: "arc", center, radius: inner, from, sweep },
        { kind: "line", a: point(inner, from + sweep), b: point(outer, from + sweep) },
        { kind: "arc", center, radius: outer, from, sweep },
        { kind: "line", a: point(outer, from), b: point(inner, from) },
    ];
}

export interface BeadSection {
    readonly pieces: Piece[];
    /** Width of the sheet footprint the bead replaces (its widest surface). */
    readonly footprint: number;
}

/**
 * A bead's cross-section, centered on s = 0 in a sheet z ∈ [0, t]: a circular arc strip of
 * chord `width` and rise `height` on the surface it bulges from, plus the slivers of flat
 * sheet out to the footprint of the concentric opposite surface. `direction` +1 bulges
 * toward +z, −1 toward −z.
 */
export function beadSection(width: number, height: number, t: number, direction: 1 | -1): BeadSection {
    if (width <= 0 || height <= 0) throw new SheetError("Bead width and height must be positive");
    if (height > width / 2) throw new SheetError("A bead cannot be taller than half its width");
    const rho = (width * width) / 4 / (2 * height) + height / 2;
    const outer = rho + t;
    const footprint = 2 * Math.sqrt(outer * outer - (outer - height) ** 2);
    // Built bulging up from the bottom surface; mirrored for a groove.
    const center: V2 = [0, height - rho];
    const half = width / 2;
    const foot = footprint / 2;
    const angle = (p: V2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
    const raw: Piece[] = [
        {
            kind: "arc",
            center,
            radius: rho,
            from: angle([half, 0]),
            sweep: angle([-half, 0]) - angle([half, 0]),
        },
        { kind: "line", a: [-half, 0], b: [-foot, 0] },
        { kind: "line", a: [-foot, 0], b: [-foot, t] },
        {
            kind: "arc",
            center,
            radius: outer,
            from: angle([foot, t]),
            sweep: angle([-foot, t]) - angle([foot, t]),
        },
        { kind: "line", a: [foot, t], b: [foot, 0] },
        { kind: "line", a: [foot, 0], b: [half, 0] },
    ];
    if (direction === 1) return { pieces: raw, footprint };
    // Mirror about the sheet's mid plane z = t/2.
    const mirror = (p: V2): V2 => [p[0], t - p[1]];
    return {
        footprint,
        pieces: raw.map((piece) =>
            piece.kind === "line"
                ? { kind: "line", a: mirror(piece.a), b: mirror(piece.b) }
                : {
                      kind: "arc",
                      center: mirror(piece.center),
                      radius: piece.radius,
                      from: -piece.from,
                      sweep: -piece.sweep,
                  },
        ),
    };
}

/** The `s ≥ 0` half of `beadSection`, closed along the s = 0 line — revolved into a bead's end dome. */
export function halfBeadSection(width: number, height: number, t: number, direction: 1 | -1): Piece[] {
    const { footprint } = beadSection(width, height, t, direction);
    const rho = (width * width) / 4 / (2 * height) + height / 2;
    const outer = rho + t;
    const center: V2 = [0, height - rho];
    const half = width / 2;
    const foot = footprint / 2;
    const angle = (p: V2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
    const raw: Piece[] = [
        { kind: "arc", center, radius: rho, from: angle([half, 0]), sweep: Math.PI / 2 - angle([half, 0]) },
        { kind: "line", a: [0, height], b: [0, height + t] },
        { kind: "arc", center, radius: outer, from: angle([foot, t]), sweep: Math.PI / 2 - angle([foot, t]) },
        { kind: "line", a: [foot, t], b: [foot, 0] },
        { kind: "line", a: [foot, 0], b: [half, 0] },
    ];
    if (direction === 1) return raw;
    const mirror = (p: V2): V2 => [p[0], t - p[1]];
    return raw.map((piece) =>
        piece.kind === "line"
            ? { kind: "line", a: mirror(piece.a), b: mirror(piece.b) }
            : {
                  kind: "arc",
                  center: mirror(piece.center),
                  radius: piece.radius,
                  from: -piece.from,
                  sweep: -piece.sweep,
              },
    );
}
