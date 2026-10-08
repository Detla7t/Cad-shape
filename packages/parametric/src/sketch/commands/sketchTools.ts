// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    type CommandKeys,
    command,
    type IEdge,
    PubSub,
    ShapeNode,
    ShapeTypes,
} from "@chili3d/core";
import { arcThroughPoints } from "../../drawing/drawing";
import type { UV } from "../curveGeometry";
import { editSketch } from "../editor/editSketch";
import type { SketchEditor } from "../editor/sketchEditor";
import { entityDisplayMesh } from "../entityMesh";
import { captureExternalRef } from "../externalRef";
import { ConstraintKind, type SketchData, type SketchEntityData } from "../sketchModel";
import { offsetSketchEntities } from "../sketchOffset";
import {
    appendEntity,
    copyEntities,
    distance,
    transformEntity,
    transformedConstraint,
    trimOrSplit,
} from "../sketchOperations";
import { tangentConstraintFor } from "../solverEntities";
import { appendText } from "../textGeometry";
import { SketchConstraintCommand } from "./sketchConstraints";
import { sketchToolInput } from "./sketchToolInput";

function connectedLoop(data: SketchData, points: UV[]) {
    const ids = points.map((p, i) => appendEntity(data, "line", [...p, ...points[(i + 1) % points.length]]));
    let id = Math.max(0, ...data.constraints.map((c) => c.id)) + 1;
    ids.forEach((e, i) =>
        data.constraints.push({
            id: id++,
            kind: ConstraintKind.P2PCoincident,
            refs: [
                { entityId: e, pointIndex: 1 },
                { entityId: ids[(i + 1) % ids.length], pointIndex: 0 },
            ],
        }),
    );
}
const registrations: Record<string, string> = {
    midpointLine: "Midpoint line",
    centerRectangle: "Center point rectangle",
    alignedRectangle: "Aligned rectangle",
    polygon: "Inscribed polygon",
    circumscribedPolygon: "Circumscribed polygon",
    spline: "Spline",
    bezier: "Bezier",
    splinePoint: "Spline control point",
    point: "Point",
    text: "Text",
    intersection: "Intersection",
    fillet: "Sketch fillet",
    chamfer: "Sketch chamfer",
    trim: "Trim",
    extend: "Extend",
    split: "Split",
    offset: "Offset",
    slot: "Slot",
    mirror: "Mirror",
    linearPattern: "Linear pattern",
    circularPattern: "Circular pattern",
    transform: "Transform",
    arc3Point: "3 point arc",
};
for (const [operation, title] of Object.entries(registrations)) {
    class Tool extends SketchConstraintCommand {
        protected async executeWithEditor(editor: SketchEditor): Promise<void> {
            this.controller = new AsyncController();
            const input = (fields: Record<string, string | number>) =>
                sketchToolInput(editor.view, title, fields, this.controller);
            let preview: number | undefined;
            const clear = () => {
                if (preview !== undefined) editor.document.visual.context.removeMesh(preview);
                preview = undefined;
            };
            const point = async (points: UV[] = []): Promise<UV | undefined> => {
                this.controller = new AsyncController();
                return editor.pickPosition(
                    "prompt.pickSketchPoint",
                    (uv) => {
                        clear();
                        if (!uv || !points.length) return;
                        const meshes = points
                            .slice(1)
                            .map((p, i) =>
                                entityDisplayMesh(
                                    editor.node.plane,
                                    { id: 0, type: "line", params: [...points[i], ...p] },
                                    0xffbd35,
                                ),
                            );
                        meshes.push(
                            entityDisplayMesh(
                                editor.node.plane,
                                { id: 0, type: "line", params: [...points[points.length - 1], ...uv] },
                                0xffbd35,
                            ),
                        );
                        preview = editor.document.visual.context.displayMesh(meshes, { onTop: true });
                        editor.view.update();
                    },
                    this.controller,
                );
            };
            const entity = async (type?: "line" | "circle" | "arc") => {
                this.controller = new AsyncController();
                return editor.pickEntity("prompt.pickSketchEntity", type, undefined, this.controller);
            };
            try {
                if (["trim", "split", "extend"].includes(operation)) {
                    editor.powerTrim = operation === "trim";
                    editor.endConstraintSelection();
                    editor.clearSelection();
                    while (!this.isCanceled) {
                        const id = await entity();
                        if (id === undefined) break;
                        const pick =
                            editor.lastPickPosition ?? editor.solver.pointOf({ entityId: id, pointIndex: 0 });
                        editSketch(editor, (d) =>
                            trimOrSplit(d, id, pick, operation as "trim" | "split" | "extend"),
                        );
                    }
                    return;
                }
                if (operation === "text") {
                    const values = await input({ Text: "Text", "Height (mm)": 10 });
                    if (!values) return;
                    const anchor = await point();
                    if (!anchor) return;
                    editSketch(editor, (data) =>
                        appendText(data, values["Text"], Number(values["Height (mm)"]), anchor),
                    );
                    return;
                }
                if (operation === "intersection") {
                    const nodes = await editor.document.picker.pickNode(
                        "prompt.select.shape",
                        this.controller,
                        { nodeFilter: { allow: (n) => n instanceof ShapeNode && n !== editor.node } },
                    );
                    const entries: SketchEntityData[] = [];
                    for (const node of nodes) {
                        if (!(node instanceof ShapeNode) || !node.shape.isOk) continue;
                        const world = node.shape.value.transformedMul(node.worldTransform()),
                            section = world.section(editor.node.plane);
                        try {
                            for (const edge of section.findSubShapes(ShapeTypes.edge) as IEdge[]) {
                                const ref = captureExternalRef(
                                    -100,
                                    node.id,
                                    editor.node.plane,
                                    edge,
                                    undefined,
                                    "reference",
                                );
                                if (ref) entries.push({ id: 0, type: ref.type, params: ref.snapshot });
                            }
                        } finally {
                            section.dispose();
                            world.dispose();
                        }
                    }
                    if (!entries.length)
                        throw new Error(
                            "The selected geometry does not intersect this sketch plane with supported curves.",
                        );
                    editSketch(editor, (d) => entries.forEach((e) => appendEntity(d, e.type, e.params)));
                    return;
                }
                if (
                    [
                        "point",
                        "midpointLine",
                        "centerRectangle",
                        "alignedRectangle",
                        "polygon",
                        "circumscribedPolygon",
                        "bezier",
                        "spline",
                        "arc3Point",
                        "slot",
                    ].includes(operation)
                ) {
                    let count =
                            operation === "point"
                                ? 1
                                : operation === "bezier"
                                  ? 4
                                  : ["alignedRectangle", "arc3Point"].includes(operation)
                                    ? 3
                                    : 2,
                        sides = 6,
                        width = 10;
                    if (operation.includes("Polygon") || operation === "polygon") {
                        const v = await input({ Sides: 6 });
                        if (!v) return;
                        sides = Math.round(Number(v["Sides"]));
                        if (sides < 3 || sides > 128) throw new Error("Choose 3–128 sides.");
                    }
                    if (operation === "spline") {
                        const v = await input({ "Fit points": 3 });
                        if (!v) return;
                        count = Math.round(Number(v["Fit points"]));
                        if (count < 2 || count > 12) throw new Error("Choose 2–12 fit points.");
                    }
                    if (operation === "slot") {
                        const v = await input({ "Width (mm)": 10 });
                        if (!v) return;
                        width = Number(v["Width (mm)"]);
                        if (width <= 0) throw new Error("Width must be positive.");
                    }
                    const points: UV[] = [];
                    for (let i = 0; i < count; i++) {
                        const p = await point(points);
                        if (!p) return;
                        points.push(p);
                    }
                    clear();
                    editSketch(editor, (d) => {
                        const a = points[0],
                            b = points[1],
                            dx = b?.[0] - a[0],
                            dy = b?.[1] - a[1];
                        if (operation === "point") appendEntity(d, "point", a, { construction: true });
                        if (operation === "bezier" || operation === "spline")
                            appendEntity(d, operation, points.flat());
                        if (operation === "midpointLine")
                            appendEntity(d, "line", [a[0] - dx, a[1] - dy, ...b]);
                        if (operation === "centerRectangle")
                            connectedLoop(d, [
                                [a[0] - dx, a[1] - dy],
                                [a[0] + dx, a[1] - dy],
                                b,
                                [a[0] - dx, a[1] + dy],
                            ]);
                        if (operation === "alignedRectangle") {
                            const len = distance(a, b);
                            if (len < 1e-8) throw new Error("Pick distinct corners.");
                            const h =
                                ((points[2][0] - a[0]) * -dy + (points[2][1] - a[1]) * dx) / (len * len);
                            connectedLoop(d, [
                                a,
                                b,
                                [b[0] - dy * h, b[1] + dx * h],
                                [a[0] - dy * h, a[1] + dx * h],
                            ]);
                        }
                        if (operation === "polygon" || operation === "circumscribedPolygon") {
                            const r =
                                    distance(a, b) /
                                    (operation === "polygon" ? 1 : Math.cos(Math.PI / sides)),
                                angle = Math.atan2(dy, dx) + (operation === "polygon" ? 0 : Math.PI / sides);
                            connectedLoop(
                                d,
                                Array.from({ length: sides }, (_, i) => [
                                    a[0] + r * Math.cos(angle + (i * 2 * Math.PI) / sides),
                                    a[1] + r * Math.sin(angle + (i * 2 * Math.PI) / sides),
                                ]),
                            );
                        }
                        if (operation === "arc3Point") {
                            const arc = arcThroughPoints("0", a, points[1], points[2]);
                            if (!arc) throw new Error("Arc points are collinear.");
                            const start = (arc.startAngle * Math.PI) / 180,
                                end = (arc.endAngle * Math.PI) / 180,
                                c = arc.center;
                            appendEntity(d, "arc", [
                                ...c,
                                c[0] + arc.radius * Math.cos(start),
                                c[1] + arc.radius * Math.sin(start),
                                c[0] + arc.radius * Math.cos(end),
                                c[1] + arc.radius * Math.sin(end),
                            ]);
                        }
                        if (operation === "slot") {
                            const len = distance(a, b);
                            if (len < 1e-8) throw new Error("Pick distinct slot centers.");
                            const nx = ((-dy / len) * width) / 2,
                                ny = ((dx / len) * width) / 2,
                                p: UV = [a[0] + nx, a[1] + ny],
                                q: UV = [b[0] + nx, b[1] + ny],
                                r: UV = [b[0] - nx, b[1] - ny],
                                s: UV = [a[0] - nx, a[1] - ny];
                            appendEntity(d, "line", [...p, ...q]);
                            appendEntity(d, "line", [...r, ...s]);
                            appendEntity(d, "arc", [...b, ...r, ...q]);
                            appendEntity(d, "arc", [...a, ...p, ...s]);
                        }
                    });
                    return;
                }
                if (operation === "splinePoint") {
                    const id = await editor.pickEntity(
                        "prompt.pickSketchEntity",
                        ["bezier", "spline"],
                        undefined,
                        this.controller,
                    );
                    if (id === undefined) return;
                    const p = await point();
                    if (!p) return;
                    editSketch(editor, (d) => {
                        const e = d.entities.find((x) => x.id === id)!;
                        e.params.push(...p);
                    });
                    return;
                }
                let ids = [...editor.selectedWholeEntityIds];
                if (!ids.length) {
                    const id = await entity();
                    if (id === undefined) return;
                    ids = [id];
                }
                editor.clearPreselection();
                if (operation === "offset") {
                    const v = await input({ "Offset (mm)": 5 });
                    if (!v) return;
                    const offset = Number(v["Offset (mm)"]);
                    editSketch(editor, (d) => offsetSketchEntities(d, ids, offset, editor.node.plane));
                    return;
                }
                if (operation === "mirror") {
                    const axis = await entity("line");
                    if (axis === undefined) return;
                    const line = editor.solver.entity(axis)!,
                        p = line.params,
                        dx = p[2] - p[0],
                        dy = p[3] - p[1],
                        len = dx * dx + dy * dy;
                    if (len < 1e-12) return;
                    editSketch(editor, (d) =>
                        copyEntities(
                            d,
                            ids.filter((id) => id !== axis),
                            (q) => {
                                const t = ((q[0] - p[0]) * dx + (q[1] - p[1]) * dy) / len;
                                return [2 * (p[0] + t * dx) - q[0], 2 * (p[1] + t * dy) - q[1]];
                            },
                            1,
                            true,
                        ),
                    );
                    return;
                }
                if (operation === "linearPattern") {
                    const v = await input({ Instances: 3, "X spacing (mm)": 20, "Y spacing (mm)": 0 });
                    if (!v) return;
                    const n = Math.round(Number(v["Instances"]));
                    if (n < 2 || n > 200) throw new Error("Choose 2–200 instances.");
                    editSketch(editor, (d) => {
                        for (let i = 1; i < n; i++)
                            copyEntities(d, ids, (p) => [
                                p[0] + i * Number(v["X spacing (mm)"]),
                                p[1] + i * Number(v["Y spacing (mm)"]),
                            ]);
                    });
                    return;
                }
                if (operation === "circularPattern") {
                    const center = await point();
                    if (!center) return;
                    const v = await input({ Instances: 4, "Sweep (deg)": 360 });
                    if (!v) return;
                    const n = Math.round(Number(v["Instances"])),
                        sweep = (Number(v["Sweep (deg)"]) * Math.PI) / 180;
                    if (n < 2 || n > 200) throw new Error("Choose 2–200 instances.");
                    editSketch(editor, (d) => {
                        for (let i = 1; i < n; i++) {
                            const a = (sweep * i) / (Math.abs(sweep - 2 * Math.PI) < 1e-8 ? n : n - 1);
                            copyEntities(d, ids, (p) => [
                                center[0] +
                                    (p[0] - center[0]) * Math.cos(a) -
                                    (p[1] - center[1]) * Math.sin(a),
                                center[1] +
                                    (p[0] - center[0]) * Math.sin(a) +
                                    (p[1] - center[1]) * Math.cos(a),
                            ]);
                        }
                    });
                    return;
                }
                if (operation === "transform") {
                    const v = await input({ "X (mm)": 0, "Y (mm)": 0, "Rotation (deg)": 0, Scale: 1 });
                    if (!v) return;
                    const s = Number(v["Scale"]),
                        a = (Number(v["Rotation (deg)"]) * Math.PI) / 180;
                    if (s <= 0) throw new Error("Scale must be positive.");
                    editSketch(editor, (d) => {
                        const transform = (p: UV): UV => [
                            Number(v["X (mm)"]) + s * (p[0] * Math.cos(a) - p[1] * Math.sin(a)),
                            Number(v["Y (mm)"]) + s * (p[0] * Math.sin(a) + p[1] * Math.cos(a)),
                        ];
                        d.constraints = d.constraints.flatMap((c) => {
                            if (!c.refs.every((r) => ids.includes(r.entityId))) return [c];
                            const transformed = transformedConstraint(c, d, transform, s);
                            return transformed ? [transformed] : [];
                        });
                        d.entities = d.entities.map((e) =>
                            ids.includes(e.id) ? transformEntity(e, transform, s) : e,
                        );
                    });
                    return;
                }
                if (operation === "fillet" || operation === "chamfer") {
                    const a = ids[0],
                        b = ids[1] ?? (await entity("line"));
                    if (b === undefined) return;
                    const v = await input({ [operation === "fillet" ? "Radius (mm)" : "Distance (mm)"]: 5 });
                    if (!v) return;
                    const amount = Number(Object.values(v)[0]);
                    if (amount <= 0) throw new Error("Size must be positive.");
                    editSketch(editor, (d) => roundCorner(d, a, b, amount, operation === "fillet"));
                    return;
                }
            } catch (error) {
                PubSub.default.pub("displayError", error instanceof Error ? error.message : String(error));
            } finally {
                editor.powerTrim = false;
                editor.highlightEntities([]);
                clear();
            }
        }
    }
    command({ key: `sketch.${operation}` as CommandKeys, icon: "icon-sketchNew" })(Tool);
}
export function roundCorner(data: SketchData, a: number, b: number, amount: number, fillet: boolean) {
    const first = data.entities.find((e) => e.id === a),
        second = data.entities.find((e) => e.id === b);
    if (!first || !second || first.type !== "line" || second.type !== "line" || a === b)
        throw new Error("Select two lines sharing a corner.");
    const p = first.params,
        q = second.params;
    let ai = -1,
        bi = -1;
    for (const i of [0, 2])
        for (const j of [0, 2])
            if (Math.hypot(p[i] - q[j], p[i + 1] - q[j + 1]) < 1e-5) {
                ai = i;
                bi = j;
            }
    if (ai < 0) throw new Error("The two lines must share an endpoint.");
    const c: UV = [p[ai], p[ai + 1]],
        u: UV = [p[2 - ai] - c[0], p[3 - ai] - c[1]],
        v: UV = [q[2 - bi] - c[0], q[3 - bi] - c[1]],
        lu = Math.hypot(...u),
        lv = Math.hypot(...v);
    u[0] /= lu;
    u[1] /= lu;
    v[0] /= lv;
    v[1] /= lv;
    const angle = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))),
        step = fillet ? amount / Math.tan(angle / 2) : amount;
    if (!Number.isFinite(step) || step >= Math.min(lu, lv) || step < 1e-8)
        throw new Error("The corner size does not fit these lines.");
    const x: UV = [c[0] + u[0] * step, c[1] + u[1] * step],
        y: UV = [c[0] + v[0] * step, c[1] + v[1] * step];
    p[ai] = x[0];
    p[ai + 1] = x[1];
    q[bi] = y[0];
    q[bi + 1] = y[1];
    const directionKinds = [
        ConstraintKind.Horizontal,
        ConstraintKind.Vertical,
        ConstraintKind.Parallel,
        ConstraintKind.Perpendicular,
        ConstraintKind.Angle,
    ];
    data.constraints = data.constraints.filter(
        (k) =>
            directionKinds.includes(k.kind) ||
            !k.refs.some(
                (r) =>
                    (r.entityId === a && r.pointIndex === ai / 2) ||
                    (r.entityId === b && r.pointIndex === bi / 2),
            ),
    );
    const add = (kind: ConstraintKind, refs: import("../sketchModel").SketchPointRef[], datum?: number) => {
        data.constraints.push({
            id: Math.max(0, ...data.constraints.map((c) => c.id)) + 1,
            kind,
            refs,
            datum,
        });
    };
    const join = (id: number, ap: number, bp: number) => {
        add(ConstraintKind.P2PCoincident, [
            { entityId: a, pointIndex: ai / 2 },
            { entityId: id, pointIndex: ap },
        ]);
        add(ConstraintKind.P2PCoincident, [
            { entityId: b, pointIndex: bi / 2 },
            { entityId: id, pointIndex: bp },
        ]);
    };
    if (!fillet) {
        const id = appendEntity(data, "line", [...x, ...y]);
        join(id, 0, 1);
    } else {
        const k = amount / Math.sin(angle / 2),
            bl = Math.hypot(u[0] + v[0], u[1] + v[1]),
            center: UV = [c[0] + ((u[0] + v[0]) / bl) * k, c[1] + ((u[1] + v[1]) / bl) * k];
        const cross = (x[0] - center[0]) * (y[1] - center[1]) - (x[1] - center[1]) * (y[0] - center[0]);
        const id = appendEntity(data, "arc", [...center, ...(cross > 0 ? x : y), ...(cross > 0 ? y : x)]);
        join(id, cross > 0 ? 1 : 2, cross > 0 ? 2 : 1);
        for (const line of [a, b]) {
            const tangent = tangentConstraintFor("line", line, "arc", id)!;
            add(tangent.kind, tangent.refs);
        }
        add(ConstraintKind.Radius, [{ entityId: id, pointIndex: 0 }], amount);
    }
}
