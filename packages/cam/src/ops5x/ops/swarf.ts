// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, Result } from "@chili3d/core";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../../model/operation";
import type { CamOperationData } from "../../model/setup";
import { toolRadius } from "../../model/tool";
import type { Vec3 } from "../../model/toolpath";
import { edgePolyline, FaceSampler, polylineLength, resamplePolyline, vec } from "../surface";
import {
    addScaled,
    angleBetween,
    cross,
    distance,
    dot,
    length,
    lerp,
    normalize,
    reject,
    rotateVector,
    sub,
    Z_AXIS,
} from "../vec";
import {
    COMMON_PARAMETERS,
    type CommonParams,
    ContactPlacer,
    type CutPoint,
    commonDefaults,
    finishToolpath,
    fiveAxisMachine,
    linkPasses,
    num,
    type Pass,
    readCommon,
    str,
} from "./common";

/**
 * Swarf (flank) milling of ruled walls: the side of the tool lies along each ruling line of
 * the picked faces, so one pass finishes the wall. Rulings join the wall's two rails — the
 * outer loop split at its two rising side edges — at equal arc-length fractions (lines of a
 * plane, generators of cylinders and cones, the straight sections of extrusions and lofts);
 * each ruling is checked to lie on the face. The tool axis runs along the ruling, the tip
 * sits at its bottom, offset one tool radius off the wall; levels repeat the pass higher up
 * the axis (top first). A drafted wall that leans over its floor would bury the tool's bottom
 * edge: `floorAvoidance` raises the tool along its axis, or tilts it upright (up to
 * `maxFloorTilt`) and raises the rest.
 */
export const SWARF_TYPE = "swarf5x";

export interface Ruling {
    readonly bottom: Vec3;
    readonly top: Vec3;
    /** Unit outward wall normal at the ruling's middle. */
    readonly normal: Vec3;
}

function chainPolylines(polylines: Vec3[][]): Vec3[][] {
    for (let i = 1; i < polylines.length; i++) {
        const end = polylines[i - 1][polylines[i - 1].length - 1];
        const line = polylines[i];
        // Closed polylines (full circles) keep their orientation: both ends touch.
        if (distance(line[0], end) > distance(line[line.length - 1], end) + 1e-9) line.reverse();
    }
    return polylines;
}

function concat(polylines: Vec3[][]): Vec3[] {
    const out: Vec3[] = [];
    for (const line of polylines) {
        for (const point of line) {
            if (out.length === 0 || distance(out[out.length - 1], point) > 1e-9) out.push(point);
        }
    }
    return out;
}

/**
 * `count + 1` points at equal arc length along a rail — edges `indices` of the loop, run like
 * their (chained) polylines: exact kernel abscissae for a one-edge rail, a fine polyline
 * resampled otherwise.
 */
function railPoints(
    edges: IEdge[],
    polylines: Vec3[][],
    indices: number[],
    count: number,
    step: number,
): Vec3[] {
    if (indices.length === 1 && edges[indices[0]].length() > 1e-9) {
        const index = indices[0];
        // The edge caches (and owns) its curve.
        const points = edges[index].curve.uniformAbscissaByCount(count).map(vec);
        const line = polylines[index];
        if (points.length === count + 1) {
            const flipped =
                distance(points[0], line[0]) > 1e-6 ||
                dot(sub(points[1], points[0]), sub(line[1], line[0])) < 0;
            return flipped ? points.reverse() : points;
        }
    }
    const fine = indices.map((index) => edgePolyline(edges[index], step / 8));
    const start = polylines[indices[0]][0];
    if (distance(fine[0][0], start) > distance(fine[0][fine[0].length - 1], start)) fine[0].reverse();
    return resamplePolyline(concat(chainPolylines(fine)), count);
}

/**
 * The rulings of a four-sided wall face, `step` apart along its rails and (when `maxAngle`
 * is set) close enough that neighbouring rulings turn by at most `maxAngle` degrees.
 */
export function wallRulings(face: IFace, step: number, tolerance: number, maxAngle = 0): Result<Ruling[]> {
    const edges = face.outerWire().edgeLoop();
    if (edges.length < 4) return Result.err("the face is not a four-sided wall");
    const polylines = chainPolylines(edges.map((edge) => edgePolyline(edge, step)));
    const rise = polylines.map((line) => {
        const chord = sub(line[line.length - 1], line[0]);
        const l = length(chord);
        return l < 1e-9 ? 0 : Math.abs(chord[2]) / l;
    });
    const n = polylines.length;
    const order = rise.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
    const first = order[0].index;
    const second = order.find(
        ({ index }) => index !== first && (index + 1) % n !== first && (first + 1) % n !== index,
    );
    if (second === undefined || second.value < 0.2) return Result.err("the face has no rising side edges");
    const [i1, i2] = [first, second.index].sort((a, b) => a - b);
    const indices = polylines.map((_, index) => index);
    const chainA = indices.slice(i1 + 1, i2);
    const chainB = [...indices.slice(i2 + 1), ...indices.slice(0, i1)];
    if (chainA.length === 0 || chainB.length === 0) return Result.err("the face's rails are missing");
    const railLength = (chain: number[]) =>
        chain.reduce((sum, index) => sum + polylineLength(polylines[index]), 0);
    let count = Math.max(1, Math.ceil(Math.max(railLength(chainA), railLength(chainB)) / step));
    const rails = (segments: number) => {
        // Rail A runs from side 1 to side 2; rail B the other way round the loop, so reverse it.
        const a = railPoints(edges, polylines, chainA, segments, step);
        const b = railPoints(edges, polylines, chainB, segments, step).reverse();
        const meanZ = (points: Vec3[]) => points.reduce((sum, point) => sum + point[2], 0) / points.length;
        return meanZ(a) <= meanZ(b) ? [a, b] : [b, a];
    };
    let [bottom, top] = rails(count);
    if (maxAngle > 0) {
        let turn = 0;
        for (let i = 1; i <= count; i++) {
            const before = sub(top[i - 1], bottom[i - 1]);
            turn = Math.max(turn, angleBetween(before, sub(top[i], bottom[i])));
        }
        if (turn > maxAngle) {
            count = Math.ceil((count * turn) / maxAngle);
            [bottom, top] = rails(count);
        }
    }
    const sampler = new FaceSampler(face);
    try {
        const rulings: Ruling[] = [];
        for (let i = 0; i <= count; i++) {
            let normal: Vec3 | undefined;
            for (const t of [0.25, 0.5, 0.75]) {
                const probe = lerp(bottom[i], top[i], t);
                const on = sampler.project(probe);
                if (on === undefined) return Result.err("the face's surface cannot be evaluated");
                const off = distance(on.point, probe);
                if (off > tolerance) {
                    return Result.err(
                        `the face is not ruled between its rails (${off.toFixed(3)} mm off the surface)`,
                    );
                }
                if (t === 0.5) normal = on.normal;
            }
            rulings.push({ bottom: bottom[i], top: top[i], normal: normal! });
        }
        return Result.ok(rulings);
    } finally {
        sampler.dispose();
    }
}

interface SwarfParams extends CommonParams {
    readonly levels: number;
    readonly stepdown: number;
    readonly bottomOffset: number;
    readonly climb: boolean;
    readonly floorAvoidance: "none" | "raise" | "tilt";
    readonly maxFloorTilt: number;
    readonly rulingTolerance: number;
}

/** How far the tool's bottom edge dips below the floor plane through `floor` (≤ 0: clear). */
function floorGouge(tip: Vec3, axis: Vec3, radius: number, floorZ: number): number {
    return floorZ - (tip[2] - radius * length(reject(Z_AXIS, axis)));
}

/** The tool position flanking one ruling. */
function flank(ruling: Ruling, params: SwarfParams, radius: number): CutPoint {
    const place = (axis: Vec3): CutPoint => {
        const away = normalize(reject(ruling.normal, axis));
        return {
            tip: addScaled(
                addScaled(ruling.bottom, away, radius + params.stockToLeave),
                axis,
                params.bottomOffset,
            ),
            axis,
        };
    };
    let point = place(normalize(sub(ruling.top, ruling.bottom)));
    const floorZ = ruling.bottom[2];
    if (params.floorAvoidance === "tilt") {
        const hinge = cross(point.axis, normalize(reject(ruling.normal, point.axis)));
        for (let angle = 0.5; angle <= params.maxFloorTilt + 1e-9; angle += 0.5) {
            if (floorGouge(point.tip, point.axis, radius, floorZ) <= params.tolerance) break;
            const candidates = [angle, -angle].map((signed) =>
                place(rotateVector(point.axis, hinge, signed)),
            );
            const upright = candidates.sort((p, q) => q.axis[2] - p.axis[2])[0];
            if (upright.axis[2] <= point.axis[2]) break;
            point = upright;
        }
    }
    if (params.floorAvoidance !== "none") {
        const gouge = floorGouge(point.tip, point.axis, radius, floorZ);
        if (gouge > params.tolerance && point.axis[2] > 1e-6) {
            point = { tip: addScaled(point.tip, point.axis, gouge / point.axis[2]), axis: point.axis };
        }
    }
    return point;
}

function readSwarf(operation: CamOperationData, context: CamOperationContext): SwarfParams {
    const params = operation.params;
    return {
        ...readCommon(operation, context),
        levels: Math.max(1, Math.trunc(num(params, "levels", 1))),
        stepdown: num(params, "stepdown", context.tool.cutting.stepdown ?? 5),
        bottomOffset: num(params, "bottomOffset", 0),
        climb: str(params, "direction", "climb") === "climb",
        floorAvoidance: str(params, "floorAvoidance", "none"),
        maxFloorTilt: num(params, "maxFloorTilt", 10),
        rulingTolerance: num(params, "rulingTolerance", 0.02),
    };
}

const SWARF_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "levels", label: "Levels", kind: "integer", min: 1 },
    { key: "stepdown", label: "Level step", kind: "length", min: 0 },
    { key: "bottomOffset", label: "Offset from the wall bottom", kind: "length" },
    {
        key: "direction",
        label: "Direction",
        kind: "enum",
        options: [
            { value: "climb", label: "Climb" },
            { value: "conventional", label: "Conventional" },
        ],
    },
    {
        key: "floorAvoidance",
        label: "Floor avoidance",
        kind: "enum",
        options: [
            { value: "none", label: "None" },
            { value: "raise", label: "Raise the tool" },
            { value: "tilt", label: "Tilt the tool" },
        ],
    },
    {
        key: "maxFloorTilt",
        label: "Maximum floor tilt",
        kind: "angle",
        min: 0,
        max: 45,
        visibleWhen: { key: "floorAvoidance", values: ["tilt"] },
    },
    { key: "rulingTolerance", label: "Ruling tolerance", kind: "length", min: 0 },
];

export const swarfHandler: CamOperationHandler = {
    type: SWARF_TYPE,
    label: "Swarf",
    category: "5axis",
    machineKinds: ["mill"],
    selects: ["face"],
    defaults: (_machine, tool) => ({
        ...commonDefaults(tool),
        levels: 1,
        stepdown: tool?.cutting.stepdown ?? 5,
        bottomOffset: 0,
        direction: "climb",
        floorAvoidance: "none",
        maxFloorTilt: 10,
        rulingTolerance: 0.02,
    }),
    parameters: () => [...SWARF_PARAMETERS, ...COMMON_PARAMETERS],
    generate(operation, context) {
        const machine = fiveAxisMachine(context);
        if (!machine.isOk) return Result.err(machine.error);
        const params = readSwarf(operation, context);
        const faces = context.selectedFaces();
        if (faces.length === 0) return Result.err(`${operation.name}: pick the walls to flank`);
        const radius = toolRadius(context.tool);
        const placer = new ContactPlacer(context, params);
        const passes: Pass[] = [];
        for (const [index, face] of faces.entries()) {
            const rulings = wallRulings(face, params.maxStep, params.rulingTolerance, params.maxAngleStep);
            if (!rulings.isOk) return Result.err(`${operation.name}: face ${index + 1}: ${rulings.error}`);
            let points = rulings.value.map((ruling) => flank(ruling, params, radius));
            const middle = Math.floor((points.length - 1) / 2);
            const travel = sub(points[middle + 1].tip, points[middle].tip);
            const away = normalize(reject(rulings.value[middle].normal, points[middle].axis));
            const climbDirection = cross(away, points[middle].axis);
            if (dot(travel, climbDirection) < 0 === params.climb) points = points.reverse();
            for (let level = params.levels - 1; level >= 0; level--) {
                const pass: CutPoint[] = [];
                for (const point of points) {
                    const lifted = {
                        tip: addScaled(point.tip, point.axis, level * params.stepdown),
                        axis: point.axis,
                    };
                    const checked = placer.check(lifted);
                    if (!checked.isOk) return Result.err(`${operation.name}: ${checked.error}`);
                    pass.push(lifted);
                }
                passes.push(pass);
            }
        }
        return finishToolpath(operation, context, linkPasses(passes, params), params, machine.value);
    },
};
