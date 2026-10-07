// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ICircle,
    type ICurve,
    type IEdge,
    type IFace,
    type IShape,
    type ISurface,
    type IVertex,
    Logger,
    ShapeTypes,
    type XYZ,
} from "@chili3d/core";
import {
    add,
    applyRigid,
    cross,
    dot,
    type Frame,
    fromMatrix4,
    invert,
    makeFrame,
    norm,
    normalize,
    scale,
    sub,
    transformFrame,
    type Vec3,
    vec,
} from "../math/rigid";
import type {
    ConnectorAnchor,
    ConnectorEntityData,
    ConnectorInference,
    MateConnectorData,
} from "./assemblyTypes";
import { entityIdOf, entityIndexOf, type PlacedPart } from "./evaluate";

/**
 * Mate connectors inferred from picked geometry, as Onshape's implicit mate connectors. Each
 * picked entity offers a few precise candidate origins, and the one nearest the cursor wins:
 *
 * - planar face: Z along the outward normal, at the face's centroid, a vertex, a straight edge's
 *   midpoint or a circular edge's center (a hole);
 * - cylindrical / conical face: Z along the axis, on the axis level with the centroid or with
 *   one of its circular edges;
 * - spherical face: at the center;
 * - circular edge: at the circle's center, Z along its axis;
 * - straight edge: Z along the edge, at its midpoint or an end;
 * - vertex: at the point, axes of the part.
 *
 * Frames are computed in the solid's own coordinates and then carried into the instance's
 * (`inner`), which is where an assembly stores them. A connector remembers the entity and the
 * candidate (`anchor`, by sub-shape index of the solid) — and the part's stable id of the entity
 * when the part tracks ids — so it can be re-inferred after the part changes
 * (`reanchorConnector`).
 */

export interface InferredConnector {
    readonly frame: Frame;
    readonly inference: ConnectorInference;
    readonly anchor?: ConnectorAnchor;
}

export interface InferOptions {
    /** The solid the entity belongs to — needed to offer vertex/edge candidates by index. */
    readonly solid?: IShape;
    /** Pick the candidate nearest this point (solid coordinates). */
    readonly hint?: Vec3;
    /** Pick exactly this candidate (re-anchoring). */
    readonly anchor?: ConnectorAnchor;
}

interface Candidate {
    readonly point: Vec3;
    readonly anchor: ConnectorAnchor;
    readonly x?: Vec3;
}

const toVec = (p: XYZ): Vec3 => vec(p);

/** Area-weighted centroid of a face's tessellation. */
function faceCentroid(face: IFace): Vec3 | undefined {
    const mesh = face.mesh.faces;
    if (mesh === undefined || mesh.index.length === 0) return undefined;
    const p = mesh.position;
    let area = 0;
    let c: Vec3 = [0, 0, 0];
    for (let i = 0; i + 2 < mesh.index.length; i += 3) {
        const [a, b, d] = [mesh.index[i], mesh.index[i + 1], mesh.index[i + 2]];
        const pa: Vec3 = [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]];
        const pb: Vec3 = [p[b * 3], p[b * 3 + 1], p[b * 3 + 2]];
        const pd: Vec3 = [p[d * 3], p[d * 3 + 1], p[d * 3 + 2]];
        const w = norm(cross(sub(pb, pa), sub(pd, pa))) / 2;
        area += w;
        c = add(c, scale(add(add(pa, pb), pd), w / 3));
    }
    return area > 0 ? scale(c, 1 / area) : undefined;
}

function basisSurface(surface: ISurface): ISurface {
    const trimmed = surface as unknown as { basisSurface?: () => ISurface };
    return typeof trimmed.basisSurface === "function" ? trimmed.basisSurface() : surface;
}

function basisCurve(curve: ICurve): ICurve {
    const trimmed = curve as unknown as { basisCurve?: ICurve };
    return trimmed.basisCurve !== undefined && trimmed.basisCurve !== null ? trimmed.basisCurve : curve;
}

type SurfaceKind = "plane" | "cylinder" | "cone" | "sphere" | "other";

function surfaceKind(surface: ISurface): SurfaceKind {
    if (surface.isPlanar()) return "plane";
    const s = surface as unknown as Record<string, unknown>;
    if (!("axis" in s) || !("location" in s)) return "other";
    if ("semiAngle" in s) return "cone";
    if (typeof s["radius"] === "number") {
        // A sphere reports its own area and volume; a cylinder does not.
        return typeof s["volume"] === "function" ? "sphere" : "cylinder";
    }
    return "other";
}

/** The outward normal of a face at the parameter nearest `point` (orientation respected). */
function faceNormal(face: IFace, surface: ISurface, point: Vec3): Vec3 {
    const uv = surface.parameter({ x: point[0], y: point[1], z: point[2] } as XYZ, 1e3);
    const [, normal] = face.normal(uv?.u ?? 0, uv?.v ?? 0);
    return normalize(toVec(normal));
}

/** X axis hint: world X projected off Z, or world Y when Z is along X. */
function xHint(z: Vec3): Vec3 {
    const n = normalize(z);
    return Math.abs(n[0]) > 1 - 1e-6 ? [0, 1, 0] : [1, 0, 0];
}

/** What a curve is, read safely (a degenerate edge has none). */
interface EdgeGeometry {
    readonly kind: "circle" | "line" | "other";
    readonly start: Vec3;
    readonly end: Vec3;
    readonly mid: Vec3;
    readonly center?: Vec3;
    readonly axis?: Vec3;
    readonly x?: Vec3;
}

function edgeGeometry(edge: IEdge): EdgeGeometry | undefined {
    const first = edge.firstParameter();
    const last = edge.lastParameter();
    const start = toVec(edge.pointAt(first));
    const end = toVec(edge.pointAt(last));
    const mid = toVec(edge.pointAt((first + last) / 2));
    let curve: ICurve | undefined;
    try {
        curve = edge.curve;
        const basis = basisCurve(curve);
        if (basis.curveType === "circle") {
            const circle = basis as unknown as ICircle;
            return {
                kind: "circle",
                start,
                end,
                mid,
                center: toVec(circle.center),
                axis: normalize(toVec(circle.axis)),
                x: toVec(circle.xAxis),
            };
        }
        return { kind: basis.curveType === "line" ? "line" : "other", start, end, mid };
    } catch (error) {
        Logger.warn("mate connector: the edge has no usable curve", error);
        return undefined;
    } finally {
        curve?.dispose();
    }
}

/** Index of `shape` among the solid's sub-shapes of its type (the order indexes refer to). */
function indexIn(all: readonly IShape[], shape: IShape): number {
    return all.findIndex((x) => x.isSame(shape));
}

function choose(candidates: readonly Candidate[], options: InferOptions): Candidate {
    const wanted = options.anchor;
    if (wanted !== undefined) {
        const exact = candidates.find(
            (c) => c.anchor.kind === wanted.kind && c.anchor.index === wanted.index,
        );
        if (exact !== undefined) return exact;
    }
    const hint = options.hint;
    if (hint === undefined) return candidates[0];
    let best = candidates[0];
    let distance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        const d = norm(sub(candidate.point, hint));
        if (d < distance - 1e-9) {
            best = candidate;
            distance = d;
        }
    }
    return best;
}

/** Vertex, edge-midpoint and circle-center candidates on the boundary of a face. */
function boundaryCandidates(face: IFace, solid: IShape | undefined): Candidate[] {
    if (solid === undefined) return [];
    const candidates: Candidate[] = [];
    const solidEdges = solid.findSubShapes(ShapeTypes.edge);
    const solidVertices = solid.findSubShapes(ShapeTypes.vertex);
    const edges = face.findSubShapes(ShapeTypes.edge) as IEdge[];
    const vertices = face.findSubShapes(ShapeTypes.vertex) as IVertex[];
    try {
        // Ends of arcs (a hole's seam, a slot's tangent points) are no useful origin.
        const arcEnds: Vec3[] = [];
        for (const edge of edges) {
            const geometry = edgeGeometry(edge);
            const index = indexIn(solidEdges, edge);
            if (geometry === undefined || index < 0) continue;
            if (geometry.kind === "circle" && geometry.center !== undefined) {
                arcEnds.push(geometry.start, geometry.end);
                if (!candidates.some((c) => norm(sub(c.point, geometry.center!)) < 1e-9)) {
                    candidates.push({
                        point: geometry.center,
                        anchor: { kind: "circleCenter", index },
                        x: geometry.x,
                    });
                }
            } else if (geometry.kind === "line") {
                candidates.push({ point: geometry.mid, anchor: { kind: "edgeMid", index } });
            }
        }
        for (const vertex of vertices) {
            const index = indexIn(solidVertices, vertex);
            const point = toVec(vertex.point());
            if (index < 0 || arcEnds.some((end) => norm(sub(end, point)) < 1e-7)) continue;
            candidates.push({ point, anchor: { kind: "vertex", index } });
        }
    } finally {
        for (const x of [...solidEdges, ...solidVertices, ...edges, ...vertices]) x.dispose();
    }
    return candidates;
}

function inferFace(face: IFace, options: InferOptions): InferredConnector | undefined {
    const surface = face.surface();
    const basis = basisSurface(surface);
    try {
        const centroid = faceCentroid(face);
        const kind = surfaceKind(basis);
        if (centroid === undefined) return undefined;
        if (kind === "plane") {
            const normal = faceNormal(face, surface, centroid);
            const choice = choose(
                [
                    { point: centroid, anchor: { kind: "centroid" } },
                    ...boundaryCandidates(face, options.solid),
                ],
                options,
            );
            return {
                frame: makeFrame(choice.point, normal, choice.x ?? xHint(normal)),
                inference: "planarFace",
                anchor: choice.anchor,
            };
        }
        if (kind === "cylinder" || kind === "cone") {
            const elementary = basis as unknown as { axis: XYZ; location: XYZ };
            const axis = normalize(toVec(elementary.axis));
            const location = toVec(elementary.location);
            const onAxis = (p: Vec3) => add(location, scale(axis, dot(sub(p, location), axis)));
            const rings = boundaryCandidates(face, options.solid).filter(
                (c) => c.anchor.kind === "circleCenter",
            );
            const choice = choose(
                [
                    { point: onAxis(centroid), anchor: { kind: "centroid" } },
                    ...rings.map((c) => ({ ...c, point: onAxis(c.point) })),
                ],
                { ...options, hint: options.hint === undefined ? undefined : onAxis(options.hint) },
            );
            return {
                frame: makeFrame(choice.point, axis, xHint(axis)),
                inference: kind === "cylinder" ? "cylindricalFace" : "conicalFace",
                anchor: choice.anchor,
            };
        }
        if (kind === "sphere") {
            const elementary = basis as unknown as { axis: XYZ; location: XYZ };
            const axis = normalize(toVec(elementary.axis));
            return {
                frame: makeFrame(toVec(elementary.location), axis, xHint(axis)),
                inference: "sphericalFace",
            };
        }
        const normal = faceNormal(face, surface, centroid);
        return { frame: makeFrame(centroid, normal, xHint(normal)), inference: "face" };
    } finally {
        if (basis !== surface) basis.dispose();
        surface.dispose();
    }
}

function inferEdge(edge: IEdge, options: InferOptions): InferredConnector | undefined {
    const geometry = edgeGeometry(edge);
    if (geometry === undefined) return undefined;
    if (geometry.kind === "circle" && geometry.center !== undefined && geometry.axis !== undefined) {
        return { frame: makeFrame(geometry.center, geometry.axis, geometry.x), inference: "circularEdge" };
    }
    const direction = sub(geometry.end, geometry.start);
    if (geometry.kind === "line" && norm(direction) > 1e-9) {
        const candidates: Candidate[] = [{ point: geometry.mid, anchor: { kind: "edgeMid" } }];
        if (options.solid !== undefined) {
            const vertices = options.solid.findSubShapes(ShapeTypes.vertex) as IVertex[];
            vertices.forEach((vertex, index) => {
                const point = toVec(vertex.point());
                if (norm(sub(point, geometry.start)) < 1e-7 || norm(sub(point, geometry.end)) < 1e-7) {
                    candidates.push({ point, anchor: { kind: "vertex", index } });
                }
            });
            for (const x of vertices) x.dispose();
        }
        const choice = choose(candidates, options);
        return {
            frame: makeFrame(choice.point, direction, xHint(direction)),
            inference: "linearEdge",
            anchor: choice.anchor,
        };
    }
    // A free-form edge: at its middle, along its tangent there.
    const first = edge.firstParameter();
    const last = edge.lastParameter();
    const tangent = sub(
        toVec(edge.pointAt(first + (last - first) * 0.51)),
        toVec(edge.pointAt(first + (last - first) * 0.49)),
    );
    return { frame: makeFrame(geometry.mid, tangent, xHint(tangent)), inference: "edge" };
}

/** The implicit mate connector of a face, edge or vertex, in that shape's coordinates. */
export function inferConnector(shape: IShape, options: InferOptions = {}): InferredConnector | undefined {
    switch (shape.shapeType) {
        case ShapeTypes.face:
            return inferFace(shape as IFace, options);
        case ShapeTypes.edge:
            return inferEdge(shape as IEdge, options);
        case ShapeTypes.vertex: {
            const point = toVec((shape as IVertex).point());
            return { frame: makeFrame(point, [0, 0, 1], [1, 0, 0]), inference: "vertex" };
        }
        default:
            return undefined;
    }
}

const kindOf = (shape: IShape): ConnectorEntityData["kind"] | undefined =>
    shape.shapeType === ShapeTypes.face
        ? "face"
        : shape.shapeType === ShapeTypes.edge
          ? "edge"
          : shape.shapeType === ShapeTypes.vertex
            ? "vertex"
            : undefined;

/**
 * A mate connector on `part` from one of its sub-shapes (`index` among the part's sub-shapes
 * of that type), in its instance's coordinates. `pickedPoint` (assembly coordinates) chooses
 * among the entity's candidate origins; `anchor` asks for one exactly.
 */
export function connectorFromSubShape(
    part: PlacedPart,
    subShape: IShape,
    index: number,
    pickedPoint?: Vec3,
    anchor?: ConnectorAnchor,
): MateConnectorData | undefined {
    const hint =
        pickedPoint === undefined ? undefined : applyRigid(invert(fromMatrix4(part.placement)), pickedPoint);
    const inferred = inferConnector(subShape, { solid: part.shape, hint, anchor });
    const kind = kindOf(subShape);
    if (inferred === undefined || kind === undefined) return undefined;
    // Sub-shapes found on the solid carry its location already; the frame is in solid coordinates.
    const frame = transformFrame(fromMatrix4(part.inner), inferred.frame);
    const id = kind === "vertex" ? undefined : entityIdOf(part, kind, index);
    return {
        instanceId: part.instanceId,
        origin: frame.origin,
        zAxis: frame.z,
        xAxis: frame.x,
        entity: {
            kind,
            index,
            ...(id === undefined ? {} : { id }),
            ...(part.partIndex === 0 ? {} : { part: part.partIndex }),
            inference: inferred.inference,
            ...(inferred.anchor === undefined ? {} : { anchor: inferred.anchor }),
        },
    };
}

export function connectorFrame(connector: MateConnectorData): Frame {
    return makeFrame(connector.origin, connector.zAxis, connector.xAxis);
}

/** The sub-shapes of a solid of the given kind, in the order indexes refer to. */
export function subShapesOf(shape: IShape, kind: ConnectorEntityData["kind"]): IShape[] {
    const type = kind === "face" ? ShapeTypes.face : kind === "edge" ? ShapeTypes.edge : ShapeTypes.vertex;
    return shape.findSubShapes(type);
}

/**
 * Re-infers a connector from the current geometry of the sub-shape it was picked on — found by
 * its stable id when the part tracks ids, else by index — and the same candidate origin. The
 * stored frame is kept when the entity is gone (the mate then shows as failing rather than
 * jumping somewhere arbitrary). Returns undefined when nothing changed.
 */
export function reanchorConnector(
    connector: MateConnectorData,
    parts: readonly PlacedPart[],
): MateConnectorData | undefined {
    const entity = connector.entity;
    if (entity === undefined) return undefined;
    const part = parts.find(
        (x) => x.instanceId === connector.instanceId && x.partIndex === (entity.part ?? 0),
    );
    if (part === undefined) return undefined;
    let index = entity.index;
    if (entity.id !== undefined && entity.kind !== "vertex") {
        const found = entityIndexOf(part, entity.kind, entity.id);
        if (found === undefined) return undefined;
        index = found;
    }
    const subShapes = subShapesOf(part.shape, entity.kind);
    const subShape = subShapes[index];
    const next =
        subShape === undefined
            ? undefined
            : connectorFromSubShape(part, subShape, index, undefined, entity.anchor);
    for (const x of subShapes) x.dispose();
    if (next === undefined || next.entity?.inference !== entity.inference) return undefined;
    const same = (a: Vec3, b: Vec3) => norm(sub(a, b)) < 1e-9;
    if (
        same(next.origin, connector.origin) &&
        same(next.zAxis, connector.zAxis) &&
        same(next.xAxis, connector.xAxis)
    ) {
        return undefined;
    }
    return {
        ...next,
        entity: { ...next.entity, ...(entity.id === undefined ? {} : { id: entity.id }) },
    } as MateConnectorData;
}
