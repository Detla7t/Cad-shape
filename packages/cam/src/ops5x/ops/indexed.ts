// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, Matrix4, Result } from "@chili3d/core";
import type { MachineProfileData } from "../../model/machine";
import {
    type CamLoop,
    type CamMesh,
    type CamOperationContext,
    type CamOperationHandler,
    type CamParameterSpec,
    camOperation,
    camOperations,
} from "../../model/operation";
import type { CamOperationData, SetupData } from "../../model/setup";
import type { ToolData } from "../../model/tool";
import type { ToolpathData, Vec3 } from "../../model/toolpath";
import type { FiveAxisKinematics } from "../kinematics";
import { frameToWcs, mapFrameMoves, wcsToFrame } from "../moves";
import { FaceSampler } from "../surface";
import {
    column,
    cross,
    frameFromZ,
    type Mat3,
    mulMV,
    normalize,
    rotateVector,
    X_AXIS,
    Y_AXIS,
    Z_AXIS,
} from "../vec";
import { fiveAxisMachine, num, str } from "./common";

/**
 * 3+2 indexed machining: tilt the tool to a work plane — a picked planar face's normal or
 * explicit rotary angles — and run any 2.5D/3D operation there. The wrapped operation sees a
 * context whose WCS is rotated so +Z is the plane normal (parts, faces, mesh, stock and loops
 * all moved into it), and its moves come back to the setup's WCS with that fixed tool axis.
 * Posts recognise the constant axis and write a tilted plane (G68.2, CYCLE800, PLANE SPATIAL,
 * DWO) or positioned rotaries.
 */
export const INDEXED_TYPE = "indexed3plus2";

const INNER_PREFIX = "inner.";

/** The wrapped operation's own parameters: `innerParams`, overridden by flat `inner.<key>` entries. */
export function innerParams(operation: CamOperationData): Record<string, unknown> {
    const nested = operation.params["innerParams"];
    const out: Record<string, unknown> = nested !== null && typeof nested === "object" ? { ...nested } : {};
    for (const [key, value] of Object.entries(operation.params)) {
        if (key.startsWith(INNER_PREFIX)) out[key.slice(INNER_PREFIX.length)] = value;
    }
    return out;
}

/** WCS → tilted frame as a kernel matrix (column-major): p' = Fᵀ·(p − o). */
export function frameMatrix(frame: Mat3, origin: Vec3): Matrix4 {
    const t = wcsToFrame(frame, origin, [0, 0, 0]);
    return Matrix4.fromArray([
        frame[0][0],
        frame[0][1],
        frame[0][2],
        0,
        frame[1][0],
        frame[1][1],
        frame[1][2],
        0,
        frame[2][0],
        frame[2][1],
        frame[2][2],
        0,
        t[0],
        t[1],
        t[2],
        1,
    ]);
}

/** The context an operation sees in a tilted frame (columns of `frame` in WCS, at `origin`). */
export function tiltedContext(context: CamOperationContext, frame: Mat3, origin: Vec3): CamOperationContext {
    const matrix = frameMatrix(frame, origin);
    const toFrame = (point: Vec3) => wcsToFrame(frame, origin, point);
    const corners: Vec3[] = [];
    for (const x of [context.stock.min[0], context.stock.max[0]]) {
        for (const y of [context.stock.min[1], context.stock.max[1]]) {
            for (const z of [context.stock.min[2], context.stock.max[2]]) corners.push(toFrame([x, y, z]));
        }
    }
    const min = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))) as unknown as Vec3;
    const max = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k]))) as unknown as Vec3;
    const wcs = context.setup.wcs;
    const wcsRotation: Mat3 = [
        [wcs.xAxis[0], cross(wcs.zAxis, wcs.xAxis)[0], wcs.zAxis[0]],
        [wcs.xAxis[1], cross(wcs.zAxis, wcs.xAxis)[1], wcs.zAxis[1]],
        [wcs.xAxis[2], cross(wcs.zAxis, wcs.xAxis)[2], wcs.zAxis[2]],
    ];
    const setup: SetupData = {
        ...context.setup,
        wcs: {
            origin: frameToWcs(wcsRotation, wcs.origin, origin),
            xAxis: mulMV(wcsRotation, column(frame, 0)),
            zAxis: mulMV(wcsRotation, column(frame, 2)),
        },
    };
    let parts: readonly IShape[] | undefined;
    const meshes = new Map<number | undefined, CamMesh>();
    return {
        document: context.document,
        signal: context.signal,
        setup,
        machine: context.machine,
        tool: context.tool,
        get parts() {
            parts ??= context.parts.map((part) => part.transformedMul(matrix));
            return parts;
        },
        stock: { min, max },
        partMesh(linearDeflection) {
            let mesh = meshes.get(linearDeflection);
            if (mesh === undefined) {
                const source = context.partMesh(linearDeflection);
                const positions = new Float32Array(source.positions.length);
                for (let i = 0; i < positions.length; i += 3) {
                    positions.set(
                        toFrame([source.positions[i], source.positions[i + 1], source.positions[i + 2]]),
                        i,
                    );
                }
                mesh = { positions, indices: source.indices };
                meshes.set(linearDeflection, mesh);
            }
            return mesh;
        },
        selectedFaces: () => context.selectedFaces().map((face) => face.transformedMul(matrix) as IFace),
        selectedEdges: () => context.selectedEdges().map((edge) => edge.transformedMul(matrix) as IEdge),
        selectedLoops: () =>
            context.selectedLoops().map((loop): CamLoop => {
                const points = loop.points.map((point) => toFrame([point[0], point[1], loop.z ?? 0]));
                const z = points.reduce((sum, point) => sum + point[2], 0) / Math.max(1, points.length);
                return { ...loop, points: points.map((point) => [point[0], point[1]] as const), z };
            }),
    };
}

/** Tool axis for explicit rotary angles: through the machine's kinematics, else A/B/C about X/Y/Z. */
export function rotaryAxisOf(
    kinematics: FiveAxisKinematics | undefined,
    angles: { A: number; B: number; C: number },
): Vec3 {
    if (kinematics !== undefined) {
        return kinematics.toolAxis(kinematics.joints.map((joint) => angles[joint.name]));
    }
    let axis = rotateVector(Z_AXIS, X_AXIS, angles.A);
    axis = rotateVector(axis, Y_AXIS, angles.B);
    return rotateVector(axis, Z_AXIS, angles.C);
}

interface WorkPlane {
    readonly frame: Mat3;
    readonly origin: Vec3;
}

function workPlane(
    operation: CamOperationData,
    context: CamOperationContext,
    kinematics: FiveAxisKinematics | undefined,
): Result<WorkPlane> {
    const params = operation.params;
    if (str<"face" | "rotary">(params, "orientation", "face") === "rotary") {
        const axis = rotaryAxisOf(kinematics, {
            A: num(params, "A", 0),
            B: num(params, "B", 0),
            C: num(params, "C", 0),
        });
        return Result.ok({ frame: frameFromZ(axis), origin: [0, 0, 0] });
    }
    const faces = context.selectedFaces();
    const index = Math.trunc(num(params, "faceIndex", 0));
    const face = faces[index];
    if (face === undefined) return Result.err("Pick a planar face for the work plane");
    const sampler = new FaceSampler(face);
    try {
        if (!sampler.surface.isPlanar()) return Result.err("The work plane face is not planar");
        const bounds = sampler.uvBounds();
        if (!bounds.isOk) return Result.err(bounds.error);
        const { u1, u2, v1, v2 } = bounds.value;
        const center = sampler.at((u1 + u2) / 2, (v1 + v2) / 2);
        const origin: Vec3 =
            str<"wcs" | "face">(params, "origin", "wcs") === "face" ? center.point : [0, 0, 0];
        return Result.ok({ frame: frameFromZ(normalize(center.normal)), origin });
    } finally {
        sampler.dispose();
    }
}

function innerOperationOf(
    operation: CamOperationData,
    inner: CamOperationHandler,
    machine: MachineProfileData,
    tool: ToolData,
) {
    return {
        ...operation,
        type: inner.type,
        params: { ...inner.defaults(machine, tool), ...innerParams(operation) },
    };
}

function mapInner(
    result: Result<ToolpathData>,
    plane: WorkPlane,
    operation: CamOperationData,
): Result<ToolpathData> {
    if (!result.isOk) return Result.err(`${operation.name}: ${result.error}`);
    const tolerance = Math.max(1e-4, num(operation.params, "arcTolerance", 0.005));
    const moves = mapFrameMoves(result.value.moves, plane.frame, plane.origin, tolerance);
    if (!moves.isOk) return Result.err(`${operation.name}: ${moves.error}`);
    return Result.ok({ ...result.value, moves: moves.value, label: result.value.label ?? operation.name });
}

export const indexedHandler: CamOperationHandler = {
    type: INDEXED_TYPE,
    label: "3+2 indexed",
    category: "5axis",
    machineKinds: ["mill"],
    selects: ["face", "edge", "sketch", "body"],
    defaults: () => ({
        innerType: "",
        innerParams: {},
        orientation: "face",
        faceIndex: 0,
        origin: "wcs",
        A: 0,
        B: 0,
        C: 0,
        arcTolerance: 0.005,
    }),
    parameters(operation: CamOperationData): readonly CamParameterSpec[] {
        const innerOptions = camOperations("mill")
            .filter((handler) => handler.category !== "5axis")
            .map((handler) => ({ value: handler.type, label: handler.label }));
        const own: CamParameterSpec[] = [
            { key: "innerType", label: "Operation", kind: "enum", options: innerOptions },
            {
                key: "orientation",
                label: "Work plane from",
                kind: "enum",
                options: [
                    { value: "face", label: "Planar face" },
                    { value: "rotary", label: "Rotary angles" },
                ],
            },
            {
                key: "faceIndex",
                label: "Plane face (pick order)",
                kind: "integer",
                min: 0,
                visibleWhen: { key: "orientation", values: ["face"] },
            },
            {
                key: "origin",
                label: "Plane origin",
                kind: "enum",
                options: [
                    { value: "wcs", label: "WCS origin" },
                    { value: "face", label: "Face centre" },
                ],
                visibleWhen: { key: "orientation", values: ["face"] },
            },
            ...(["A", "B", "C"] as const).map(
                (key): CamParameterSpec => ({
                    key,
                    label: key,
                    kind: "angle",
                    visibleWhen: { key: "orientation", values: ["rotary"] },
                }),
            ),
            { key: "arcTolerance", label: "Arc tolerance", kind: "length", min: 0 },
        ];
        const inner = camOperation(str(operation.params, "innerType", ""));
        if (inner === undefined || inner.category === "5axis") return own;
        const innerOperation = { ...operation, type: inner.type, params: innerParams(operation) };
        return [
            ...own,
            ...inner.parameters(innerOperation).map(
                (spec): CamParameterSpec => ({
                    ...spec,
                    key: `${INNER_PREFIX}${spec.key}`,
                    label: `${inner.label}: ${spec.label}`,
                    visibleWhen: spec.visibleWhen && {
                        key: `${INNER_PREFIX}${spec.visibleWhen.key}`,
                        values: spec.visibleWhen.values,
                    },
                }),
            ),
        ];
    },
    generate(operation, context) {
        const machine = fiveAxisMachine(context);
        if (!machine.isOk) return Result.err(machine.error);
        const type = str(operation.params, "innerType", "");
        const inner = camOperation(type);
        if (inner === undefined)
            return Result.err(`${operation.name}: choose the operation to run on the plane`);
        if (inner.category === "5axis")
            return Result.err(`${operation.name}: "${inner.label}" cannot be indexed`);
        const plane = workPlane(operation, context, machine.value);
        if (!plane.isOk) return Result.err(`${operation.name}: ${plane.error}`);
        const axis = column(plane.value.frame, 2);
        if (machine.value !== undefined) {
            const reach = machine.value.inverse(axis);
            if (!reach.isOk) return Result.err(`${operation.name}: ${reach.error}`);
        }
        const tilted = tiltedContext(context, plane.value.frame, plane.value.origin);
        const result = inner.generate(
            innerOperationOf(operation, inner, context.machine, context.tool),
            tilted,
        );
        return result instanceof Promise
            ? result.then((value) => mapInner(value, plane.value, operation))
            : mapInner(result, plane.value, operation);
    },
};
