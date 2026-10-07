// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { ToolData } from "../model/tool";

/**
 * An axially symmetric cutter as its profile: the height of the cutting surface above the tip
 * at a radial distance `d` from the axis. Every 3-axis mill used here has the same profile
 * family — a flat bottom of radius `flatRadius`, a corner arc of radius `cornerRadius`, then a
 * cone of slope `coneSlope` (cot of the half angle) out to `radius`:
 *
 *   flat end mill   flat = R, arc = 0, no cone
 *   ball end mill   flat = 0, arc = R, no cone (the arc runs to vertical)
 *   bull nose       flat = R − r, arc = r, no cone
 *   V-bit / cone    flat = 0, arc = 0, cone slope cot(α/2)
 *
 * The profile is convex and non-decreasing, which is what makes the drop-cutter's edge
 * contact a one-dimensional concave maximization. Above the profile the cutter (and its
 * shank) is a cylinder of `radius`.
 *
 * `offset(s)` is the cutter grown by a ball of radius s (Minkowski sum): dropping it on the
 * mesh and raising the result by s gives the tip positions that leave s of stock everywhere.
 */
export class Cutter {
    /** Footprint radius. */
    readonly radius: number;
    readonly flatRadius: number;
    readonly cornerRadius: number;
    /** cot of the cone half angle; Infinity when the arc runs to vertical. */
    readonly coneSlope: number;
    /** Radius where the corner arc meets the cone (or the side). */
    readonly arcEnd: number;
    readonly arcEndHeight: number;
    /** Height of the profile at the footprint radius. */
    readonly rimHeight: number;
    readonly kind: "flat" | "ball" | "general";

    constructor(shape: { radius?: number; flatRadius: number; cornerRadius: number; coneSlope?: number }) {
        const coneSlope = shape.coneSlope ?? Infinity;
        this.flatRadius = Math.max(0, shape.flatRadius);
        this.cornerRadius = Math.max(0, shape.cornerRadius);
        this.coneSlope = coneSlope;
        if (Number.isFinite(coneSlope)) {
            const hyp = Math.sqrt(1 + coneSlope * coneSlope);
            const cos = coneSlope / hyp;
            const sin = 1 / hyp;
            this.arcEnd = this.flatRadius + this.cornerRadius * cos;
            this.arcEndHeight = this.cornerRadius * (1 - sin);
            this.radius = Math.max(shape.radius ?? this.arcEnd, this.arcEnd);
        } else {
            this.arcEnd = this.flatRadius + this.cornerRadius;
            this.arcEndHeight = this.cornerRadius;
            this.radius = this.arcEnd;
        }
        this.rimHeight = this.height(this.radius);
        if (this.cornerRadius === 0 && !Number.isFinite(coneSlope)) this.kind = "flat";
        else if (this.flatRadius === 0 && !Number.isFinite(coneSlope)) this.kind = "ball";
        else this.kind = "general";
    }

    static flat(radius: number): Cutter {
        return new Cutter({ flatRadius: radius, cornerRadius: 0 });
    }

    static ball(radius: number): Cutter {
        return new Cutter({ flatRadius: 0, cornerRadius: radius });
    }

    static bull(radius: number, cornerRadius: number): Cutter {
        const r = Math.min(Math.max(cornerRadius, 0), radius);
        return new Cutter({ flatRadius: radius - r, cornerRadius: r });
    }

    /** A pointed cone of `radius` with the given included angle (degrees). */
    static cone(radius: number, includedAngle: number): Cutter {
        const half = (Math.min(Math.max(includedAngle, 1), 179) * Math.PI) / 360;
        return new Cutter({ radius, flatRadius: 0, cornerRadius: 0, coneSlope: 1 / Math.tan(half) });
    }

    /** The cutter grown by a ball of radius `s` (see the class note). */
    offset(s: number): Cutter {
        if (s <= 0) return this;
        return new Cutter({
            radius: this.radius + s,
            flatRadius: this.flatRadius,
            cornerRadius: this.cornerRadius + s,
            coneSlope: this.coneSlope,
        });
    }

    /**
     * A cutter containing this one eroded by `s` (every point at least s inside), raised by
     * `lift`: when it clears the part, this cutter gouges by at most s. Collision checks use it
     * so chord-sized overlaps along walls (where heights jump) are not taken for collisions.
     */
    erode(s: number): { cutter: Cutter; lift: number } {
        if (s <= 0) return { cutter: this, lift: 0 };
        const radius = Math.max(this.radius - s, 1e-6);
        if (this.cornerRadius >= s) {
            return {
                cutter: new Cutter({
                    radius,
                    flatRadius: this.flatRadius,
                    cornerRadius: this.cornerRadius - s,
                    coneSlope: this.coneSlope,
                }),
                lift: s,
            };
        }
        if (!Number.isFinite(this.coneSlope)) {
            return { cutter: Cutter.flat(Math.max(this.flatRadius + this.cornerRadius - s, 1e-6)), lift: s };
        }
        // A cone's inner parallel surface: the same cone, moved up along the axis by s / sin α.
        const sin = 1 / Math.sqrt(1 + this.coneSlope * this.coneSlope);
        return {
            cutter: new Cutter({
                radius,
                flatRadius: this.flatRadius,
                cornerRadius: 0,
                coneSlope: this.coneSlope,
            }),
            lift: s / sin,
        };
    }

    /** Profile height above the tip at radial distance d (0 ≤ d ≤ radius). */
    height(d: number): number {
        if (d <= this.flatRadius) return 0;
        if (d <= this.arcEnd) {
            const u = d - this.flatRadius;
            const rho = this.cornerRadius;
            return rho - Math.sqrt(Math.max(0, rho * rho - u * u));
        }
        return this.arcEndHeight + (d - this.arcEnd) * this.coneSlope;
    }

    /** The radial distance where the profile reaches height h (the inverse of `height`). */
    radiusAtHeight(h: number): number {
        if (h <= 0) return this.flatRadius;
        if (h <= this.arcEndHeight) {
            const rho = this.cornerRadius;
            return this.flatRadius + Math.sqrt(Math.max(0, rho * rho - (rho - h) * (rho - h)));
        }
        if (!Number.isFinite(this.coneSlope)) return this.radius;
        return Math.min(this.radius, this.arcEnd + (h - this.arcEndHeight) / this.coneSlope);
    }

    /** dh/dd at radial distance d. */
    slope(d: number): number {
        if (d <= this.flatRadius) return 0;
        if (d < this.arcEnd) {
            const u = d - this.flatRadius;
            const rho = this.cornerRadius;
            const w = rho * rho - u * u;
            return w > 0 ? u / Math.sqrt(w) : Infinity;
        }
        return Number.isFinite(this.coneSlope) ? this.coneSlope : Infinity;
    }

    /** Radial distance of the contact with a plane of slope k (tan of its tilt): argmax of d·k − h(d). */
    contactRadius(k: number): number {
        if (k <= 0) return 0;
        if (k >= this.coneSlope) return this.radius;
        if (this.cornerRadius > 0) {
            return Math.min(this.arcEnd, this.flatRadius + (this.cornerRadius * k) / Math.sqrt(1 + k * k));
        }
        return this.flatRadius;
    }

    /**
     * argmax over t ∈ [lo, hi] of z0 + m·t − h(√(d0² + (t − t0)²)): the contact of an edge with
     * XY parameter t (z slope m) passing at distance d0 from the axis, closest at t0. Concave in t.
     */
    edgeContact(t0: number, d0: number, m: number, lo: number, hi: number): number {
        if (this.kind === "flat") return m > 0 ? hi : lo;
        if (this.kind === "ball") {
            const s = Math.sqrt(Math.max(0, this.radius * this.radius - d0 * d0));
            const t = t0 + (m * s) / Math.sqrt(1 + m * m);
            return t < lo ? lo : t > hi ? hi : t;
        }
        if (this.derivative(lo, t0, d0, m) <= 0) return lo;
        if (this.derivative(hi, t0, d0, m) >= 0) return hi;
        let a = lo;
        let b = hi;
        const eps = 1e-10 * Math.max(1, hi - lo);
        for (let i = 0; i < 64 && b - a > eps; i++) {
            const mid = 0.5 * (a + b);
            const g = this.derivative(mid, t0, d0, m);
            if (g > 0) a = mid;
            else if (g < 0) b = mid;
            else return mid;
        }
        return 0.5 * (a + b);
    }

    private derivative(t: number, t0: number, d0: number, m: number): number {
        const dt = t - t0;
        const d = Math.sqrt(d0 * d0 + dt * dt);
        if (d < 1e-15) return this.flatRadius === 0 && this.cornerRadius === 0 ? 0 : m;
        const s = this.slope(d);
        if (s === Infinity) return dt > 0 ? -Infinity : dt < 0 ? Infinity : m;
        return m - (s * dt) / d;
    }
}

/** The cutter shape of a mill tool, or an error for tools that are not milling cutters. */
export function cutterForTool(tool: ToolData): Result<Cutter> {
    const radius = tool.diameter / 2;
    if (!(radius > 0)) return Result.err(`Tool "${tool.name}" has no diameter`);
    switch (tool.kind) {
        case "ballEndmill":
            return Result.ok(Cutter.ball(radius));
        case "bullNose": {
            const r = tool.cornerRadius ?? 0;
            if (r <= 0) return Result.ok(Cutter.flat(radius));
            if (r >= radius) return Result.ok(Cutter.ball(radius));
            return Result.ok(Cutter.bull(radius, r));
        }
        case "vBit":
        case "chamfer":
        case "engraver":
        case "spotDrill":
            return Result.ok(Cutter.cone(radius, tool.tipAngle ?? 90));
        case "drill":
            return Result.ok(Cutter.cone(radius, tool.tipAngle ?? 118));
        case "flatEndmill":
        case "slotCutter":
        case "threadMill":
            return Result.ok(Cutter.flat(radius));
        default:
            return Result.err(`Tool "${tool.name}" (${tool.kind}) is not a milling cutter`);
    }
}

/**
 * The tool holder as a flat disc `offset` above the tip (tool stick-out), when the tool
 * declares one wider than the cutter.
 */
export function holderForTool(tool: ToolData): { radius: number; offset: number } | undefined {
    const holder = tool.holder;
    const offset = tool.stickout ?? tool.overallLength;
    if (!holder || offset === undefined || !(holder.diameter / 2 > tool.diameter / 2) || !(offset > 0)) {
        return undefined;
    }
    return { radius: holder.diameter / 2, offset };
}
