// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, ShapeTypes, type TrackedShape, type XYZ } from "@chili3d/core";
import { completeEdgeHistory, completeFaceHistory } from "../../features/historyCompletion";
import { denormalize, faceDomain } from "./faceDomain";
import type { FsBody, FsContext, HistorySource } from "./fsContext";

/**
 * History for kernel operations that report none (defeaturing, splitting, sewing): an
 * output face derives from the input face whose surface it lies on, facing the same way —
 * the same face untouched, a piece of it after a split, or the face extended by a heal —
 * and an output edge from the input edge whose curve it runs along. Exact identity is
 * claimed first (one output per input); the same-surface rule then lets several pieces
 * share their input, the first keeping its identity (see `FsContext.rebuildBody`).
 */

/** Distance (mm) within which a point lies on a surface or curve. */
const ON_GEOMETRY_MM = 1e-5;
/** Cosine above which two unit normals point the same way. */
const SAME_DIRECTION = 1 - 1e-6;

interface FaceSample {
    readonly point: XYZ;
    readonly normal: XYZ;
}

/** Points inside a face with its outward normals there: a parameter grid kept to the face. */
export function faceSamples(face: IFace, grid = 3): FaceSample[] {
    let domain: ReturnType<typeof faceDomain> | undefined;
    try {
        domain = faceDomain(face);
        const samples: FaceSample[] = [];
        let fallback: FaceSample | undefined;
        for (let i = 1; i <= grid; i++) {
            for (let j = 1; j <= grid; j++) {
                const { u, v } = denormalize(domain, i / (grid + 1), j / (grid + 1));
                const [point, normal] = face.normal(u, v);
                const length = normal.length();
                if (length < 1e-12) continue;
                const sample = { point, normal: normal.multiply(1 / length) };
                fallback ??= sample;
                if (face.containsPoint(point, false, 1e-7)) samples.push(sample);
            }
        }
        return samples.length > 0 || fallback === undefined ? samples : [fallback];
    } catch {
        return [];
    } finally {
        domain?.dispose();
    }
}

/**
 * How well `samples` (of an output face) sit on `input`: -1 when one is off its surface or
 * faces the other way, else the number of them inside the input face.
 */
function surfaceScore(samples: readonly FaceSample[], input: IFace): number {
    let surface: ReturnType<IFace["surface"]> | undefined;
    try {
        surface = input.surface();
        let inside = 0;
        for (const { point, normal } of samples) {
            const nearest = surface.nearestPoint(point);
            if (nearest === undefined || nearest[1] > ON_GEOMETRY_MM) return -1;
            const uv = surface.parameter(point, ON_GEOMETRY_MM * 10);
            if (uv === undefined) return -1;
            const other = input.normal(uv.u, uv.v)[1];
            const length = other.length();
            if (length < 1e-12 || other.dot(normal) / length < SAME_DIRECTION) return -1;
            if (input.containsPoint(point, true, ON_GEOMETRY_MM)) inside++;
        }
        return inside;
    } catch {
        return -1;
    } finally {
        surface?.dispose();
    }
}

/** The best-scoring candidate (score ≥ 0), preferring unclaimed ones on a tie; -1 when none fits. */
function bestMatch(count: number, score: (index: number) => number, claimed: ReadonlySet<number>): number {
    let best = -1;
    let bestScore = -1;
    for (let index = 0; index < count; index++) {
        const value = score(index);
        if (value < 0) continue;
        if (
            value > bestScore ||
            (value === bestScore && best >= 0 && claimed.has(best) && !claimed.has(index))
        ) {
            best = index;
            bestScore = value;
        }
    }
    return best;
}

/** Fills the unmapped outputs of a face map with the input face each lies on (shared inputs allowed). */
export function completeBySurface(
    inputs: readonly IFace[],
    outputs: readonly IFace[],
    map: readonly number[],
): number[] {
    const completed = [...map];
    const claimed = new Set(completed.filter((index) => index >= 0));
    outputs.forEach((output, i) => {
        if (completed[i] >= 0) return;
        const samples = faceSamples(output);
        if (samples.length === 0) return;
        const index = bestMatch(inputs.length, (k) => surfaceScore(samples, inputs[k]), claimed);
        if (index < 0) return;
        completed[i] = index;
        claimed.add(index);
    });
    return completed;
}

function edgeSamples(edge: IEdge): XYZ[] {
    try {
        const first = edge.firstParameter();
        const last = edge.lastParameter();
        return [0.2, 0.5, 0.8].map((t) => edge.pointAt(first + (last - first) * t));
    } catch {
        return [];
    }
}

/** -1 when a sample is off `input`'s curve, else the number of samples within its range. */
function curveScore(samples: readonly XYZ[], input: IEdge): number {
    try {
        const curve = input.curve;
        const lo = Math.min(input.firstParameter(), input.lastParameter());
        const hi = Math.max(input.firstParameter(), input.lastParameter());
        let inside = 0;
        for (const point of samples) {
            const t = curve.parameter(point, ON_GEOMETRY_MM);
            if (t === undefined) return -1;
            if (curve.value(t).distanceTo(point) > ON_GEOMETRY_MM) return -1;
            if (t >= lo - 1e-9 && t <= hi + 1e-9) inside++;
        }
        return inside;
    } catch {
        return -1;
    }
}

/** Fills the unmapped outputs of an edge map with the input edge each runs along (shared inputs allowed). */
export function completeByCurve(
    inputs: readonly IEdge[],
    outputs: readonly IEdge[],
    map: readonly number[],
): number[] {
    const completed = [...map];
    const claimed = new Set(completed.filter((index) => index >= 0));
    outputs.forEach((output, i) => {
        if (completed[i] >= 0) return;
        const samples = edgeSamples(output);
        if (samples.length === 0) return;
        const index = bestMatch(inputs.length, (k) => curveScore(samples, inputs[k]), claimed);
        if (index < 0) return;
        completed[i] = index;
        claimed.add(index);
    });
    return completed;
}

/**
 * `result` as a history-tracked shape over `sources` (in their kernel order): exact
 * identity first, then same-surface and same-curve ancestry. `base` maps reported by the
 * kernel, when there are any, take precedence.
 */
export function geometricHistory(
    ctx: FsContext,
    result: IShape,
    sources: readonly HistorySource[],
    base?: { readonly faceMap?: readonly number[]; readonly edgeMap?: readonly number[] },
): TrackedShape {
    const inputFaces = sources.flatMap((source) => source.faces);
    const inputEdges = sources.flatMap((source) => source.edges);
    const outputFaces = ctx.track(result.findSubShapes(ShapeTypes.face)) as IFace[];
    const outputEdges = ctx.track(result.findSubShapes(ShapeTypes.edge)) as IEdge[];
    const aligned = (map: readonly number[] | undefined, outputs: number, inputs: number) =>
        Array.from({ length: outputs }, (_, i) => {
            const index = map?.[i] ?? -1;
            return index >= 0 && index < inputs ? index : -1;
        });
    const faceMap = completeBySurface(
        inputFaces,
        outputFaces,
        completeFaceHistory(
            inputFaces,
            outputFaces,
            aligned(base?.faceMap, outputFaces.length, inputFaces.length),
        ),
    );
    const edgeMap = completeByCurve(
        inputEdges,
        outputEdges,
        completeEdgeHistory(
            inputEdges,
            outputEdges,
            aligned(base?.edgeMap, outputEdges.length, inputEdges.length),
        ),
    );
    return { shape: result, faceMap, edgeMap };
}

/**
 * Bodies rebuilt from one input each inherit its entities' serials independently; a serial
 * landing in several of them (pieces of one face in several bodies) stays with the first
 * and the others get fresh serials, logged as split from it — a transient id names one
 * entity.
 */
export function separateSerials(ctx: FsContext, opId: string, bodies: readonly FsBody[]): void {
    const seen = new Set<number>();
    const distinct = (attrs: FsBody["faceAttrs"]) =>
        attrs.map((attr) => {
            if (!seen.has(attr.serial)) {
                seen.add(attr.serial);
                return attr;
            }
            const fresh = { ...attr, serial: ctx.newSerial() };
            ctx.derive(opId, fresh.serial, [attr.serial], "split");
            seen.add(fresh.serial);
            return fresh;
        });
    for (const body of bodies) {
        body.faceAttrs = distinct(body.faceAttrs);
        body.edgeAttrs = distinct(body.edgeAttrs);
        body.vertexAttrs = distinct(body.vertexAttrs);
    }
}
