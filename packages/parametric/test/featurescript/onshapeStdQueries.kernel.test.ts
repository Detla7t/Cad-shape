// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Onshape's query types past the selection basics — topology filters and flood fills,
 * geometric filters, history queries (tracking, dependencies) — on small Part Studios: a
 * box, a box with fillets, a pocket, holes, a pattern, a sketch extrude, a hollow box.
 * Each Part Studio returns a map of entity counts and identity checks built with std's own
 * `q*` constructors, run on BOTH standard libraries — Onshape's std 3083 (through the
 * bridge) and the native TypeScript std — and both must give exactly the expected map.
 * `QueryType` values std declares without a constructor run as raw query maps on
 * Onshape's std alone.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsContext } from "../../src/featurescript/context/fsContext";
import type { Interpreter } from "../../src/featurescript/lang/interpreter";
import { FsArray, FsEnumValue, FsMap, FsQuantity, type FsValue } from "../../src/featurescript/lang/values";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { createInterpreter } from "../../src/featurescript/runtime";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

const STDS = ["onshape", "native"] as const;
type Std = (typeof STDS)[number];

let interpreters: Record<Std, Interpreter>;

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    interpreters = {
        onshape: createOnshapeInterpreter({ std: ONSHAPE_STD }),
        native: createInterpreter({}),
    };
});

/** A Part Studio's returned FeatureScript value as plain data (quantities in SI, enums by name). */
function plain(value: FsValue): unknown {
    if (value instanceof FsMap) {
        const out: Record<string, unknown> = {};
        for (const [key, item] of value.pairs()) out[String(key)] = plain(item);
        return out;
    }
    if (value instanceof FsArray) return value.items.map(plain);
    if (value instanceof FsEnumValue) return value.name;
    if (value instanceof FsQuantity) return value.value;
    return value;
}

let studioCount = 0;

/** Runs `body` as a Part Studio's build function on `std`; returns what it returns. */
function partStudio(std: Std, body: string): unknown {
    const interpreter = interpreters[std];
    const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

function count(context is Context, q is Query) returns number
{
    return size(evaluateQuery(context, q));
}

function same(context is Context, a is Query, b is Query) returns boolean
{
    return isQueryEmpty(context, qSubtraction(a, b)) && isQueryEmpty(context, qSubtraction(b, a));
}

export function build(context is Context)
{
${body}
}
`;
    const module = interpreter.load({ path: `queryStudio${studioCount++}`, source });
    const context = new FsContext();
    try {
        return plain(interpreter.callFunction(module.env.lookup("build")?.value, [context.value]));
    } finally {
        context.dispose();
    }
}

const MM = "* millimeter";
const at = (x: number, y: number, z: number) => `vector(${x}, ${y}, ${z}) ${MM}`;
const horizontal = (z: number) => `plane(${at(0, 0, z)}, vector(0, 0, 1))`;

/** A box part (corners in mm) with the usual handles on its entities. */
const box = (id: string, x0: number, x1: number) => `
    fCuboid(context, makeId("${id}"), { "corner1" : ${at(x0, 0, 0)}, "corner2" : ${at(x1, 30, 20)} });`;

const BOX = `${box("box", 0, 40)}
    const part = qCreatedBy(makeId("box"), EntityType.BODY);
    const faces = qOwnedByBody(part, EntityType.FACE);
    const edges = qOwnedByBody(part, EntityType.EDGE);
    const vertices = qOwnedByBody(part, EntityType.VERTEX);
    const top = qCoincidesWithPlane(faces, ${horizontal(20)});
    const bottom = qCoincidesWithPlane(faces, ${horizontal(0)});
    const topEdges = qAdjacent(top, AdjacencyType.EDGE, EntityType.EDGE);
    const vertical = qParallelEdges(edges, Z_DIRECTION);`;

/** A closed polygon of sketch lines `l0`, `l1`, ... on the plane z = `z`. */
function polygon(id: string, z: number, points: [number, number][]): string {
    const lines = points.map((p, i) => {
        const q = points[(i + 1) % points.length];
        return `skLineSegment(s, "l${i}", { "start" : vector(${p[0]}, ${p[1]}) ${MM}, "end" : vector(${q[0]}, ${q[1]}) ${MM} });`;
    });
    return `{ const s = newSketchOnPlane(context, makeId("${id}"), { "sketchPlane" : ${horizontal(z)} });
      ${lines.join("\n      ")}
      skSolve(s); }`;
}

/** Cuts the regions of sketch `sketch` from the box, `depth` mm (or through all) down. */
const cut = (id: string, sketch: string, bound: string, depth = 0) => `
    extrude(context, makeId("${id}"), { "entities" : qSketchRegion(makeId("${sketch}")), "endBound" : BoundingType.${bound},
        "depth" : ${depth} ${MM}, "operationType" : NewBodyOperationType.REMOVE, "oppositeDirection" : true,
        "defaultScope" : false, "booleanScope" : part });`;

/** Runs a Part Studio on both stds; both must return exactly `expected`. */
function onBothStds(name: string, body: string, expected: Record<string, unknown>): void {
    test.each(STDS)(`${name} (%s std)`, (std) => {
        expect(partStudio(std, body)).toEqual(expected);
    });
}

describe("edge topology and vertices", () => {
    onBothStds(
        "qEdgeTopologyFilter tells two-sided, laminar and wire edges apart",
        `${BOX}
    ${polygon("sheet", -10, [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
    ])}
    const all = qEverything(EntityType.EDGE);
    return {
        "twoSided" : count(context, qEdgeTopologyFilter(all, EdgeTopology.TWO_SIDED)),
        "oneSided" : count(context, qEdgeTopologyFilter(all, EdgeTopology.ONE_SIDED)),
        "laminar" : count(context, qEdgeTopologyFilter(all, EdgeTopology.LAMINAR)),
        "wire" : count(context, qEdgeTopologyFilter(all, EdgeTopology.WIRE)),
        "partEdgesTwoSided" : same(context, qEdgeTopologyFilter(all, EdgeTopology.TWO_SIDED), edges),
        "wireAreSketchCurves" : same(context, qEdgeTopologyFilter(all, EdgeTopology.WIRE), qBodyType(qCreatedBy(makeId("sheet"), EntityType.EDGE), BodyType.WIRE)),
        "laminarAreRegionEdges" : same(context, qEdgeTopologyFilter(all, EdgeTopology.ONE_SIDED), qOwnedByBody(qOwnerBody(qSketchRegion(makeId("sheet"))), EntityType.EDGE))
    };`,
        {
            twoSided: 12,
            oneSided: 4,
            laminar: 4,
            wire: 4,
            partEdgesTwoSided: true,
            wireAreSketchCurves: true,
            laminarAreRegionEdges: true,
        },
    );

    onBothStds(
        "qEdgeVertex picks the vertex at an edge's start or end",
        `${BOX}
    const edge = qNthElement(topEdges, 0);
    const start = evVertexPoint(context, { "vertex" : qEdgeVertex(edge, true) });
    const end = evVertexPoint(context, { "vertex" : qEdgeVertex(edge, false) });
    return {
        "starts" : count(context, qEdgeVertex(vertical, true)),
        "ends" : count(context, qEdgeVertex(vertical, false)),
        "both" : count(context, qUnion([qEdgeVertex(vertical, true), qEdgeVertex(vertical, false)])),
        "all" : count(context, qUnion([qEdgeVertex(edges, true), qEdgeVertex(edges, false)])),
        "startAtParameter0" : tolerantEquals(start, evEdgeTangentLine(context, { "edge" : edge, "parameter" : 0 }).origin),
        "endAtParameter1" : tolerantEquals(end, evEdgeTangentLine(context, { "edge" : edge, "parameter" : 1 }).origin),
        "nonEdgesIgnored" : count(context, qEdgeVertex(faces, true))
    };`,
        {
            starts: 4,
            ends: 4,
            both: 8,
            all: 8,
            startAtParameter0: true,
            endAtParameter1: true,
            nonEdgesIgnored: 0,
        },
    );

    onBothStds(
        "qUniqueVertices and qCoincidentFilter on two boxes sharing a face",
        `${box("left", 0, 40)} ${box("right", 40, 80)}
    const leftPart = qCreatedBy(makeId("left"), EntityType.BODY);
    const rightPart = qCreatedBy(makeId("right"), EntityType.BODY);
    const shared = qCoincidesWithPlane(qOwnedByBody(leftPart, EntityType.FACE), plane(${at(40, 0, 0)}, X_DIRECTION));
    return {
        "vertices" : count(context, qEverything(EntityType.VERTEX)),
        "unique" : count(context, qUniqueVertices(qEverything(EntityType.VERTEX))),
        "keepsTheFirst" : same(context, qUniqueVertices(qEverything(EntityType.VERTEX)), qUnion([qOwnedByBody(leftPart, EntityType.VERTEX), qSubtraction(qOwnedByBody(rightPart, EntityType.VERTEX), qCoincidesWithPlane(qOwnedByBody(rightPart, EntityType.VERTEX), plane(${at(40, 0, 0)}, X_DIRECTION)))])),
        "coincidentFaces" : count(context, qCoincidentFilter(qOwnedByBody(rightPart, EntityType.FACE), shared)),
        "coincidentFaceIsTheTouchingOne" : same(context, qCoincidentFilter(qOwnedByBody(rightPart, EntityType.FACE), shared), qCoincidesWithPlane(qOwnedByBody(rightPart, EntityType.FACE), plane(${at(40, 0, 0)}, X_DIRECTION))),
        "coincidentEdges" : count(context, qCoincidentFilter(qOwnedByBody(rightPart, EntityType.EDGE), qOwnedByBody(leftPart, EntityType.EDGE)))
    };`,
        {
            vertices: 16,
            unique: 12,
            keepsTheFirst: true,
            coincidentFaces: 1,
            coincidentFaceIsTheTouchingOne: true,
            coincidentEdges: 4,
        },
    );
});

const FILLETS = `${BOX}
    const left = qCoincidesWithPlane(edges, plane(${at(0, 0, 0)}, X_DIRECTION));
    const front = qCoincidesWithPlane(edges, plane(${at(0, 0, 0)}, Y_DIRECTION));
    const big = qIntersection([vertical, left, front]);
    const small = qSubtraction(qIntersection([vertical, left]), front);
    const side = qCoincidesWithPlane(faces, plane(${at(40, 0, 0)}, X_DIRECTION));
    const trackTop = startTracking(context, top);
    const trackSide = startTracking(context, side);
    const trackEdge = startTracking(context, big);
    const identity = startTrackingIdentity(context, top);
    const robust = makeRobustQuery(context, top);
    fillet(context, makeId("fillet1"), { "entities" : big, "radius" : 5 ${MM} });
    fillet(context, makeId("fillet2"), { "entities" : small, "radius" : 3 ${MM} });
    const rounds = qGeometry(faces, GeometryType.CYLINDER);
    const bigRound = qLargest(rounds);
    const smallRound = qSmallest(rounds);
    const smoothEdges = qEdgeConvexityTypeFilter(edges, EdgeConvexityType.SMOOTH);
    const arcs = qGeometry(edges, GeometryType.ARC);
    const bigArc = qIntersection([arcs, qAdjacent(bigRound, AdjacencyType.EDGE, EntityType.EDGE), qAdjacent(top, AdjacencyType.EDGE, EntityType.EDGE)]);`;

describe("tangency, convexity and fillets", () => {
    onBothStds(
        "a box with two filleted edges (r = 5 and r = 3)",
        `${FILLETS}
    return {
        "faces" : count(context, faces),
        "rounds" : count(context, rounds),
        "smoothEdges" : count(context, smoothEdges),
        "convexEdges" : count(context, qEdgeConvexityTypeFilter(edges, EdgeConvexityType.CONVEX)),
        "smoothConvexity" : evEdgeConvexity(context, { "edge" : qNthElement(smoothEdges, 0) }),
        "tangentChain" : count(context, qTangentConnectedFaces(bigRound)),
        "tangentChainSides" : same(context, qTangentConnectedFaces(bigRound), qAdjacent(smoothEdges, AdjacencyType.EDGE, EntityType.FACE)),
        "topTangentToNothing" : count(context, qTangentConnectedFaces(top)),
        "within91Degrees" : count(context, qTangentConnectedFaces(top, 91 * degree)),
        "convexFromTop" : count(context, qConvexConnectedFaces(top)),
        "concaveFromTop" : count(context, qConcaveConnectedFaces(top)),
        "edgeChain" : count(context, qTangentConnectedEdges(bigArc)),
        "edgeChainOnTop" : same(context, qTangentConnectedEdges(bigArc), qSubtraction(topEdges, qClosestTo(topEdges, ${at(40, 15, 20)}))),
        "straightEdgeAlone" : count(context, qTangentConnectedEdges(qClosestTo(topEdges, ${at(40, 15, 20)}))),
        "filletsEqualBig" : same(context, qFilletFaces(bigRound, CompareType.EQUAL), bigRound),
        "filletsUpToBig" : count(context, qFilletFaces(bigRound, CompareType.LESS_EQUAL)),
        "filletsFromSmall" : count(context, qFilletFaces(smallRound, CompareType.GREATER_EQUAL)),
        "planeIsNoFillet" : count(context, qFilletFaces(top, CompareType.EQUAL)),
        "bigRadius" : evFilletRadius(context, { "face" : bigRound }) / millimeter,
        "smallRadius" : evFilletRadius(context, { "face" : smallRound }) / millimeter,
        "matchingRound" : count(context, qMatching(bigRound)),
        "matchingSide" : count(context, qMatching(side))
    };`,
        {
            faces: 8,
            rounds: 2,
            smoothEdges: 4,
            convexEdges: 14,
            smoothConvexity: "SMOOTH",
            tangentChain: 5,
            tangentChainSides: true,
            topTangentToNothing: 1,
            within91Degrees: 8,
            convexFromTop: 8,
            concaveFromTop: 1,
            edgeChain: 5,
            edgeChainOnTop: true,
            straightEdgeAlone: 1,
            filletsEqualBig: true,
            filletsUpToBig: 2,
            filletsFromSmall: 2,
            planeIsNoFillet: 0,
            bigRadius: 5,
            smallRadius: 3,
            matchingRound: 1,
            matchingSide: 1,
        },
    );

    onBothStds(
        "tracking through fillets",
        `${FILLETS}
    return {
        "modifiedTop" : same(context, trackTop, top),
        "untouchedSide" : count(context, trackSide),
        "filletFaceFromEdge" : same(context, qEntityFilter(trackEdge, EntityType.FACE), bigRound),
        "edgesFromEdge" : count(context, qEntityFilter(trackEdge, EntityType.EDGE)),
        "identity" : same(context, identity, top),
        "robust" : same(context, robust, top),
        "lastModifiedBy" : lastModifyingOperationId(context, top)[0],
        "sideLastModifiedBy" : lastModifyingOperationId(context, side)[0]
    };`,
        {
            modifiedTop: true,
            untouchedSide: 0,
            filletFaceFromEdge: true,
            edgesFromEdge: 4,
            identity: true,
            robust: true,
            lastModifiedBy: "fillet2",
            sideLastModifiedBy: "box",
        },
    );
});

const POCKET = `${BOX}
    ${polygon("pk", 20, [
        [10, 10],
        [30, 10],
        [30, 20],
        [10, 20],
    ])}
    ${cut("pocket", "pk", "BLIND", 5)}
    const floor = qCoincidesWithPlane(faces, ${horizontal(15)});
    const walls = qSubtraction(qConcaveConnectedFaces(floor), floor);
    const rim = qClosestTo(topEdges, ${at(20, 10, 20)});`;

describe("loops and bounded faces", () => {
    onBothStds(
        "a pocket cut into the box",
        `${POCKET}
    return {
        "faces" : count(context, faces),
        "pocket" : count(context, qConcaveConnectedFaces(floor)),
        "walls" : count(context, walls),
        "concaveEdges" : count(context, qEdgeConvexityTypeFilter(edges, EdgeConvexityType.CONCAVE)),
        "convexEdges" : count(context, qEdgeConvexityTypeFilter(edges, EdgeConvexityType.CONVEX)),
        "floorEdgeConvexity" : evEdgeConvexity(context, { "edge" : qNthElement(qAdjacent(floor, AdjacencyType.EDGE, EntityType.EDGE), 0) }),
        "rimConvexity" : evEdgeConvexity(context, { "edge" : rim }),
        "convexFromTop" : same(context, qConvexConnectedFaces(top), qSubtraction(faces, floor)),
        "loopBoundedPocket" : same(context, qLoopBoundedFaces(qUnion([top, rim])), qConcaveConnectedFaces(floor)),
        "loopBoundedOutside" : same(context, qLoopBoundedFaces(qUnion([top, qClosestTo(topEdges, ${at(20, 0, 20)})])), qSubtraction(faces, qUnion([top, qConcaveConnectedFaces(floor)]))),
        "boundedByTop" : same(context, qFaceOrEdgeBoundedFaces(qUnion([floor, top])), qConcaveConnectedFaces(floor)),
        "boundedByFloorEdges" : same(context, qFaceOrEdgeBoundedFaces(qUnion([floor, qAdjacent(floor, AdjacencyType.EDGE, EntityType.EDGE)])), floor),
        "unbounded" : count(context, qFaceOrEdgeBoundedFaces(top))
    };`,
        {
            faces: 11,
            pocket: 5,
            walls: 4,
            concaveEdges: 8,
            convexEdges: 16,
            floorEdgeConvexity: "CONCAVE",
            rimConvexity: "CONVEX",
            convexFromTop: true,
            loopBoundedPocket: true,
            loopBoundedOutside: true,
            boundedByTop: true,
            boundedByFloorEdges: true,
            unbounded: 11,
        },
    );

    onBothStds(
        "a box with an inner void: two shells, outward and inward",
        `${BOX}
    fCuboid(context, makeId("void"), { "corner1" : ${at(10, 10, 5)}, "corner2" : ${at(30, 20, 15)} });
    booleanBodies(context, makeId("hollow"), { "tools" : qCreatedBy(makeId("void"), EntityType.BODY), "targets" : part,
        "operationType" : BooleanOperationType.SUBTRACTION });
    const cavityFloor = qCoincidesWithPlane(faces, ${horizontal(5)});
    return {
        "faces" : count(context, faces),
        "convexOutside" : count(context, qConvexConnectedFaces(top)),
        "concaveCavity" : count(context, qConcaveConnectedFaces(cavityFloor)),
        "cavityEdgeConvexity" : evEdgeConvexity(context, { "edge" : qNthElement(qAdjacent(cavityFloor, AdjacencyType.EDGE, EntityType.EDGE), 0) }),
        "convexCavity" : count(context, qConvexConnectedFaces(cavityFloor))
    };`,
        { faces: 12, convexOutside: 6, concaveCavity: 6, cavityEdgeConvexity: "CONCAVE", convexCavity: 1 },
    );
});

const HOLE = (bound: string, depth: number) => `${BOX}
    { const s = newSketchOnPlane(context, makeId("hk"), { "sketchPlane" : ${horizontal(20)} });
      skCircle(s, "c", { "center" : vector(20, 15) ${MM}, "radius" : 4 ${MM} }); skSolve(s); }
    ${cut("hole", "hk", bound, depth)}
    const wall = qGeometry(faces, GeometryType.CYLINDER);
    const axis = line(${at(20, 15, 0)}, vector(0, 0, 1));
    const entities = qUnion([faces, edges]);`;

describe("holes, axes and geometric filters", () => {
    onBothStds(
        "a blind hole",
        `${HOLE("BLIND", 8)}
    const holeFloor = qCoincidesWithPlane(faces, ${horizontal(12)});
    return {
        "holeFaces" : same(context, qHoleFaces(wall), qUnion([wall, holeFloor])),
        "holeFromFloor" : same(context, qHoleFaces(holeFloor), qUnion([wall, holeFloor])),
        "onAxis" : count(context, qAxis(entities, axis)),
        "onAxisAreWallAndCircles" : same(context, qAxis(entities, axis), qUnion([wall, qGeometry(edges, GeometryType.CIRCLE)])),
        "axisSignIgnored" : count(context, qAxis(entities, line(${at(20, 15, 50)}, vector(0, 0, -1)))),
        "offAxis" : count(context, qAxis(entities, line(${at(21, 15, 0)}, vector(0, 0, 1)))),
        "twoSided" : count(context, qEdgeTopologyFilter(edges, EdgeTopology.TWO_SIDED)),
        "edges" : count(context, edges),
        "lineThroughHole" : same(context, qIntersectsLine(faces, axis), qUnion([holeFloor, bottom])),
        "facesAlongZ" : count(context, qFacesParallelToDirection(faces, Z_DIRECTION)),
        "planesAlongZ" : count(context, qPlanesParallelToDirection(faces, Z_DIRECTION))
    };`,
        {
            holeFaces: true,
            holeFromFloor: true,
            onAxis: 3,
            onAxisAreWallAndCircles: true,
            axisSignIgnored: 3,
            offAxis: 0,
            twoSided: 15,
            edges: 15,
            lineThroughHole: true,
            facesAlongZ: 5,
            planesAlongZ: 4,
        },
    );

    onBothStds(
        "a through hole",
        `${HOLE("THROUGH_ALL", 0)}
    return {
        "holeFaces" : same(context, qHoleFaces(wall), wall),
        "lineThroughHole" : count(context, qIntersectsLine(faces, axis)),
        "lineThroughWall" : count(context, qIntersectsLine(faces, line(${at(24, 15, 0)}, vector(0, 0, 1))))
    };`,
        { holeFaces: true, lineThroughHole: 0, lineThroughWall: 3 },
    );

    onBothStds(
        "planes and lines through the box",
        `${BOX}
    const middle = ${horizontal(10)};
    const verticalLine = line(${at(20, 15, 0)}, vector(0, 0, 1));
    return {
        "crossingFaces" : count(context, qIntersectsPlane(faces, middle)),
        "crossingEdges" : same(context, qIntersectsPlane(edges, middle), vertical),
        "crossingVertices" : count(context, qIntersectsPlane(vertices, middle)),
        "crossingBody" : count(context, qIntersectsPlane(part, middle)),
        "inFront" : same(context, qInFrontOfPlane(faces, middle), top),
        "behind" : same(context, qInFrontOfPlane(faces, plane(${at(0, 0, 10)}, vector(0, 0, -1))), bottom),
        "inFrontEdges" : same(context, qInFrontOfPlane(edges, middle), topEdges),
        "inFrontVertices" : count(context, qInFrontOfPlane(vertices, middle)),
        "touchingCounts" : count(context, qInFrontOfPlane(faces, ${horizontal(20)})),
        "touchingVertices" : count(context, qInFrontOfPlane(vertices, ${horizontal(20)})),
        "wholeBodyInFront" : count(context, qInFrontOfPlane(part, ${horizontal(0)})),
        "lineHitsTopAndBottom" : same(context, qIntersectsLine(faces, verticalLine), qUnion([top, bottom])),
        "lineAlongAnEdge" : count(context, qIntersectsLine(edges, line(${at(0, 0, -5)}, vector(0, 0, 1)))),
        "missingLine" : count(context, qIntersectsLine(faces, line(${at(100, 0, 0)}, vector(0, 0, 1)))),
        "planesAlongZ" : count(context, qPlanesParallelToDirection(faces, Z_DIRECTION)),
        "facesAlongX" : same(context, qFacesParallelToDirection(faces, X_DIRECTION), qSubtraction(faces, qParallelPlanes(faces, X_DIRECTION)))
    };`,
        {
            crossingFaces: 4,
            crossingEdges: true,
            crossingVertices: 0,
            crossingBody: 1,
            inFront: true,
            behind: true,
            inFrontEdges: true,
            inFrontVertices: 4,
            touchingCounts: 1,
            touchingVertices: 4,
            wholeBodyInFront: 1,
            lineHitsTopAndBottom: true,
            lineAlongAnEdge: 5,
            missingLine: 0,
            planesAlongZ: 4,
            facesAlongX: true,
        },
    );

    onBothStds(
        "qCoEdge, qMatching and the axis of an edge",
        `${BOX}
    return {
        "coEdges" : same(context, qCoEdge(top, edges), topEdges),
        "noCoEdges" : count(context, qCoEdge(top, vertical)),
        "matchingTop" : same(context, qMatching(top), qUnion([top, bottom])),
        "matchingEdge" : count(context, qMatching(qNthElement(vertical, 0))),
        "axisOfEdge" : count(context, qAxis(edges, line(${at(0, 0, 0)}, vector(0, 0, 1))))
    };`,
        { coEdges: true, noCoEdges: 0, matchingTop: true, matchingEdge: 4, axisOfEdge: 1 },
    );
});

describe("history: tracking, dependencies, patterns", () => {
    onBothStds(
        "a sketch extruded into a part",
        `${polygon("sk", 0, [
            [0, 0],
            [20, 0],
            [20, 10],
            [0, 10],
        ])}
    const line0 = sketchEntityQuery(makeId("sk"), EntityType.EDGE, "l0");
    const fromLine = startTracking(context, makeId("sk"), "l0");
    const fromRegion = startTracking(context, qSketchRegion(makeId("sk")));
    extrude(context, makeId("ext"), { "entities" : qSketchRegion(makeId("sk")), "endBound" : BoundingType.BLIND, "depth" : 5 ${MM} });
    const part = qCreatedBy(makeId("ext"), EntityType.BODY);
    const side = qEntityFilter(fromLine, EntityType.FACE);
    const sideEdges = qEntityFilter(fromLine, EntityType.EDGE);
    return {
        "fromLine" : count(context, fromLine),
        "sideFace" : same(context, side, qClosestTo(qOwnedByBody(part, EntityType.FACE), ${at(10, -1, 2.5)})),
        "sideEdges" : same(context, sideEdges, qSubtraction(qAdjacent(side, AdjacencyType.EDGE, EntityType.EDGE), qParallelEdges(qOwnedByBody(part, EntityType.EDGE), Z_DIRECTION))),
        "fromRegion" : count(context, fromRegion),
        "regionMadeBodyAndCaps" : same(context, fromRegion, qUnion([part, qCapEntity(makeId("ext"), CapType.EITHER, EntityType.FACE)])),
        "partDependencies" : same(context, qDependency(part), qBodyType(qCreatedBy(makeId("sk"), EntityType.EDGE), BodyType.WIRE)),
        "sideDependency" : same(context, qDependency(side), line0),
        "sketchCurveHasNone" : count(context, qDependency(line0)),
        "laminarSources" : count(context, qLaminarDependency(sideEdges)),
        "laminarAreRegionEdges" : isQueryEmpty(context, qSubtraction(qLaminarDependency(sideEdges), qEdgeTopologyFilter(qOwnedByBody(qOwnerBody(qSketchRegion(makeId("sk"))), EntityType.EDGE), EdgeTopology.ONE_SIDED))),
        "sideMadeBy" : lastModifyingOperationId(context, side)[0]
    };`,
        {
            fromLine: 3,
            sideFace: true,
            sideEdges: true,
            fromRegion: 3,
            regionMadeBodyAndCaps: true,
            partDependencies: true,
            sideDependency: true,
            sketchCurveHasNone: 0,
            laminarSources: 1,
            laminarAreRegionEdges: true,
            sideMadeBy: "ext",
        },
    );

    onBothStds(
        "tracking through a merge needs partial dependency",
        `${box("a", 0, 40)} ${box("b", 20, 60)}
    const topA = qCoincidesWithPlane(qOwnedByBody(qCreatedBy(makeId("a"), EntityType.BODY), EntityType.FACE), ${horizontal(20)});
    const topB = qCoincidesWithPlane(qOwnedByBody(qCreatedBy(makeId("b"), EntityType.BODY), EntityType.FACE), ${horizontal(20)});
    const exclusive = startTracking(context, topA);
    const partial = startTracking(context, { "subquery" : topA, "trackPartialDependency" : true });
    const both = startTracking(context, { "subquery" : topA, "secondarySubquery" : topB });
    booleanBodies(context, makeId("union"), { "tools" : qUnion([qCreatedBy(makeId("a"), EntityType.BODY), qCreatedBy(makeId("b"), EntityType.BODY)]),
        "operationType" : BooleanOperationType.UNION });
    const mergedTop = qCoincidesWithPlane(qEverything(EntityType.FACE), ${horizontal(20)});
    return {
        "mergedTops" : count(context, mergedTop),
        "exclusive" : count(context, exclusive),
        "partial" : same(context, partial, mergedTop),
        "fromBoth" : same(context, both, mergedTop)
    };`,
        { mergedTops: 1, exclusive: 0, partial: true, fromBoth: true },
    );

    onBothStds(
        "pattern instances and their history",
        `${BOX}
    const tracked = startTracking(context, faces);
    opPattern(context, makeId("pat"), { "entities" : part,
        "transforms" : [transform(${at(50, 0, 0)}), transform(${at(100, 0, 0)})], "instanceNames" : ["one", "two"] });
    return {
        "oneBody" : same(context, qPatternInstances(makeId("pat"), "one", EntityType.BODY), qCreatedBy(makeId("pat") + "one", EntityType.BODY)),
        "bothFaces" : count(context, qPatternInstances(makeId("pat"), ["one", "two"], EntityType.FACE)),
        "unknownInstance" : count(context, qPatternInstances(makeId("pat"), "three", EntityType.BODY)),
        "copiesTracked" : same(context, tracked, qPatternInstances(makeId("pat"), ["one", "two"], EntityType.FACE)),
        "copyDependsOnSeed" : same(context, qDependency(qPatternInstances(makeId("pat"), "one", EntityType.BODY)), part),
        "matchingStaysInBody" : count(context, qMatching(top)),
        "uniqueVertices" : count(context, qUniqueVertices(qEverything(EntityType.VERTEX)))
    };`,
        {
            oneBody: true,
            bothFaces: 12,
            unknownInstance: 0,
            copiesTracked: true,
            copyDependsOnSeed: true,
            matchingStaysInBody: 2,
            uniqueVertices: 24,
        },
    );
});

describe("queries for things this context has none of", () => {
    onBothStds(
        "no composite parts, meshes, flat patterns or hole operations",
        `${BOX}
    return {
        "notConsumed" : same(context, qConsumed(part, Consumed.NO), part),
        "consumed" : count(context, qConsumed(part, Consumed.YES)),
        "tolerance" : count(context, qToleranceFilter(edges)),
        "sourceMesh" : count(context, qSourceMesh(vertices, EntityType.BODY)),
        "flat" : count(context, qCorrespondingInFlat(faces)),
        "attached" : count(context, qPartsAttachedTo(faces)),
        "holeProfile" : count(context, qOpHoleProfile(makeId("box"))),
        "holeFace" : count(context, qOpHoleFace(makeId("box")))
    };`,
        {
            notConsumed: true,
            consumed: 0,
            tolerance: 0,
            sourceMesh: 0,
            flat: 0,
            attached: 0,
            holeProfile: 0,
            holeFace: 0,
        },
    );
});

describe("query types std declares without a constructor (Onshape's std)", () => {
    const raw = (type: string, fields: string) => `({ "queryType" : QueryType.${type}, ${fields} } as Query)`;

    test("tangent steps, loops around faces, shells, historical and imprint queries", () => {
        const result = partStudio(
            "onshape",
            `${FILLETS}
    fCuboid(context, makeId("void"), { "corner1" : ${at(10, 10, 5)}, "corner2" : ${at(30, 20, 15)} });
    booleanBodies(context, makeId("hollow"), { "tools" : qCreatedBy(makeId("void"), EntityType.BODY), "targets" : part,
        "operationType" : BooleanOperationType.SUBTRACTION });
    ${polygon("sk", -10, [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
    ])}
    const cavityFloor = qCoincidesWithPlane(faces, ${horizontal(5)});
    return {
        "tangentEdges" : count(context, ${raw("TANGENT_EDGES", `"subquery" : bigArc`)}),
        "tangentFaces" : same(context, ${raw("TANGENT_FACES", `"subquery" : bigRound`)}, qAdjacent(qIntersection([smoothEdges, qAdjacent(bigRound, AdjacencyType.EDGE, EntityType.EDGE)]), AdjacencyType.EDGE, EntityType.FACE)),
        "loopAroundTop" : same(context, ${raw("LOOP_AROUND_FACE", `"subquery" : top`)}, qAdjacent(top, AdjacencyType.EDGE, EntityType.EDGE)),
        "outerShell" : count(context, ${raw("SHELL_CONTAINING_FACE", `"subquery" : top`)}),
        "innerShell" : same(context, ${raw("SHELL_CONTAINING_FACE", `"subquery" : cavityFloor`)}, qConcaveConnectedFaces(cavityFloor)),
        "historical" : same(context, ${raw("HISTORICAL", `"operationId" : makeId("box"), "entityType" : EntityType.BODY`)}, part),
        "imprintOfLine" : count(context, makeQuery(makeId("sk"), "IMPRINT", EntityType.EDGE, { "derivedFrom" : sketchEntityQuery(makeId("sk"), EntityType.EDGE, "l0") })),
        "smDefinition" : count(context, qSMDefinitionEntityFilter(faces, EntityType.FACE)),
        "smApplication" : count(context, qSMApplicationTypeFilter(faces, SMApplicationType.SHEET_METAL))
    };`,
        );
        expect(result).toEqual({
            tangentEdges: 3,
            tangentFaces: true,
            loopAroundTop: true,
            outerShell: 8,
            innerShell: true,
            historical: true,
            imprintOfLine: 1,
            smDefinition: 0,
            smApplication: 0,
        });
    });
});
