// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, Result } from "@chili3d/core";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../../model/operation";
import type { CamOperationData } from "../../model/setup";
import type { Vec3 } from "../../model/toolpath";
import { edgeIsReversed, FaceSampler, type SurfacePoint, sampleRuns, vec } from "../surface";
import { leadTiltAxis } from "../toolContact";
import { DEG, distance, normalize, sub } from "../vec";
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
 * Multi-axis contour ("surface normal" machining): drive curves on the picked surfaces —
 * picked edges projected onto them, or a raster of lines in the WCS XY plane dropped onto
 * them from above — cut with the tool axis along the surface normal, leaned forward by the
 * lead angle and sideways by the tilt angle. Ball, bull nose and flat tools touch the surface
 * at the drive point (offset by the corner radius along the normal, plus stock to leave).
 */
export const CONTOUR_5X_TYPE = "multiaxisContour";

/** Lead/tilt/stock parameters of the surface strategies. */
export const ORIENTATION_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "lead", label: "Lead angle", kind: "angle", min: -89, max: 89 },
    { key: "tilt", label: "Tilt angle", kind: "angle", min: -89, max: 89 },
    { key: "zigzag", label: "Zigzag", kind: "boolean" },
];

/** Feed direction at each point of a pass (central differences). */
function feedDirections(points: readonly Vec3[]): Vec3[] {
    return points.map((_, i) => {
        const before = points[Math.max(0, i - 1)];
        const after = points[Math.min(points.length - 1, i + 1)];
        return normalize(sub(after, before), [1, 0, 0]);
    });
}

/** Contact passes → tool passes: lead/tilt axes, tips from contacts, collision tilt-away. */
export function surfacePasses(
    contacts: readonly (readonly SurfacePoint[])[],
    lead: number,
    tilt: number,
    placer: ContactPlacer,
): Result<Pass[]> {
    const passes: Pass[] = [];
    for (const pass of contacts) {
        if (pass.length < 2) continue;
        const feeds = feedDirections(pass.map((contact) => contact.point));
        const out: CutPoint[] = [];
        for (const [i, contact] of pass.entries()) {
            const axis = leadTiltAxis(contact.normal, feeds[i], lead, tilt);
            const placed = placer.place(contact.point, contact.normal, axis, feeds[i]);
            if (!placed.isOk) return Result.err(placed.error);
            out.push(placed.value);
        }
        passes.push(out);
    }
    return Result.ok(passes);
}

/** Reverses every other pass. */
export function zigzag<T>(passes: readonly (readonly T[])[], enabled: boolean): T[][] {
    return passes.map((pass, index) => (enabled && index % 2 === 1 ? [...pass].reverse() : [...pass]));
}

/** The nearest of the faces' surface points to `point`. */
function projectOnto(samplers: readonly FaceSampler[], point: Vec3): SurfacePoint | undefined {
    let best: { on: SurfacePoint; d: number } | undefined;
    for (const sampler of samplers) {
        const on = sampler.project(point);
        if (on === undefined) continue;
        const d = distance(on.point, point);
        if (best === undefined || d < best.d) best = { on, d };
    }
    return best?.on;
}

/** Top-down ray casting over the faces' triangulations (XY grid of triangles). */
class TopDownCaster {
    private readonly triangles: { face: number; a: Vec3; b: Vec3; c: Vec3 }[] = [];
    private readonly grid = new Map<string, number[]>();
    private readonly cell: number;

    constructor(samplers: readonly FaceSampler[], cell: number) {
        this.cell = Math.max(cell, 1e-3);
        samplers.forEach((sampler, face) => {
            const mesh = sampler.face.mesh.faces;
            if (mesh === undefined) return;
            const p = mesh.position;
            const vertex = (i: number): Vec3 => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
            for (let t = 0; t < mesh.index.length; t += 3) {
                const triangle = {
                    face,
                    a: vertex(mesh.index[t]),
                    b: vertex(mesh.index[t + 1]),
                    c: vertex(mesh.index[t + 2]),
                };
                const index = this.triangles.push(triangle) - 1;
                const xs = [triangle.a[0], triangle.b[0], triangle.c[0]];
                const ys = [triangle.a[1], triangle.b[1], triangle.c[1]];
                for (
                    let i = Math.floor(Math.min(...xs) / this.cell);
                    i <= Math.floor(Math.max(...xs) / this.cell);
                    i++
                ) {
                    for (
                        let j = Math.floor(Math.min(...ys) / this.cell);
                        j <= Math.floor(Math.max(...ys) / this.cell);
                        j++
                    ) {
                        const key = `${i},${j}`;
                        const list = this.grid.get(key);
                        if (list) list.push(index);
                        else this.grid.set(key, [index]);
                    }
                }
            }
        });
    }

    /** The highest triangle hit straight below (x, y): its face index and point. */
    cast(x: number, y: number): { face: number; point: Vec3 } | undefined {
        let best: { face: number; point: Vec3 } | undefined;
        for (const index of this.grid.get(`${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`) ??
            []) {
            const { face, a, b, c } = this.triangles[index];
            const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
            if (Math.abs(d) < 1e-14) continue;
            const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
            const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            const z = l1 * a[2] + l2 * b[2] + l3 * c[2];
            if (best === undefined || z > best.point[2]) best = { face, point: [x, y, z] };
        }
        return best;
    }
}

function rasterContacts(samplers: readonly FaceSampler[], params: ContourParams): SurfacePoint[][] {
    const angle = params.rasterAngle * DEG;
    const along: Vec3 = [Math.cos(angle), Math.sin(angle), 0];
    const across: Vec3 = [-Math.sin(angle), Math.cos(angle), 0];
    let a0 = Infinity;
    let a1 = -Infinity;
    let s0 = Infinity;
    let s1 = -Infinity;
    for (const sampler of samplers) {
        const box = sampler.face.boundingBox();
        for (const x of [box.min.x, box.max.x]) {
            for (const y of [box.min.y, box.max.y]) {
                const a = x * along[0] + y * along[1];
                const s = x * across[0] + y * across[1];
                a0 = Math.min(a0, a);
                a1 = Math.max(a1, a);
                s0 = Math.min(s0, s);
                s1 = Math.max(s1, s);
            }
        }
    }
    const caster = new TopDownCaster(samplers, Math.max(params.stepover, params.maxStep) * 2);
    const lines = Math.max(1, Math.ceil((s1 - s0) / params.stepover));
    const steps = Math.max(1, Math.ceil((a1 - a0) / params.maxStep));
    const passes: SurfacePoint[][] = [];
    for (let k = 0; k <= lines; k++) {
        const s = s0 + ((s1 - s0) * k) / lines;
        const drop = (a: number): SurfacePoint | undefined => {
            const hit = caster.cast(a * along[0] + s * across[0], a * along[1] + s * across[1]);
            const on = hit && samplers[hit.face].intersectLine(hit.point, [0, 0, -1]);
            return on !== undefined && on.normal[2] > 1e-3 ? on : undefined;
        };
        passes.push(...sampleRuns(a0, a1, steps, drop, params.tolerance));
    }
    return passes;
}

/** Contact passes along picked edges, projected onto the faces (chords within the tolerance). */
function edgeContacts(
    samplers: readonly FaceSampler[],
    edges: readonly IEdge[],
    params: ContourParams,
): SurfacePoint[][] {
    return edges.flatMap((edge) => {
        const count = Math.max(1, Math.ceil(edge.length() / params.maxStep));
        const onFaces = (t: number) => projectOnto(samplers, vec(edge.pointAt(t)));
        const runs = sampleRuns(
            edge.firstParameter(),
            edge.lastParameter(),
            count,
            onFaces,
            params.tolerance,
        );
        return edgeIsReversed(edge) ? runs.reverse().map((run) => run.reverse()) : runs;
    });
}

interface ContourParams extends CommonParams {
    readonly drive: "edges" | "raster";
    readonly rasterAngle: number;
    readonly stepover: number;
    readonly zigzag: boolean;
    readonly lead: number;
    readonly tilt: number;
}

function readContour(operation: CamOperationData, context: CamOperationContext): ContourParams {
    const params = operation.params;
    return {
        ...readCommon(operation, context),
        drive: str(params, "drive", "raster"),
        rasterAngle: num(params, "rasterAngle", 0),
        stepover: Math.max(
            1e-3,
            num(params, "stepover", context.tool.cutting.stepover ?? context.tool.diameter / 4),
        ),
        zigzag: params["zigzag"] !== false,
        lead: num(params, "lead", 0),
        tilt: num(params, "tilt", 0),
    };
}

export const contourHandler: CamOperationHandler = {
    type: CONTOUR_5X_TYPE,
    label: "Multi-axis contour",
    category: "5axis",
    machineKinds: ["mill"],
    selects: ["face", "edge"],
    defaults: (_machine, tool) => ({
        ...commonDefaults(tool),
        drive: "raster",
        rasterAngle: 0,
        stepover: tool?.cutting.stepover ?? (tool ? tool.diameter / 4 : 1),
        zigzag: true,
        lead: 0,
        tilt: 0,
    }),
    parameters: () => [
        {
            key: "drive",
            label: "Drive",
            kind: "enum",
            options: [
                { value: "raster", label: "Projected raster" },
                { value: "edges", label: "Picked edges" },
            ],
        },
        {
            key: "rasterAngle",
            label: "Raster angle",
            kind: "angle",
            visibleWhen: { key: "drive", values: ["raster"] },
        },
        {
            key: "stepover",
            label: "Stepover",
            kind: "length",
            min: 0,
            visibleWhen: { key: "drive", values: ["raster"] },
        },
        ...ORIENTATION_PARAMETERS,
        ...COMMON_PARAMETERS,
    ],
    generate(operation, context) {
        const machine = fiveAxisMachine(context);
        if (!machine.isOk) return Result.err(machine.error);
        const params = readContour(operation, context);
        const faces = context.selectedFaces();
        if (faces.length === 0) return Result.err(`${operation.name}: pick the surfaces to machine`);
        const samplers = faces.map((face) => new FaceSampler(face));
        try {
            let contacts: SurfacePoint[][];
            if (params.drive === "edges") {
                const edges = context.selectedEdges();
                if (edges.length === 0) return Result.err(`${operation.name}: pick the drive edges`);
                contacts = edgeContacts(samplers, edges, params);
            } else {
                contacts = rasterContacts(samplers, params);
            }
            const placer = new ContactPlacer(context, params);
            const passes = surfacePasses(zigzag(contacts, params.zigzag), params.lead, params.tilt, placer);
            if (!passes.isOk) return Result.err(`${operation.name}: ${passes.error}`);
            return finishToolpath(
                operation,
                context,
                linkPasses(passes.value, params),
                params,
                machine.value,
            );
        } finally {
            for (const sampler of samplers) sampler.dispose();
        }
    },
};
