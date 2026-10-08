// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { curvePoles, evaluateBezier, type UV } from "./curveGeometry";
import {
    arcAngles,
    ConstraintKind,
    type SketchConstraintData,
    type SketchData,
    type SketchEntityData,
} from "./sketchModel";

const TAU = Math.PI * 2,
    EPS = 1e-8;
export const distance = (a: UV, b: UV) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function appendEntity(
    data: SketchData,
    type: SketchEntityData["type"],
    params: number[],
    style: Partial<SketchEntityData> = {},
): number {
    const id = Math.max(data.entityIdSeq ?? 1, ...data.entities.map((e) => e.id + 1));
    data.entityIdSeq = id + 1;
    data.entities.push({ ...style, id, type, params });
    if (type === "arc") ensureArcConstraint(data, id);
    return id;
}
export function circleData(e: SketchEntityData): { c: UV; r: number } {
    return {
        c: [e.params[0], e.params[1]],
        r:
            e.type === "circle"
                ? e.params[2]
                : Math.hypot(e.params[2] - e.params[0], e.params[3] - e.params[1]),
    };
}
export function parameterAt(e: SketchEntityData, p: UV): number {
    const a = e.params;
    if (e.type === "line") {
        const dx = a[2] - a[0],
            dy = a[3] - a[1];
        return ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
    }
    const [start, sweep] = e.type === "circle" ? [0, TAU] : arcAngles(a);
    return ((Math.atan2(p[1] - a[1], p[0] - a[0]) - start + TAU) % TAU) / sweep;
}
export function pointAt(e: SketchEntityData, t: number): UV {
    const p = e.params;
    if (e.type === "line") return [p[0] + (p[2] - p[0]) * t, p[1] + (p[3] - p[1]) * t];
    const { c, r } = circleData(e),
        [s, w] = e.type === "circle" ? [0, TAU] : arcAngles(p);
    return [c[0] + r * Math.cos(s + w * t), c[1] + r * Math.sin(s + w * t)];
}
/** Exact intersections of lines and circular curves, clipped to their finite domains. */
export function intersections(
    a: SketchEntityData,
    b: SketchEntityData,
    extendA = false,
    extendB = false,
): UV[] {
    if (!["line", "circle", "arc"].includes(a.type) || !["line", "circle", "arc"].includes(b.type)) return [];
    let points: UV[] = [];
    if (a.type === "line" && b.type === "line") {
        const p = a.params,
            q = b.params,
            dx = p[2] - p[0],
            dy = p[3] - p[1],
            ex = q[2] - q[0],
            ey = q[3] - q[1],
            cross = dx * ey - dy * ex;
        if (Math.abs(cross) > EPS) {
            const t = ((q[0] - p[0]) * ey - (q[1] - p[1]) * ex) / cross;
            points = [pointAt(a, t)];
        }
    } else if (a.type === "line" || b.type === "line") {
        const line = a.type === "line" ? a : b,
            circle = a.type === "line" ? b : a,
            p = line.params,
            { c, r } = circleData(circle);
        const dx = p[2] - p[0],
            dy = p[3] - p[1],
            ux = p[0] - c[0],
            uy = p[1] - c[1],
            aa = dx * dx + dy * dy,
            bb = 2 * (ux * dx + uy * dy),
            cc = ux * ux + uy * uy - r * r,
            disc = bb * bb - 4 * aa * cc;
        if (disc >= -EPS && aa > EPS)
            points = [
                (-bb - Math.sqrt(Math.max(0, disc))) / (2 * aa),
                (-bb + Math.sqrt(Math.max(0, disc))) / (2 * aa),
            ].map((t) => pointAt(line, t));
    } else {
        const x = circleData(a),
            y = circleData(b),
            d = distance(x.c, y.c);
        if (d > EPS && d <= x.r + y.r + EPS && d >= Math.abs(x.r - y.r) - EPS) {
            const k = (x.r * x.r - y.r * y.r + d * d) / (2 * d),
                h = Math.sqrt(Math.max(0, x.r * x.r - k * k)),
                u = (y.c[0] - x.c[0]) / d,
                v = (y.c[1] - x.c[1]) / d;
            points = [
                [x.c[0] + k * u - h * v, x.c[1] + k * v + h * u],
                [x.c[0] + k * u + h * v, x.c[1] + k * v - h * u],
            ];
        }
    }
    const inside = (e: SketchEntityData, p: UV) =>
        e.type === "circle" || (parameterAt(e, p) >= -EPS && parameterAt(e, p) <= 1 + EPS);
    return points.filter((p) => (extendA || inside(a, p)) && (extendB || inside(b, p)));
}
function piece(e: SketchEntityData, a: number, b: number): Pick<SketchEntityData, "type" | "params"> {
    if (e.type === "line") return { type: "line", params: [...pointAt(e, a), ...pointAt(e, b)] };
    return { type: "arc", params: [...e.params.slice(0, 2), ...pointAt(e, a), ...pointAt(e, b)] };
}
/** The interval removed by trim, shared by the hover preview and the actual edit. */
export function trimInterval(data: SketchData, entity: SketchEntityData, pick: UV): [number, number] {
    const cuts = curveCuts(data, entity),
        t = parameterAt(entity, pick);
    if (entity.type === "circle") {
        if (cuts.length < 2) return [0, 1];
        return [
            cuts.findLast((x) => x < t - EPS) ?? cuts[cuts.length - 1] - 1,
            cuts.find((x) => x > t + EPS) ?? cuts[0] + 1,
        ];
    }
    return [cuts.findLast((x) => x < t - EPS) ?? 0, cuts.find((x) => x > t + EPS) ?? 1];
}
function curveCuts(data: SketchData, e: SketchEntityData, extend = false): number[] {
    const boundaries = [
        ...data.entities,
        ...(data.externalRefs ?? []).map((r) => ({ id: r.entityId, type: r.type, params: r.snapshot })),
    ];
    const sorted = boundaries
        .filter((x) => x.id !== e.id)
        .flatMap((x) => intersections(e, x, extend).map((p) => parameterAt(e, p)))
        .sort((a, b) => a - b);
    return sorted.filter((t, i) => i === 0 || Math.abs(t - sorted[i - 1]) > EPS);
}
export function trimPreview(data: SketchData, id: number, pick: UV): SketchEntityData | undefined {
    const entity = data.entities.find((e) => e.id === id);
    if (!entity || !["line", "circle", "arc"].includes(entity.type)) return undefined;
    const [a, b] = trimInterval(data, entity, pick);
    if (entity.type === "circle" && b - a >= 1 - EPS) return structuredClone(entity);
    return { ...entity, ...piece(entity, a, b) };
}
/** Replaces the picked interval; unrelated entity ids and constraints remain stable. */
export function trimOrSplit(
    data: SketchData,
    id: number,
    pick: UV,
    mode: "trim" | "split" | "extend",
    secondPick?: UV,
): void {
    const e = data.entities.find((e) => e.id === id);
    if (!e) return;
    if (mode === "split" && e.type === "bezier") {
        splitBezier(data, e, pick);
        return;
    }
    if (!["line", "circle", "arc"].includes(e.type))
        throw new Error("Trim and extend currently support lines, circles and arcs.");
    const t = parameterAt(e, pick);
    const cuts = curveCuts(data, e, mode === "extend");
    let intervals: [number, number][] = [];
    if (mode === "split") {
        if (e.type === "circle") {
            if (!secondPick) throw new Error("Choose two points on the circle to split it.");
            let u = parameterAt(e, secondPick);
            if (Math.abs(u - t) < EPS) throw new Error("Choose two distinct split points.");
            if (u < t) u += 1;
            intervals = [
                [t, u],
                [u, t + 1],
            ];
        } else {
            if (t <= EPS || t >= 1 - EPS) return;
            intervals = [
                [0, t],
                [t, 1],
            ];
        }
    } else if (mode === "extend") {
        if (e.type !== "line") throw new Error("Select a line to extend.");
        const candidates = cuts.filter((x) => (t < 0.5 ? x < -EPS : x > 1 + EPS));
        if (!candidates.length) throw new Error("No boundary found to extend this end to.");
        intervals = [t < 0.5 ? [Math.max(...candidates), 1] : [0, Math.min(...candidates)]];
    } else {
        const [left, right] = trimInterval(data, e, pick);
        if (e.type === "circle") {
            if (right - left < 1 - EPS) intervals = [[right, left + 1]];
        } else {
            if (left > EPS) intervals.push([0, left]);
            if (right < 1 - EPS) intervals.push([right, 1]);
        }
    }
    const originalConstraints = data.constraints.filter((c) => c.refs.some((r) => r.entityId === id));
    const oldMax = Math.max(0, ...data.constraints.map((c) => c.id));
    data.constraints = data.constraints.filter((c) => !c.refs.some((r) => r.entityId === id));
    data.entities = data.entities.filter((x) => x.id !== id);
    const parts: { entity: SketchEntityData; start: number; end: number }[] = [];
    intervals.forEach(([a, b], i) => {
        if (b - a <= EPS) return;
        const part = piece(e, a, b),
            partId = i === 0 ? id : appendEntity(data, part.type, part.params, e);
        if (i === 0) data.entities.push({ ...e, ...part });
        const entity = data.entities.find((x) => x.id === partId)!;
        parts.push({ entity, start: a, end: b });
    });
    data.constraints = data.constraints.filter(
        (c) =>
            !parts.some(
                (p) =>
                    p.entity.type === "arc" &&
                    c.kind === ConstraintKind.PointOnArc &&
                    c.refs.every((r) => r.entityId === p.entity.id),
            ),
    );
    // Restore constraints on surviving endpoints and circle centers. Cutting a line
    // removes its old length dimension, while its orientation and end attachments survive.
    const directionKinds = [
        ConstraintKind.Horizontal,
        ConstraintKind.Vertical,
        ConstraintKind.Parallel,
        ConstraintKind.Perpendicular,
        ConstraintKind.Angle,
    ];
    const mapPoint = (index: number) => {
        if (e.type !== "line" && index === 0 && parts.length)
            return { entityId: parts[0].entity.id, pointIndex: 0 };
        const t = e.type === "line" ? index : index - 1;
        for (const part of parts) {
            if (Math.abs(part.start - t) < EPS)
                return { entityId: part.entity.id, pointIndex: e.type === "line" ? 0 : 1 };
            if (Math.abs(part.end - t) < EPS)
                return { entityId: part.entity.id, pointIndex: e.type === "line" ? 1 : 2 };
        }
        return undefined;
    };
    let nextId = Math.max(oldMax, ...data.constraints.map((c) => c.id)) + 1;
    for (const constraint of originalConstraints) {
        if (directionKinds.includes(constraint.kind) && e.type === "line") {
            parts.forEach((part, i) => {
                data.constraints.push({
                    ...structuredClone(constraint),
                    id: i === 0 ? constraint.id : nextId++,
                    refs: constraint.refs.map((r) =>
                        r.entityId === id ? { ...r, entityId: part.entity.id } : r,
                    ),
                });
            });
            continue;
        }
        if (constraint.kind === ConstraintKind.PointOnArc && constraint.refs.every((r) => r.entityId === id))
            continue;
        if (constraint.kind === ConstraintKind.P2PDistance && constraint.refs.every((r) => r.entityId === id))
            continue;
        const refs = constraint.refs.map((r) => (r.entityId === id ? mapPoint(r.pointIndex) : r));
        if (refs.every((r) => r !== undefined))
            data.constraints.push({ ...structuredClone(constraint), refs });
    }
    // Structural constraints are generated after restored ids, preventing collisions.
    for (const part of parts) if (part.entity.type === "arc") ensureArcConstraint(data, part.entity.id);
    if (mode === "split" && parts.length === 2) {
        const first = parts[0].entity,
            second = parts[1].entity;
        data.constraints.push({
            id: Math.max(0, ...data.constraints.map((c) => c.id)) + 1,
            kind: ConstraintKind.P2PCoincident,
            refs: [
                { entityId: first.id, pointIndex: first.type === "line" ? 1 : 2 },
                { entityId: second.id, pointIndex: second.type === "line" ? 0 : 1 },
            ],
        });
    }
    if (mode === "split" && e.type === "circle" && parts.length === 2) {
        const [a, b] = parts.map((p) => p.entity.id);
        for (const [ap, bp] of [
            [1, 2],
            [0, 0],
        ])
            data.constraints.push({
                id: Math.max(0, ...data.constraints.map((c) => c.id)) + 1,
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: a, pointIndex: ap },
                    { entityId: b, pointIndex: bp },
                ],
            });
    }
}
export function transformEntity(
    e: SketchEntityData,
    fn: (p: UV) => UV,
    scale = 1,
    mirror = false,
): SketchEntityData {
    const params = [...e.params];
    for (let i = 0; i < (e.type === "circle" ? 2 : params.length); i += 2) {
        const p = fn([params[i], params[i + 1]]);
        params[i] = p[0];
        params[i + 1] = p[1];
    }
    if (e.type === "circle") params[2] *= Math.abs(scale);
    if (e.type === "arc" && mirror) {
        [params[2], params[4]] = [params[4], params[2]];
        [params[3], params[5]] = [params[5], params[3]];
    }
    return { ...e, params };
}
export function copyEntities(
    data: SketchData,
    ids: number[],
    fn: (p: UV) => UV,
    scale = 1,
    mirror = false,
): number[] {
    const originals = data.entities.filter((e) => ids.includes(e.id)),
        constraints = [...data.constraints],
        map = new Map<number, number>();
    for (const e of originals) {
        const v = transformEntity(e, fn, scale, mirror);
        map.set(e.id, appendEntity(data, e.type, v.params, v));
    }
    let cid = Math.max(0, ...data.constraints.map((c) => c.id)) + 1;
    for (const constraint of constraints)
        if (constraint.refs.every((r) => map.has(r.entityId))) {
            if (
                constraint.kind === ConstraintKind.PointOnArc &&
                constraint.refs.every((r) => r.entityId === constraint.refs[0].entityId)
            )
                continue;
            const c = transformedConstraint(constraint, data, fn, scale, mirror);
            if (c)
                data.constraints.push({
                    ...c,
                    id: cid++,
                    refs: c.refs.map((r) => ({ ...r, entityId: map.get(r.entityId)! })),
                });
        }
    return [...map.values()];
}

/** Absolute coordinates and axis-dependent constraints need their own transform. */
export function transformedConstraint(
    c: SketchConstraintData,
    data: SketchData,
    fn: (p: UV) => UV,
    scale = 1,
    mirror = false,
): SketchConstraintData | undefined {
    const out = structuredClone(c),
        zero = fn([0, 0]),
        x = fn([1, 0]);
    const swapped = Math.abs(x[0] - zero[0]) < EPS,
        axisAligned = swapped || Math.abs(x[1] - zero[1]) < EPS;
    if (
        [
            ConstraintKind.Horizontal,
            ConstraintKind.Vertical,
            ConstraintKind.HorizontalAlign,
            ConstraintKind.VerticalAlign,
        ].includes(c.kind)
    ) {
        if (!axisAligned) return undefined;
        if (swapped)
            out.kind = (
                {
                    [ConstraintKind.Horizontal]: ConstraintKind.Vertical,
                    [ConstraintKind.Vertical]: ConstraintKind.Horizontal,
                    [ConstraintKind.HorizontalAlign]: ConstraintKind.VerticalAlign,
                    [ConstraintKind.VerticalAlign]: ConstraintKind.HorizontalAlign,
                } as Record<number, ConstraintKind>
            )[c.kind];
    }
    if (c.kind === ConstraintKind.Fix && c.datums?.every((v) => typeof v === "number"))
        out.datums = fn(c.datums as UV);
    if (c.kind === ConstraintKind.HorizontalDistance || c.kind === ConstraintKind.VerticalDistance) {
        const points = c.refs.map((r) => {
            const e = data.entities.find((e) => e.id === r.entityId)!;
            return fn([e.params[r.pointIndex * 2], e.params[r.pointIndex * 2 + 1]]);
        });
        out.datum =
            c.kind === ConstraintKind.HorizontalDistance
                ? points[1][0] - points[0][0]
                : points[1][1] - points[0][1];
    } else if (c.datum !== undefined && c.kind !== ConstraintKind.Angle) {
        const factor = scale * (mirror && c.kind === ConstraintKind.P2LDistance ? -1 : 1);
        out.datum =
            typeof c.datum === "number"
                ? c.datum * factor
                : factor === 1
                  ? c.datum
                  : `(${c.datum}) * ${factor}`;
    }
    if (mirror)
        out.refs = out.refs.map((r) => {
            const e = data.entities.find((e) => e.id === r.entityId);
            return e?.type === "arc" && r.pointIndex > 0 ? { ...r, pointIndex: 3 - r.pointIndex } : r;
        });
    return out;
}

function ensureArcConstraint(data: SketchData, id: number): void {
    data.constraints.push({
        id: Math.max(0, ...data.constraints.map((c) => c.id)) + 1,
        kind: ConstraintKind.PointOnArc,
        refs: [
            { entityId: id, pointIndex: 2 },
            { entityId: id, pointIndex: 0 },
            { entityId: id, pointIndex: 1 },
        ],
    });
}

/** De Casteljau subdivision keeps the exact curve and degree on both sides. */
function splitBezier(data: SketchData, entity: SketchEntityData, pick: UV): void {
    const poles = curvePoles(entity),
        last = poles.length - 1;
    if (distance(poles[0], poles[last]) < EPS)
        throw new Error("Splitting a closed Bezier is not supported yet.");
    let closest = 0,
        best = Infinity;
    for (let i = 0; i <= 128; i++) {
        const d = distance(evaluateBezier(poles, i / 128), pick);
        if (d < best) {
            closest = i / 128;
            best = d;
        }
    }
    let lo = Math.max(0, closest - 1 / 128),
        hi = Math.min(1, closest + 1 / 128);
    for (let i = 0; i < 55; i++) {
        const a = lo + (hi - lo) / 3,
            b = hi - (hi - lo) / 3;
        if (distance(evaluateBezier(poles, a), pick) < distance(evaluateBezier(poles, b), pick)) hi = b;
        else lo = a;
    }
    const t = (lo + hi) / 2;
    if (t < EPS || t > 1 - EPS) return;
    let level = poles;
    const left: UV[] = [poles[0]],
        right: UV[] = [poles[last]];
    while (level.length > 1) {
        level = level
            .slice(0, -1)
            .map((p, i) => [p[0] * (1 - t) + level[i + 1][0] * t, p[1] * (1 - t) + level[i + 1][1] * t]);
        left.push(level[0]);
        right.unshift(level[level.length - 1]);
    }
    entity.params = left.flat();
    const id = appendEntity(data, "bezier", right.flat(), entity);
    data.constraints = data.constraints.flatMap((c) => {
        if (c.refs.some((r) => r.entityId === entity.id && r.pointIndex !== 0 && r.pointIndex !== last))
            return [];
        return [
            {
                ...c,
                refs: c.refs.map((r) =>
                    r.entityId === entity.id && r.pointIndex === last ? { ...r, entityId: id } : r,
                ),
            },
        ];
    });
    data.constraints.push({
        id: Math.max(0, ...data.constraints.map((c) => c.id)) + 1,
        kind: ConstraintKind.P2PCoincident,
        refs: [
            { entityId: entity.id, pointIndex: last },
            { entityId: id, pointIndex: 0 },
        ],
    });
}
