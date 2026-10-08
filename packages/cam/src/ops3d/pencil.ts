// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { type Point2, pointInLoops } from "../geometry2d";
import type { Cutter } from "../mesh/cutter";
import type { DropCutter } from "../mesh/dropCutter";
import { simplify3 } from "../mesh/polyline";
import { Yielder } from "../mesh/yielder";
import {
    type CamOperationContext,
    type CamOperationHandler,
    type CamParameterSpec,
    registerCamOperation,
} from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolpathData, Vec3 } from "../model/toolpath";
import { FEED_PARAMETERS, feedDefaults } from "../ops2d/common";
import {
    BOUNDARY_DEFAULTS,
    BOUNDARY_PARAMETERS,
    containmentRegion,
    cutPasses,
    LINK_PARAMETERS,
    linkOptions,
    MoveWriter,
    num,
    optionalNum,
    orderPasses,
    type Pass,
    STOCK_PARAMETERS,
    SURFACE_HEIGHT_PARAMETERS,
    surfacingSetup,
    surfacingToolpath,
    TOLERANCE_PARAMETER,
} from "./common";
import { clampHeights } from "./parallel";
import { gridSpacing } from "./waterline";

/**
 * Pencil finishing: one pass along every concave corner where the cutter touches two
 * surfaces at once (bitangency) — fillets tighter than the tool, creases, the foot of walls.
 *
 * Detection: the cutter is dropped on a grid, keeping each node's contact point and the
 * surface normal there (from the contact towards the cutter's corner-circle centre). Where
 * between neighbouring nodes the contact moves to another point and the normal turns by
 * more than the crease angle, the cutter rolled over a concave crease from one surface onto
 * the other; the crease is located on that grid edge by bisection on which side's contact a
 * probe touches, and the crease points are chained cell by cell into lines (marching-squares
 * style). Over a convex edge the contact stays on the edge, and on smooth convex surfaces
 * the normal turns slowly, so neither shows. Each line is cut on the cutter-location
 * surface (dropped between its points), so the pass is gouge free like any drop-cutter path.
 */
export const PENCIL_3D = "pencil3d";

const PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "creaseAngle",
        label: "Minimum crease angle",
        kind: "angle",
        min: 1,
        max: 179,
        description: "Corners whose surfaces turn by less than this are left alone",
    },
    { key: "sampling", label: "Detection grid spacing", kind: "length", min: 0.01 },
    TOLERANCE_PARAMETER,
    ...STOCK_PARAMETERS,
    ...BOUNDARY_PARAMETERS,
    ...SURFACE_HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
    ...LINK_PARAMETERS,
];

export const pencilFinishing: CamOperationHandler = {
    type: PENCIL_3D,
    label: "Pencil finishing",
    category: "3d",
    machineKinds: ["mill"],
    selects: ["face"],
    defaults(_machine, tool) {
        const diameter = tool?.diameter ?? 6;
        return {
            ...feedDefaults(tool),
            creaseAngle: 20,
            sampling: gridSpacing(diameter / 2),
            tolerance: 0.01,
            stockToLeave: 0,
            ...BOUNDARY_DEFAULTS,
            containment: "outside",
            clearance: 5,
            safeDistance: 1,
            holderCheck: true,
            linking: "stayDown",
            stayDownDistance: diameter,
            leadDistance: diameter / 4,
            leadAngle: 30,
        };
    },
    parameters: () => PARAMETERS,
    generate: generatePencil,
};

registerCamOperation(pencilFinishing);

export async function generatePencil(
    operation: CamOperationData,
    context: CamOperationContext,
): Promise<Result<ToolpathData>> {
    const setupResult = surfacingSetup(operation, context, { tolerance: 0.01, stockToLeave: 0 });
    if (!setupResult.isOk) return Result.err(setupResult.error);
    const setup = setupResult.value;
    const params = operation.params;
    const yielder = new Yielder(15, context.signal);
    const { cutter, drop, tolerance } = setup;
    const spacing = Math.max(num(params, "sampling", gridSpacing(cutter.radius)), 0.01);
    const angle = (Math.min(Math.max(num(params, "creaseAngle", 20), 1), 179) * Math.PI) / 180;
    const lines = await pencilLines(drop, spacing, angle, tolerance, yielder);
    const boundary = await containmentRegion(
        params,
        context,
        setup,
        { ...BOUNDARY_DEFAULTS, containment: "outside" },
        yielder,
    );
    const minZ = optionalNum(params, "minZ");
    const maxZ = optionalNum(params, "maxZ");

    const passes: Pass[] = [];
    for (const line of lines) {
        // On the surface between the crease points, inside the boundary and height range.
        const points: number[] = [];
        for (let k = 0; k + 1 < line.length; k++) {
            const piece = drop.dropPath(line[k][0], line[k][1], line[k + 1][0], line[k + 1][1], {
                sampling: spacing,
                tolerance: tolerance / 2,
            });
            points.push(...(k === 0 ? piece : piece.slice(3)));
        }
        let run: number[] = [];
        const flush = () => {
            for (const piece of clampHeights(run, minZ, maxZ)) {
                passes.push({ points: simplify3(piece, tolerance / 2), closed: false });
            }
            run = [];
        };
        for (let k = 0; k < points.length; k += 3) {
            if (boundary.length > 0 && !pointInLoops([points[k], points[k + 1]], boundary)) flush();
            else run.push(points[k], points[k + 1], points[k + 2]);
        }
        flush();
    }
    if (passes.length === 0) return Result.err("No concave corners for a pencil pass");

    const writer = new MoveWriter(setup.feeds, setup.clearanceZ, setup.safeDistance);
    writer.comment(`${operation.name}: pencil, ${passes.length} passes`);
    cutPasses(
        writer,
        setup,
        orderPasses(passes, undefined, true),
        linkOptions(params, cutter, spacing, tolerance, false),
    );
    return Result.ok(surfacingToolpath(operation, setup, writer.moves));
}

/**
 * The crease lines (XY polylines) where, between neighbouring nodes of a grid of `spacing`,
 * the cutter's contact moves to another surface turned by more than `creaseAngle` radians
 * (see the module note).
 */
export async function pencilLines(
    drop: DropCutter,
    spacing: number,
    creaseAngle: number,
    tolerance: number,
    yielder?: Yielder,
): Promise<Point2[][]> {
    const index = drop.index;
    if (index.count === 0) return [];
    const reach = drop.cutter.radius + 2 * spacing;
    const x0 = index.min[0] - reach;
    const y0 = index.min[1] - reach;
    const nx = Math.ceil((index.max[0] + reach - x0) / spacing) + 1;
    const ny = Math.ceil((index.max[1] + reach - y0) / spacing) + 1;
    const contacts = new Float64Array(nx * ny * 3);
    const normals = new Float64Array(nx * ny * 3);
    const contact = new Float64Array(3);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const x = x0 + i * spacing;
            const y = y0 + j * spacing;
            const tip = drop.dropContact(x, y, contact);
            contacts.set(contact, (j * nx + i) * 3);
            normals.set(contactNormal(drop.cutter, x, y, tip, contact), (j * nx + i) * 3);
        }
        await yielder?.tick();
    }
    const minimumCos = Math.cos(creaseAngle);
    const crease = (a: number, b: number) => {
        const moved = Math.hypot(
            contacts[a * 3] - contacts[b * 3],
            contacts[a * 3 + 1] - contacts[b * 3 + 1],
            contacts[a * 3 + 2] - contacts[b * 3 + 2],
        );
        const cos =
            normals[a * 3] * normals[b * 3] +
            normals[a * 3 + 1] * normals[b * 3 + 1] +
            normals[a * 3 + 2] * normals[b * 3 + 2];
        return moved > spacing / 2 && cos < minimumCos;
    };

    // Crease points on grid edges (horizontal edge ids first, then vertical).
    const horizontal = (nx - 1) * ny;
    const points = new Map<number, Point2>();
    const probe = new Float64Array(3);
    const contactAt = (x: number, y: number) => {
        drop.dropContact(x, y, probe);
        return probe;
    };
    const locate = (
        a: number,
        b: number,
        ax: number,
        ay: number,
        bx: number,
        by: number,
    ): Point2 | undefined => {
        const ca = contacts.slice(a * 3, a * 3 + 3);
        const cb = contacts.slice(b * 3, b * 3 + 3);
        let lo = 0;
        let hi = 1;
        const length = Math.hypot(bx - ax, by - ay);
        while ((hi - lo) * length > tolerance / 4) {
            const s = 0.5 * (lo + hi);
            const c = contactAt(ax + (bx - ax) * s, ay + (by - ay) * s);
            if (Number.isNaN(c[0])) return undefined;
            const da = Math.hypot(c[0] - ca[0], c[1] - ca[1], c[2] - ca[2]);
            const db = Math.hypot(c[0] - cb[0], c[1] - cb[1], c[2] - cb[2]);
            if (da <= db) lo = s;
            else hi = s;
        }
        // The end of the bracket where the cutter stands lower (the floor side of a wall foot).
        const xs = [ax + (bx - ax) * lo, ax + (bx - ax) * hi];
        const ys = [ay + (by - ay) * lo, ay + (by - ay) * hi];
        const low = drop.drop(xs[0], ys[0]) <= drop.drop(xs[1], ys[1]) ? 0 : 1;
        return [xs[low], ys[low]];
    };
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const a = j * nx + i;
            if (Number.isNaN(contacts[a * 3])) continue;
            const x = x0 + i * spacing;
            const y = y0 + j * spacing;
            if (i + 1 < nx && !Number.isNaN(contacts[(a + 1) * 3]) && crease(a, a + 1)) {
                const point = locate(a, a + 1, x, y, x + spacing, y);
                if (point) points.set(j * (nx - 1) + i, point);
            }
            if (j + 1 < ny && !Number.isNaN(contacts[(a + nx) * 3]) && crease(a, a + nx)) {
                const point = locate(a, a + nx, x, y, x, y + spacing);
                if (point) points.set(horizontal + j * nx + i, point);
            }
        }
        await yielder?.tick();
    }

    // Link the crease points of each cell: two make a segment, four pair up by distance.
    const links = new Map<number, number[]>();
    const connect = (p: number, q: number) => {
        links.set(p, [...(links.get(p) ?? []), q]);
        links.set(q, [...(links.get(q) ?? []), p]);
    };
    for (let j = 0; j + 1 < ny; j++) {
        for (let i = 0; i + 1 < nx; i++) {
            const edges = [
                j * (nx - 1) + i,
                horizontal + j * nx + i + 1,
                (j + 1) * (nx - 1) + i,
                horizontal + j * nx + i,
            ].filter((edge) => points.has(edge));
            if (edges.length === 2) connect(edges[0], edges[1]);
            else if (edges.length >= 3) {
                // Pair the closest two, then the rest.
                const pairs: [number, number, number][] = [];
                for (let p = 0; p < edges.length; p++) {
                    for (let q = p + 1; q < edges.length; q++) {
                        const [px, py] = points.get(edges[p]) ?? [0, 0];
                        const [qx, qy] = points.get(edges[q]) ?? [0, 0];
                        pairs.push([Math.hypot(px - qx, py - qy), edges[p], edges[q]]);
                    }
                }
                pairs.sort((u, v) => u[0] - v[0]);
                const used = new Set<number>();
                for (const [, p, q] of pairs) {
                    if (used.has(p) || used.has(q)) continue;
                    used.add(p);
                    used.add(q);
                    connect(p, q);
                }
            }
        }
    }

    // Walk the chains: from their ends first, then the closed ones.
    const visited = new Set<number>();
    const lines: Point2[][] = [];
    const walk = (start: number) => {
        const line: Point2[] = [];
        let previous = -1;
        let at: number | undefined = start;
        while (at !== undefined && !visited.has(at)) {
            visited.add(at);
            line.push(points.get(at) as Point2);
            const next: number | undefined = (links.get(at) ?? []).find(
                (edge) => edge !== previous && !visited.has(edge),
            );
            previous = at;
            at = next;
        }
        // A loop comes back round to its start.
        if (line.length > 2 && previous !== start && (links.get(previous) ?? []).includes(start)) {
            line.push(points.get(start) as Point2);
        }
        if (line.length >= 2) lines.push(line);
    };
    for (const edge of points.keys()) if ((links.get(edge) ?? []).length === 1) walk(edge);
    for (const edge of points.keys())
        if (!visited.has(edge) && (links.get(edge) ?? []).length > 0) walk(edge);
    return lines;
}

/**
 * The surface normal at a drop's contact: from the contact towards the centre of the cutter's
 * corner circle (straight up on the flat bottom, the cone's normal on a cone). A flat rim's
 * contact has no single normal; it reads as 45°.
 */
function contactNormal(cutter: Cutter, x: number, y: number, tip: number, contact: Float64Array): Vec3 {
    if (Number.isNaN(contact[0])) return [0, 0, 1];
    const dx = contact[0] - x;
    const dy = contact[1] - y;
    const d = Math.hypot(dx, dy);
    if (d <= cutter.flatRadius + 1e-9) return [0, 0, 1];
    const ux = dx / d;
    const uy = dy / d;
    if (cutter.cornerRadius > 0 && d <= cutter.arcEnd + 1e-9) {
        const vx = x + ux * cutter.flatRadius - contact[0];
        const vy = y + uy * cutter.flatRadius - contact[1];
        const vz = tip + cutter.cornerRadius - contact[2];
        const length = Math.hypot(vx, vy, vz) || 1;
        return [vx / length, vy / length, vz / length];
    }
    const k = Number.isFinite(cutter.coneSlope) ? cutter.coneSlope : 1;
    const length = Math.hypot(k, 1);
    return [(-ux * k) / length, (-uy * k) / length, 1 / length];
}
