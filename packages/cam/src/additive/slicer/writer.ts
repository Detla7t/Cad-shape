// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ToolpathMove } from "../../model/toolpath";
import { type IntPoint, mm, type Path, SCALE } from "../geometry/polygons";
import { extrusionArea } from "../prusa/settings";
import { formatNumber } from "../prusa/values";

/**
 * Builds a printer toolpath: travels (with retraction and z-hop when they are long enough),
 * extrusions (filament per mm from the extrusion's cross-section), layer changes, feature
 * comments. Positions are absolute mm; extrusion amounts relative (what the posts write
 * after M83).
 */

export interface WriterSettings {
    readonly filamentDiameter: number;
    readonly extrusionMultiplier: number;
    readonly retractLength: number;
    /** mm/s */
    readonly retractSpeed: number;
    readonly deretractSpeed: number;
    readonly retractLift: number;
    readonly retractBeforeTravel: number;
    readonly retractRestartExtra: number;
    readonly travelSpeed: number;
    readonly travelSpeedZ: number;
}

/** PrusaSlicer's feature names (`;TYPE:` comments, which G-code viewers color by). */
export type ExtrusionRole =
    | "Skirt/Brim"
    | "External perimeter"
    | "Perimeter"
    | "Internal infill"
    | "Solid infill"
    | "Top solid infill"
    | "Bridge infill"
    | "Support material"
    | "Support material interface";

export class ToolpathWriter {
    moves: ToolpathMove[] = [];
    x = 0;
    y = 0;
    z = 0;
    /** False until the first move after raw code (whose position is unknown). */
    positioned = false;
    retracted = false;
    private lifted = 0;
    private role: ExtrusionRole | undefined;
    private readonly filamentArea: number;
    /** Net filament fed, mm. */
    filament = 0;

    constructor(readonly settings: WriterSettings) {
        this.filamentArea = (Math.PI * settings.filamentDiameter ** 2) / 4;
    }

    comment(text: string) {
        this.moves.push({ kind: "comment", text });
    }

    raw(code: string) {
        const text = code.replace(/\s+$/, "");
        if (text.trim() === "") return;
        this.moves.push({ kind: "raw", code: text });
        if (mayMove(text)) this.positioned = false;
    }

    /** The filament a length of extrusion takes (mm of filament). */
    filamentFor(length: number, width: number, height: number, flow = 1): number {
        return (
            ((extrusionArea(width, height) * length) / this.filamentArea) *
            this.settings.extrusionMultiplier *
            flow
        );
    }

    private pushExtrude(x: number, y: number, z: number, extrude: number, feed: number) {
        this.moves.push({ kind: "extrude", to: [x, y, z], extrude, feed });
        this.filament += extrude;
    }

    /** Retracts the filament and, unless `lift` is false, lifts the nozzle (z-hop). */
    retract(lift = true) {
        if (!this.retracted && this.settings.retractLength > 0) {
            if (this.positioned) {
                this.pushExtrude(
                    this.x,
                    this.y,
                    this.z,
                    -this.settings.retractLength,
                    this.settings.retractSpeed * 60,
                );
            } else {
                // Where raw code left the nozzle is unknown: retract without moving.
                this.raw(
                    `G1 E${formatNumber(-this.settings.retractLength, 5)} F${Math.round(this.settings.retractSpeed * 60)}`,
                );
                this.filament -= this.settings.retractLength;
            }
            this.retracted = true;
        }
        if (lift && this.lifted === 0 && this.settings.retractLift > 0 && this.positioned) {
            this.lifted = this.settings.retractLift;
            this.moves.push({
                kind: "rapid",
                to: [this.x, this.y, this.z + this.lifted],
                feed: this.settings.travelSpeedZ * 60,
            });
        }
    }

    private unretract() {
        if (this.lifted > 0) {
            this.moves.push({
                kind: "rapid",
                to: [this.x, this.y, this.z],
                feed: this.settings.travelSpeedZ * 60,
            });
            this.lifted = 0;
        }
        if (this.retracted) {
            this.pushExtrude(
                this.x,
                this.y,
                this.z,
                this.settings.retractLength + this.settings.retractRestartExtra,
                this.settings.deretractSpeed * 60,
            );
            this.retracted = false;
        }
    }

    setRole(role: ExtrusionRole) {
        if (role === this.role) return;
        this.role = role;
        this.comment(`TYPE:${role}`);
    }

    /** Moves the nozzle to a new layer height (keeping a z-hop in effect). */
    layerZ(z: number, retract: boolean) {
        if (retract) {
            // The z-hop happens together with the layer change: one move up.
            this.retract(false);
            if (this.retracted && this.settings.retractLift > 0) this.lifted = this.settings.retractLift;
        }
        this.z = z;
        const feed = this.settings.travelSpeedZ * 60;
        if (this.positioned) this.moves.push({ kind: "rapid", to: [this.x, this.y, z + this.lifted], feed });
        // After raw code only Z is known to be safe to move alone.
        else this.raw(`G1 Z${formatNumber(z + this.lifted, 3)} F${Math.round(feed)}`);
    }

    /**
     * Travels to (x, y) mm. Retracts when the travel is longer than `retract_before_travel`,
     * unless `noRetract` says the move stays over printed area.
     */
    travel(x: number, y: number, noRetract = false) {
        const distance = Math.hypot(x - this.x, y - this.y);
        if (this.positioned && distance < 1e-6) return;
        if (!this.positioned || (distance > this.settings.retractBeforeTravel && !noRetract)) this.retract();
        this.moves.push({
            kind: "rapid",
            to: [x, y, this.z + this.lifted],
            feed: this.settings.travelSpeed * 60,
        });
        this.positioned = true;
        this.x = x;
        this.y = y;
    }

    /** Extrudes a straight line to (x, y) mm at `speed` mm/s. */
    extrudeTo(x: number, y: number, width: number, height: number, speed: number, flow = 1) {
        const length = Math.hypot(x - this.x, y - this.y);
        if (length < 1e-6) return;
        this.unretract();
        this.pushExtrude(x, y, this.z, this.filamentFor(length, width, height, flow), speed * 60);
        this.x = x;
        this.y = y;
    }

    /**
     * Extrudes a path given in integer units. A closed path returns to its first point, ending
     * `seamGap` mm short of it.
     */
    extrudePath(
        points: Path,
        closed: boolean,
        width: number,
        height: number,
        speed: number,
        options: { seamGap?: number; noRetract?: boolean; flow?: number } = {},
    ) {
        if (points.length < 2) return;
        this.travel(mm(points[0].x), mm(points[0].y), options.noRetract);
        const route: IntPoint[] = closed ? [...points.slice(1), points[0]] : points.slice(1);
        if (closed && options.seamGap && options.seamGap > 0)
            trimEnd(route, points[0], options.seamGap * SCALE);
        for (const p of route) this.extrudeTo(mm(p.x), mm(p.y), width, height, speed, options.flow);
    }
}

/** Commands that cannot move the head (temperatures, fan, progress, modes, limits, checks). */
const STATIONARY =
    /^(M10[4-9]|M1[49]0|M11[57]|M7[35]|M8[23]|M20[1-5]|M862(\.\d)?|M17|M18|M84|G2[01]|G90|G4)\b/i;

/** Whether raw code may leave the nozzle somewhere else (then the next move writes every axis). */
export function mayMove(code: string): boolean {
    return code
        .split("\n")
        .map((line) => line.replace(/;.*$/, "").trim())
        .some((line) => line !== "" && !STATIONARY.test(line));
}

/** Shortens a route (starting after `start`) by `gap` units at its end. */
function trimEnd(route: IntPoint[], start: IntPoint, gap: number) {
    let remaining = gap;
    while (route.length > 0 && remaining > 0) {
        const end = route[route.length - 1];
        const before = route.length > 1 ? route[route.length - 2] : start;
        const length = Math.hypot(end.x - before.x, end.y - before.y);
        if (length > remaining) {
            const t = (length - remaining) / length;
            route[route.length - 1] = {
                x: Math.round(before.x + (end.x - before.x) * t),
                y: Math.round(before.y + (end.y - before.y) * t),
            };
            return;
        }
        route.pop();
        remaining -= length;
    }
}
