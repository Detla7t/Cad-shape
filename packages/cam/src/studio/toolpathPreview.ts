// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EdgeMeshData, type IDisposable, type IDocument, Matrix4, type MeshLike } from "@chili3d/core";
import { type WcsData, wcsPointToModel, wcsVectorToModel } from "../context/wcs";
import type { ToolData } from "../model/tool";
import type { ToolpathData, Vec3 } from "../model/toolpath";
import { arcPoints, drillPlanes } from "../posts/motion";

/**
 * Toolpaths drawn in the model: rapids dashed red, cuts blue, plunges and ramps (moves
 * going down) yellow — each move mapped out of its setup's WCS into model coordinates —
 * and a tool marker (a cylinder of the tool's diameter) that playback moves along the
 * path. Drawn as temporary meshes of the document's visual context, so nothing enters
 * the model or its undo history.
 */

export const RAPID_COLOR = 0xe53935;
export const CUT_COLOR = 0x1e88e5;
export const PLUNGE_COLOR = 0xfbc02d;
export const MARKER_COLOR = 0xff9800;

export type SegmentKind = "rapid" | "cut" | "plunge";

/** One straight piece of a toolpath, WCS coordinates. */
export interface PathSegment {
    readonly kind: SegmentKind;
    readonly from: Vec3;
    readonly to: Vec3;
    /** Tool axis at the end of the piece (WCS), when the move tilts the tool. */
    readonly axis?: Vec3;
}

const DOWN = -1e-6;

function kindOf(from: Vec3, to: Vec3, rapid: boolean): SegmentKind {
    if (rapid) return "rapid";
    return to[2] - from[2] < DOWN ? "plunge" : "cut";
}

/** A toolpath as straight segments (arcs within `tolerance`), in WCS. */
export function toolpathSegments(path: ToolpathData, tolerance = 0.02): PathSegment[] {
    const segments: PathSegment[] = [];
    let at: Vec3 | undefined;
    const push = (to: Vec3, rapid: boolean, axis?: Vec3) => {
        if (at !== undefined && (at[0] !== to[0] || at[1] !== to[1] || at[2] !== to[2])) {
            segments.push({ kind: kindOf(at, to, rapid), from: at, to, axis });
        }
        at = to;
    };
    for (const move of path.moves) {
        switch (move.kind) {
            case "rapid":
                push(move.to, true, move.axis);
                break;
            case "linear":
                push(move.to, false, move.axis);
                break;
            case "taper":
            case "extrude":
                push(move.to, false);
                break;
            case "arc":
                if (at === undefined) {
                    at = move.to;
                    break;
                }
                for (const point of arcPoints(at, move, tolerance)) push(point, false);
                break;
            case "drill": {
                const { bottom, r } = drillPlanes(move);
                const start = at ?? [move.at[0], move.at[1], r];
                push([move.at[0], move.at[1], start[2]], true);
                push([move.at[0], move.at[1], r], true);
                push([move.at[0], move.at[1], bottom], false);
                push([move.at[0], move.at[1], Math.max(start[2], r)], true);
                break;
            }
            default:
                break;
        }
    }
    return segments;
}

/** One toolpath to draw, with the frame and tool it belongs to. */
export interface PreviewPath {
    readonly id: string;
    readonly toolpath: ToolpathData;
    readonly wcs: WcsData;
    readonly tool?: ToolData;
}

/** Positions of `segments` of one kind, mapped to the model, as line-segment pairs. */
function linePositions(segments: readonly PathSegment[], wcs: WcsData): Float32Array {
    const positions = new Float32Array(segments.length * 6);
    segments.forEach((segment, i) => {
        positions.set(wcsPointToModel(wcs, segment.from), i * 6);
        positions.set(wcsPointToModel(wcs, segment.to), i * 6 + 3);
    });
    return positions;
}

/** A cylinder along +Z from the origin (the tool tip) up `height`. */
export function cylinderMesh(radius: number, height: number, sides = 24): MeshLike {
    const position: number[] = [];
    const normal: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        position.push(radius * c, radius * s, 0, radius * c, radius * s, height);
        normal.push(c, s, 0, c, s, 0);
        uv.push(i / sides, 0, i / sides, 1);
    }
    for (let i = 0; i < sides; i++) {
        const k = i * 2;
        index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
    for (const [z, nz] of [
        [0, -1],
        [height, 1],
    ] as const) {
        const centre = position.length / 3;
        position.push(0, 0, z);
        normal.push(0, 0, nz);
        uv.push(0.5, 0.5);
        for (let i = 0; i <= sides; i++) {
            const a = (i / sides) * Math.PI * 2;
            position.push(radius * Math.cos(a), radius * Math.sin(a), z);
            normal.push(0, 0, nz);
            uv.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
        }
        for (let i = 0; i < sides; i++) {
            if (nz > 0) index.push(centre, centre + 1 + i, centre + 2 + i);
            else index.push(centre, centre + 2 + i, centre + 1 + i);
        }
    }
    return {
        position: new Float32Array(position),
        normal: new Float32Array(normal),
        uv: new Float32Array(uv),
        index: new Uint32Array(index),
        color: MARKER_COLOR,
    };
}

/** The marker's placement: +Z along `axis` (model), origin at `tip` (model). */
export function markerMatrix(tip: Vec3, axis: Vec3): Matrix4 {
    const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const z: Vec3 = [axis[0] / n, axis[1] / n, axis[2] / n];
    const helper: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const d = helper[0] * z[0] + helper[1] * z[1] + helper[2] * z[2];
    const xr: Vec3 = [helper[0] - d * z[0], helper[1] - d * z[1], helper[2] - d * z[2]];
    const xn = Math.hypot(xr[0], xr[1], xr[2]);
    const x: Vec3 = [xr[0] / xn, xr[1] / xn, xr[2] / xn];
    const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return Matrix4.fromArray([
        x[0],
        x[1],
        x[2],
        0,
        y[0],
        y[1],
        y[2],
        0,
        z[0],
        z[1],
        z[2],
        0,
        tip[0],
        tip[1],
        tip[2],
        1,
    ]);
}

/** A point along a run of segments, `t` ∈ [0, 1] of its total length. */
export interface PlaybackPoint {
    readonly pathId: string;
    /** Model coordinates. */
    readonly position: Vec3;
    /** The same point in its setup's WCS (what the program says). */
    readonly wcs: Vec3;
    readonly axis: Vec3;
}

export class ToolpathPreview implements IDisposable {
    private meshIds: number[] = [];
    private marker: { id: number; key: string } | undefined;
    private paths: readonly PreviewPath[] = [];
    private flat: { path: PreviewPath; segment: PathSegment; start: number; length: number }[] = [];
    private total = 0;

    constructor(readonly document: IDocument) {}

    get visible(): boolean {
        return this.meshIds.length > 0;
    }

    get pathCount(): number {
        return this.paths.length;
    }

    /** Draws `paths`, replacing what was shown. */
    show(paths: readonly PreviewPath[]): void {
        this.clearPaths();
        this.paths = paths;
        this.flat = [];
        this.total = 0;
        const context = this.document.visual.context;
        for (const path of paths) {
            const segments = toolpathSegments(path.toolpath);
            for (const segment of segments) {
                const length = Math.hypot(
                    segment.to[0] - segment.from[0],
                    segment.to[1] - segment.from[1],
                    segment.to[2] - segment.from[2],
                );
                this.flat.push({ path, segment, start: this.total, length });
                this.total += length;
            }
            const meshes: EdgeMeshData[] = [];
            for (const [kind, color, lineType] of [
                ["rapid", RAPID_COLOR, "dash"],
                ["cut", CUT_COLOR, "solid"],
                ["plunge", PLUNGE_COLOR, "solid"],
            ] as const) {
                const ofKind = segments.filter((segment) => segment.kind === kind);
                if (ofKind.length === 0) continue;
                meshes.push({
                    position: linePositions(ofKind, path.wcs),
                    color,
                    lineType,
                    lineWidth: kind === "rapid" ? 1 : 2,
                    range: [],
                });
            }
            if (meshes.length > 0) this.meshIds.push(context.displayMesh(meshes));
        }
        this.document.visual.update();
    }

    /** The tool's position at `t` ∈ [0, 1] of the drawn paths' total length (model coordinates). */
    pointAt(t: number): PlaybackPoint | undefined {
        if (this.flat.length === 0) return undefined;
        const target = Math.min(1, Math.max(0, t)) * this.total;
        let low = 0;
        let high = this.flat.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (this.flat[mid].start <= target) low = mid;
            else high = mid - 1;
        }
        const piece = this.flat[low];
        const f = piece.length > 0 ? Math.min(1, (target - piece.start) / piece.length) : 1;
        const { from, to } = piece.segment;
        const wcsPoint: Vec3 = [
            from[0] + (to[0] - from[0]) * f,
            from[1] + (to[1] - from[1]) * f,
            from[2] + (to[2] - from[2]) * f,
        ];
        const axis = piece.segment.axis ?? [0, 0, 1];
        return {
            pathId: piece.path.id,
            wcs: wcsPoint,
            position: wcsPointToModel(piece.path.wcs, wcsPoint),
            axis: wcsVectorToModel(piece.path.wcs, axis),
        };
    }

    /** Moves (or shows) the tool marker at `t` ∈ [0, 1] of the paths. */
    setPlayback(t: number): PlaybackPoint | undefined {
        const point = this.pointAt(t);
        if (point === undefined) {
            this.hideMarker();
            return undefined;
        }
        const path = this.paths.find((x) => x.id === point.pathId);
        const tool = path?.tool;
        const radius = Math.max(0.1, (tool?.diameter ?? 6) / 2);
        const height = Math.max(radius * 2, tool?.fluteLength ?? tool?.stickout ?? radius * 6);
        const key = `${radius}:${height}`;
        const context = this.document.visual.context;
        const matrix = markerMatrix(point.position, point.axis);
        if (this.marker !== undefined && this.marker.key !== key) this.hideMarker();
        if (this.marker === undefined) {
            this.marker = {
                id: context.displayInstancedMesh(cylinderMesh(radius, height), [matrix], {
                    meshOpacity: 0.7,
                }),
                key,
            };
        } else {
            context.setInstanceMatrix(this.marker.id, [matrix]);
        }
        this.document.visual.update();
        return point;
    }

    hideMarker(): void {
        if (this.marker === undefined) return;
        this.document.visual.context.removeMesh(this.marker.id);
        this.marker = undefined;
        this.document.visual.update();
    }

    clear(): void {
        this.clearPaths();
        this.hideMarker();
        this.paths = [];
        this.flat = [];
        this.total = 0;
    }

    private clearPaths(): void {
        if (this.meshIds.length === 0) return;
        for (const id of this.meshIds) this.document.visual.context.removeMesh(id);
        this.meshIds = [];
        this.document.visual.update();
    }

    dispose(): void {
        this.clear();
    }
}
