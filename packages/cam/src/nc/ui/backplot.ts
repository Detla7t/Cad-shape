// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EdgeMeshData, type IDisposable, type IDocument, type IView, XYZ } from "@chili3d/core";
import { type WcsData, wcsPointToModel, wcsVectorToModel } from "../../context/wcs";
import type { Vec3 } from "../../model/toolpath";
import { arcPoints, drillPlanes } from "../../posts/motion";
import {
    CUT_COLOR,
    cylinderMesh,
    MARKER_COLOR,
    markerMatrix,
    PLUNGE_COLOR,
    RAPID_COLOR,
} from "../../studio/toolpathPreview";
import type { NcProgram } from "../program";

/**
 * The backplot of an NC program in the Part Studio's viewport — the CAM Studio preview's
 * colours (rapids dashed red, cuts blue, plunges yellow; extrusion green) — with what the
 * program view needs on top: every drawn piece knows the move (and so the line) it comes
 * from, the moves of a line are highlighted, playback runs a tool marker along the path by
 * length, and a click in the viewport finds the nearest move. Temporary meshes of the
 * document's visual context: nothing enters the model or its undo history.
 */

export const EXTRUDE_COLOR = 0x43a047;
export const HIGHLIGHT_COLOR = 0xff6d00;

export type BackplotKind = "rapid" | "cut" | "plunge" | "extrude";

/** A move of the program: its toolpath and index there. */
export interface MoveRef {
    readonly path: number;
    readonly index: number;
}

/** One straight piece of the drawn program, WCS. */
export interface BackplotSegment extends MoveRef {
    readonly kind: BackplotKind;
    readonly from: Vec3;
    readonly to: Vec3;
    readonly axis?: Vec3;
    /** Path length before the piece, mm. */
    readonly start: number;
    readonly length: number;
}

const DOWN = -1e-6;
const IDENTITY_WCS: WcsData = { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] };

/** The program as drawn pieces, in order, arcs within `tolerance` (drill cycles as their motion). */
export function backplotSegments(program: NcProgram, tolerance = 0.01): BackplotSegment[] {
    const segments: BackplotSegment[] = [];
    let total = 0;
    program.toolpaths.forEach((path, pathIndex) => {
        let at: Vec3 | undefined = path.start;
        let axis: Vec3 | undefined;
        const push = (index: number, to: Vec3, kind: BackplotKind) => {
            if (at !== undefined && (at[0] !== to[0] || at[1] !== to[1] || at[2] !== to[2])) {
                const length = Math.hypot(to[0] - at[0], to[1] - at[1], to[2] - at[2]);
                const resolved: BackplotKind = kind === "cut" && to[2] - at[2] < DOWN ? "plunge" : kind;
                segments.push({
                    path: pathIndex,
                    index,
                    kind: resolved,
                    from: at,
                    to,
                    axis,
                    start: total,
                    length,
                });
                total += length;
            }
            at = to;
        };
        path.toolpath.moves.forEach((move, index) => {
            switch (move.kind) {
                case "rapid":
                    axis = move.axis;
                    push(index, move.to, "rapid");
                    break;
                case "linear":
                    axis = move.axis;
                    push(index, move.to, "cut");
                    break;
                case "taper":
                    push(index, move.to, "cut");
                    break;
                case "extrude":
                    push(index, move.to, move.extrude > 0 ? "extrude" : "rapid");
                    break;
                case "arc":
                    axis = undefined;
                    if (at === undefined) {
                        at = move.to;
                        break;
                    }
                    for (const point of arcPoints(at, move, tolerance)) push(index, point, "cut");
                    break;
                case "drill": {
                    const { bottom, r } = drillPlanes(move);
                    const height = at?.[2] ?? r;
                    if (at === undefined) at = [move.at[0], move.at[1], height];
                    push(index, [move.at[0], move.at[1], height], "rapid");
                    push(index, [move.at[0], move.at[1], r], "rapid");
                    push(index, [move.at[0], move.at[1], bottom], "plunge");
                    push(index, [move.at[0], move.at[1], Math.max(height, r)], "rapid");
                    break;
                }
                default:
                    break;
            }
        });
    });
    return segments;
}

/** A point along the drawn program. */
export interface BackplotPoint extends MoveRef {
    /** WCS (what the program says). */
    readonly wcs: Vec3;
    readonly axis: Vec3;
}

export class NcBackplot implements IDisposable {
    private meshIds: number[] = [];
    private highlightId: number | undefined;
    private marker: { id: number; key: string } | undefined;
    private program: NcProgram | undefined;
    private segmentList: BackplotSegment[] = [];
    private total = 0;
    private rapids = true;
    wcs: WcsData = IDENTITY_WCS;

    constructor(readonly document: IDocument) {}

    get segments(): readonly BackplotSegment[] {
        return this.segmentList;
    }

    get length(): number {
        return this.total;
    }

    get visible(): boolean {
        return this.meshIds.length > 0;
    }

    /** Draws `program`, replacing what was shown. */
    show(program: NcProgram, showRapids = this.rapids): void {
        this.clearPaths();
        this.program = program;
        this.rapids = showRapids;
        this.segmentList = backplotSegments(program);
        const last = this.segmentList.at(-1);
        this.total = last === undefined ? 0 : last.start + last.length;
        this.draw();
    }

    /** Shows or hides the rapids (printer travels clutter a print). */
    setShowRapids(show: boolean): void {
        if (show === this.rapids) return;
        this.rapids = show;
        this.clearPaths();
        this.draw();
    }

    private draw(): void {
        const context = this.document.visual.context;
        const meshes: EdgeMeshData[] = [];
        for (const [kind, color, lineType, lineWidth] of [
            ["rapid", RAPID_COLOR, "dash", 1],
            ["cut", CUT_COLOR, "solid", 2],
            ["plunge", PLUNGE_COLOR, "solid", 2],
            ["extrude", EXTRUDE_COLOR, "solid", 1],
        ] as const) {
            if (kind === "rapid" && !this.rapids) continue;
            const ofKind = this.segmentList.filter((segment) => segment.kind === kind);
            if (ofKind.length === 0) continue;
            meshes.push({ position: this.positions(ofKind), color, lineType, lineWidth, range: [] });
        }
        if (meshes.length > 0) this.meshIds.push(context.displayMesh(meshes));
        this.document.visual.update();
    }

    private positions(segments: readonly BackplotSegment[]): Float32Array {
        const positions = new Float32Array(segments.length * 6);
        const identity = this.wcs === IDENTITY_WCS;
        segments.forEach((segment, i) => {
            positions.set(identity ? segment.from : wcsPointToModel(this.wcs, segment.from), i * 6);
            positions.set(identity ? segment.to : wcsPointToModel(this.wcs, segment.to), i * 6 + 3);
        });
        return positions;
    }

    /** Highlights the pieces of these moves (a line's moves); none clears it. */
    highlight(moves: readonly MoveRef[]): void {
        const context = this.document.visual.context;
        if (this.highlightId !== undefined) {
            context.removeMesh(this.highlightId);
            this.highlightId = undefined;
        }
        if (moves.length > 0) {
            const wanted = new Set(moves.map((move) => `${move.path}:${move.index}`));
            const pieces = this.segmentList.filter((segment) =>
                wanted.has(`${segment.path}:${segment.index}`),
            );
            if (pieces.length > 0) {
                const mesh: EdgeMeshData = {
                    position: this.positions(pieces),
                    color: HIGHLIGHT_COLOR,
                    lineType: "solid",
                    lineWidth: 4,
                    range: [],
                };
                this.highlightId = context.displayMesh([mesh]);
            }
        }
        this.document.visual.update();
    }

    /** The fraction of the drawn length where a move ends (playback position of a line). */
    positionOf(move: MoveRef): number | undefined {
        let end: BackplotSegment | undefined;
        for (const segment of this.segmentList) {
            if (segment.path === move.path && segment.index === move.index) end = segment;
            else if (end !== undefined) break;
        }
        if (end === undefined || this.total <= 0) return undefined;
        return (end.start + end.length) / this.total;
    }

    /** The point at `t` ∈ [0, 1] of the drawn length. */
    pointAt(t: number): BackplotPoint | undefined {
        const segments = this.segmentList;
        if (segments.length === 0) return undefined;
        const target = Math.min(1, Math.max(0, t)) * this.total;
        let low = 0;
        let high = segments.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (segments[mid].start <= target) low = mid;
            else high = mid - 1;
        }
        const piece = segments[low];
        const f = piece.length > 0 ? Math.min(1, Math.max(0, (target - piece.start) / piece.length)) : 1;
        const { from, to } = piece;
        return {
            path: piece.path,
            index: piece.index,
            wcs: [
                from[0] + (to[0] - from[0]) * f,
                from[1] + (to[1] - from[1]) * f,
                from[2] + (to[2] - from[2]) * f,
            ],
            axis: piece.axis ?? [0, 0, 1],
        };
    }

    /** Moves (or shows) the tool marker at `t`; returns where it is. */
    setPlayback(t: number): BackplotPoint | undefined {
        const point = this.pointAt(t);
        if (point === undefined) {
            this.hideMarker();
            return undefined;
        }
        const toolNumber = this.program?.toolpaths[point.path]?.toolNumber;
        const info = this.program?.tools.find((tool) => tool.number === toolNumber);
        const radius = Math.max(0.1, (info?.diameter ?? (this.program?.machineKind === "mill" ? 6 : 1)) / 2);
        const height = Math.max(radius * 4, 10);
        const key = `${radius}:${height}`;
        const context = this.document.visual.context;
        const matrix = markerMatrix(
            this.wcs === IDENTITY_WCS ? point.wcs : wcsPointToModel(this.wcs, point.wcs),
            this.wcs === IDENTITY_WCS ? point.axis : wcsVectorToModel(this.wcs, point.axis),
        );
        if (this.marker !== undefined && this.marker.key !== key) this.hideMarker();
        if (this.marker === undefined) {
            const mesh = { ...cylinderMesh(radius, height), color: MARKER_COLOR };
            this.marker = { id: context.displayInstancedMesh(mesh, [matrix], { meshOpacity: 0.7 }), key };
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

    /**
     * The move whose drawn piece passes nearest to the screen point (`tolerance` pixels), if
     * any — what a click in the viewport picks. Hidden rapids are not picked.
     */
    pick(view: IView, x: number, y: number, tolerance = 8): MoveRef | undefined {
        let best: BackplotSegment | undefined;
        let bestDistance = tolerance;
        const project = (p: Vec3) => {
            const model = this.wcs === IDENTITY_WCS ? p : wcsPointToModel(this.wcs, p);
            return view.worldToScreen(new XYZ({ x: model[0], y: model[1], z: model[2] }));
        };
        let previous: { point: Vec3; screen: { x: number; y: number } } | undefined;
        for (const segment of this.segmentList) {
            if (segment.kind === "rapid" && !this.rapids) {
                previous = undefined;
                continue;
            }
            const a = previous?.point === segment.from ? previous.screen : project(segment.from);
            const b = project(segment.to);
            previous = { point: segment.to, screen: b };
            const distance = distanceToScreenSegment(x, y, a, b);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = segment;
            }
        }
        return best === undefined ? undefined : { path: best.path, index: best.index };
    }

    clear(): void {
        this.clearPaths();
        this.highlight([]);
        this.hideMarker();
        this.program = undefined;
        this.segmentList = [];
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

function distanceToScreenSegment(
    x: number,
    y: number,
    a: { x: number; y: number },
    b: { x: number; y: number },
): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ll = dx * dx + dy * dy;
    const t = ll === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / ll));
    return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}
