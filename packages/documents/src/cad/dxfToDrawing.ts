// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { Drawing, DrawingEntity, DrawingLayer } from "@chili3d/parametric";
import {
    type Affine,
    apply,
    bulgeArc,
    ccwSweep,
    clampedKnots,
    compose,
    determinant,
    rotation,
    sampleEllipse,
    sampleFitPoints,
    sampleNurbs,
    scaling,
    similarityScale,
    translation,
    type Vec2,
} from "./curves";
import {
    type DxfBlock,
    type DxfFile,
    type DxfRecord,
    dxfAll,
    dxfNumber as num,
    readDxfFile,
    dxfString as str,
} from "./dxfReader";

/**
 * A DXF file's model space as a 2D drawing in millimetres (the `Drawing` the DXF/SVG
 * writers and the sketch converter take): lines, circles and arcs stay exact (also through
 * mirrored and rotated block references and OCS extrusion), polyline bulges become arcs,
 * splines, ellipses and non-uniformly scaled arcs become lines within a chord tolerance,
 * TEXT/MTEXT/ATTRIB become single-line texts, INSERT (with MINSERT arrays) and DIMENSION
 * blocks are expanded, and frozen or switched-off layers are left out. Units come from
 * `$INSUNITS` (unitless files are taken as millimetres).
 */

export interface DrawingUnits {
    /** `$INSUNITS` code (0 when absent). */
    readonly code: number;
    readonly name: string;
    /** Millimetres per drawing unit. */
    readonly toMm: number;
    /** True when the file names no unit and millimetres were assumed. */
    readonly assumed: boolean;
}

export interface ImportedDrawing {
    /** In millimetres. */
    readonly drawing: Drawing;
    /** The DXF entity type each drawing entity came from, parallel to `drawing.entities`. */
    readonly sources: readonly string[];
    readonly units: DrawingUnits;
    /** `$ACADVER`, e.g. "AC1015". */
    readonly version?: string;
    /** Entities left out, by DXF type (unsupported, on hidden layers, missing blocks). */
    readonly skipped: Readonly<Record<string, number>>;
}

export interface DrawingImportOptions {
    /** Millimetres per drawing unit, overriding `$INSUNITS`. */
    readonly toMm?: number;
    /** Chord tolerance of curves drawn as lines, in millimetres (default 0.01). */
    readonly tolerance?: number;
    /** Include paper-space entities (default false: model space only). */
    readonly paperSpace?: boolean;
    /**
     * The layers to leave out, replacing the on/off and frozen state of the DXF's layer
     * table — for DXF converted from DWG, where the converter's table may be wrong.
     */
    readonly hiddenLayers?: ReadonlySet<string>;
}

/** `$INSUNITS` codes → [name, millimetres]. */
export const DXF_UNITS: Readonly<Record<number, readonly [string, number]>> = {
    0: ["unitless", 1],
    1: ["in", 25.4],
    2: ["ft", 304.8],
    3: ["mi", 1609344],
    4: ["mm", 1],
    5: ["cm", 10],
    6: ["m", 1000],
    7: ["km", 1e6],
    8: ["µin", 25.4e-6],
    9: ["mil", 0.0254],
    10: ["yd", 914.4],
    11: ["Å", 1e-7],
    12: ["nm", 1e-6],
    13: ["µm", 1e-3],
    14: ["dm", 100],
    15: ["dam", 1e4],
    16: ["hm", 1e5],
    17: ["Gm", 1e12],
    18: ["au", 1.495978707e14],
    19: ["ly", 9.4607304725808e18],
    20: ["pc", 3.085677581491367e19],
};

export function drawingUnits(file: DxfFile, toMm?: number): DrawingUnits {
    const raw = file.header.get("$INSUNITS");
    const code = typeof raw === "number" ? raw : 0;
    const known = DXF_UNITS[code];
    if (toMm !== undefined) {
        const match = Object.entries(DXF_UNITS).find(([c, [, mm]]) => Number(c) > 0 && mm === toMm);
        return {
            code: match ? Number(match[0]) : code,
            name: match ? match[1][0] : `×${toMm}`,
            toMm,
            assumed: false,
        };
    }
    if (known === undefined || code === 0) return { code, name: "mm", toMm: 1, assumed: true };
    return { code, name: known[0], toMm: known[1], assumed: false };
}

// ------------------------------------------------------------------ Colors

/** CSS color of an AutoCAD color index, for a light background (7 draws black). */
export function aciColor(index: number): string {
    const aci = Math.abs(Math.round(index));
    const hex = (r: number, g: number, b: number) =>
        `#${[r, g, b]
            .map((v) =>
                Math.round(Math.max(0, Math.min(255, v)))
                    .toString(16)
                    .padStart(2, "0"),
            )
            .join("")}`;
    const basic: Record<number, string> = {
        1: "#ff0000",
        2: "#ffff00",
        3: "#00ff00",
        4: "#00ffff",
        5: "#0000ff",
        6: "#ff00ff",
        7: "#000000",
        8: "#808080",
        9: "#c0c0c0",
        250: "#333333",
        251: "#505050",
        252: "#696969",
        253: "#828282",
        254: "#bebebe",
        255: "#000000",
    };
    if (basic[aci] !== undefined) return basic[aci];
    if (aci < 10 || aci > 249) return "#000000";
    // 10–249: 24 hues of 15°, each in five shades, full and half saturation.
    const hue = Math.floor((aci - 10) / 10) * 15;
    const shade = (aci - 10) % 10;
    const value = [1, 0.8, 0.6, 0.5, 0.3][Math.floor(shade / 2)];
    const saturation = shade % 2 === 0 ? 1 : 0.5;
    const c = value * saturation;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = value - c;
    const [r, g, b] =
        hue < 60
            ? [c, x, 0]
            : hue < 120
              ? [x, c, 0]
              : hue < 180
                ? [0, c, x]
                : hue < 240
                  ? [0, x, c]
                  : hue < 300
                    ? [x, 0, c]
                    : [c, 0, x];
    return hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// ------------------------------------------------------------------ Text

/** TEXT control codes (%%c, %%d, %%p, %%nnn) and \U+XXXX escapes as characters. */
export function decodeDxfText(text: string): string {
    return text
        .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/%%(\d{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
        .replace(/%%[cC]/g, "Ø")
        .replace(/%%[dD]/g, "°")
        .replace(/%%[pP]/g, "±")
        .replace(/%%[uUoOkK]/g, "")
        .replace(/%%%/g, "%");
}

/** The plain lines of MTEXT content: formatting codes stripped, \P paragraphs split. */
export function mtextLines(content: string): string[] {
    const plain = decodeDxfText(content)
        .replace(/\\[Pp]/g, "\n")
        .replace(/\\~/g, " ")
        .replace(/\\S([^;]*?)[#^/]([^;]*?);/g, "$1/$2")
        .replace(/\\[ACcFfHhQTWp][^;\\]*;/g, "")
        .replace(/\\[LlOoKkNX]/g, "")
        .replace(/\\([\\{}])/g, "\uE000$1")
        .replace(/[{}]/g, "")
        .replace(/\uE000([\\{}])/g, "$1");
    return plain.split("\n");
}

// ------------------------------------------------------------------ Emitting

interface Context {
    readonly transform: Affine;
    /** The layer of the enclosing INSERT: entities on layer 0 inside a block take it. */
    readonly insertLayer?: string;
    /** The type of the top-level entity whose block is being drawn (DIMENSION, INSERT). */
    readonly source?: string;
    /** The colour override of the enclosing INSERT or DIMENSION: ByBlock entities take it. */
    readonly insertColor?: string;
    readonly blocks: readonly string[];
}

const MAX_BLOCK_DEPTH = 16;

/** The OCS → WCS map of an extruded 2D entity, projected onto the XY plane (arbitrary axis algorithm). */
function ocs(record: DxfRecord, elevation = 0): Affine {
    const nx = num(record, 210, 0);
    const ny = num(record, 220, 0);
    const nz = num(record, 230, 1);
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) return [1, 0, 0, 1, 0, 0];
    const n = [nx / length, ny / length, nz / length];
    if (Math.abs(n[0]) < 1e-12 && Math.abs(n[1]) < 1e-12) {
        return n[2] > 0 ? [1, 0, 0, 1, 0, 0] : [-1, 0, 0, 1, 0, 0];
    }
    const cross = (a: number[], b: number[]) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    const world = Math.abs(n[0]) < 1 / 64 && Math.abs(n[1]) < 1 / 64 ? [0, 1, 0] : [0, 0, 1];
    const ax = cross(world, n);
    const axLength = Math.hypot(ax[0], ax[1], ax[2]);
    const x = ax.map((v) => v / axLength);
    const y = cross(n, x);
    return [x[0], x[1], y[0], y[1], elevation * n[0], elevation * n[1]];
}

class DrawingBuilder {
    readonly entities: DrawingEntity[] = [];
    readonly sources: string[] = [];
    readonly skipped: Record<string, number> = {};
    readonly usedLayers = new Set<string>();
    /** The colour override of the record being drawn (undefined = ByLayer). */
    private color: string | undefined;

    constructor(
        private readonly file: DxfFile,
        private readonly tolerance: number,
        private readonly paperSpace: boolean,
        private readonly hiddenLayers?: ReadonlySet<string>,
    ) {}

    skip(type: string): void {
        this.skipped[type] = (this.skipped[type] ?? 0) + 1;
    }

    private push(entity: DrawingEntity, source: string): void {
        this.entities.push(this.color === undefined ? entity : { ...entity, color: this.color });
        this.sources.push(source);
        this.usedLayers.add(entity.layer);
    }

    /** Chord tolerance in the local units of `transform`. */
    private localTolerance(transform: Affine): number {
        const scale = Math.max(
            Math.hypot(transform[0], transform[1]),
            Math.hypot(transform[2], transform[3]),
        );
        return this.tolerance / Math.max(scale, 1e-12);
    }

    line(t: Affine, a: Vec2, b: Vec2, layer: string, source: string): void {
        const pa = apply(t, a);
        const pb = apply(t, b);
        if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < 1e-9) return;
        this.push({ kind: "line", layer, a: pa, b: pb }, source);
    }

    polyline(t: Affine, points: readonly Vec2[], layer: string, source: string): void {
        for (let i = 0; i + 1 < points.length; i++) this.line(t, points[i], points[i + 1], layer, source);
    }

    /** A counter-clockwise arc (radians, local); `full` draws the whole circle. */
    arc(
        t: Affine,
        center: Vec2,
        radius: number,
        start: number,
        end: number,
        layer: string,
        source: string,
    ): void {
        if (!(radius > 0)) return;
        const sweep = ccwSweep(start, end);
        const full = sweep >= 2 * Math.PI - 1e-9;
        const scale = similarityScale(t);
        if (scale !== undefined) {
            const c = apply(t, center);
            const r = radius * scale;
            if (full) {
                this.push({ kind: "circle", layer, center: c, radius: r }, source);
                return;
            }
            const p0 = apply(t, [center[0] + radius * Math.cos(start), center[1] + radius * Math.sin(start)]);
            const p1 = apply(t, [center[0] + radius * Math.cos(end), center[1] + radius * Math.sin(end)]);
            let a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
            let a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
            if (determinant(t) < 0) [a0, a1] = [a1, a0];
            this.push(
                { kind: "arc", layer, center: c, radius: r, startAngle: degrees(a0), endAngle: degrees(a1) },
                source,
            );
            return;
        }
        const points = sampleEllipse(
            center,
            [radius, 0],
            [0, radius],
            start,
            start + sweep,
            this.localTolerance(t),
        );
        this.polyline(t, points, layer, source);
    }

    ellipse(
        t: Affine,
        center: Vec2,
        major: Vec2,
        minor: Vec2,
        t0: number,
        t1: number,
        layer: string,
        source: string,
    ): void {
        const end = t1 <= t0 ? t1 + 2 * Math.PI : t1;
        const linear = (v: Vec2): Vec2 => [t[0] * v[0] + t[2] * v[1], t[1] * v[0] + t[3] * v[1]];
        const m = linear(major);
        const n = linear(minor);
        const lm = Math.hypot(m[0], m[1]);
        const ln = Math.hypot(n[0], n[1]);
        const circular =
            Math.abs(lm - ln) <= 1e-9 * Math.max(lm, 1) &&
            Math.abs(m[0] * n[0] + m[1] * n[1]) <= 1e-9 * lm * lm;
        if (circular && lm > 0) {
            const c = apply(t, center);
            const point = (u: number): Vec2 => [
                c[0] + Math.cos(u) * m[0] + Math.sin(u) * n[0],
                c[1] + Math.cos(u) * m[1] + Math.sin(u) * n[1],
            ];
            if (end - t0 >= 2 * Math.PI - 1e-9) {
                this.push({ kind: "circle", layer, center: c, radius: lm }, source);
                return;
            }
            const p0 = point(t0);
            const p1 = point(end);
            let a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
            let a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
            if (m[0] * n[1] - m[1] * n[0] < 0) [a0, a1] = [a1, a0];
            this.push(
                { kind: "arc", layer, center: c, radius: lm, startAngle: degrees(a0), endAngle: degrees(a1) },
                source,
            );
            return;
        }
        this.polyline(t, sampleEllipse(center, major, minor, t0, end, this.localTolerance(t)), layer, source);
    }

    text(
        t: Affine,
        middle: Vec2,
        height: number,
        angle: number,
        text: string,
        layer: string,
        source: string,
    ): void {
        const content = text.trim();
        if (content === "" || !(height > 0)) return;
        const position = apply(t, middle);
        const direction = apply([t[0], t[1], t[2], t[3], 0, 0], [Math.cos(angle), Math.sin(angle)]);
        const scale = Math.sqrt(Math.abs(determinant(t)));
        this.push(
            {
                kind: "text",
                layer,
                position,
                height: height * scale,
                rotation: degrees(Math.atan2(direction[1], direction[0])),
                text: content,
            },
            source,
        );
    }

    // -------------------------------------------------------------- Records

    layerOf(record: DxfRecord, context: Context): string | undefined {
        let name = str(record, 8, "0");
        if (name === "0" && context.insertLayer !== undefined) name = context.insertLayer;
        if (this.hiddenLayers !== undefined) return this.hiddenLayers.has(name) ? undefined : name;
        const info = this.file.layers.get(name);
        if (info !== undefined && (info.frozen || info.color < 0)) return undefined;
        return name;
    }

    drawRecords(records: readonly DxfRecord[], context: Context): void {
        for (const record of records) this.entity(record, context);
    }

    entity(record: DxfRecord, context: Context): void {
        if (!this.paperSpace && num(record, 67) === 1 && context.blocks.length === 0) return;
        if ((num(record, 60) & 1) === 1) return; // invisible
        const layer = this.layerOf(record, context);
        if (layer === undefined) {
            this.skip(`${record.type} (hidden layer)`);
            return;
        }
        const previous = this.color;
        this.color = this.colorOf(record, context);
        try {
            this.draw(record, context, layer);
        } finally {
            this.color = previous;
        }
    }

    /**
     * The entity's own colour: a true colour (420) or an ACI (62); ByLayer (256 or none) is undefined
     * and ByBlock (0) takes the enclosing INSERT's colour.
     */
    private colorOf(record: DxfRecord, context: Context): string | undefined {
        const trueColor = num(record, 420, -1);
        if (trueColor >= 0) return `#${(trueColor & 0xffffff).toString(16).padStart(6, "0")}`;
        const aci = Math.abs(num(record, 62, 256));
        if (aci >= 256) return undefined;
        if (aci === 0) return context.insertColor;
        return aciColor(aci);
    }

    private draw(record: DxfRecord, context: Context, layer: string): void {
        const source = context.source ?? record.type;
        const t = context.transform;
        switch (record.type) {
            case "LINE":
                this.line(
                    t,
                    [num(record, 10), num(record, 20)],
                    [num(record, 11), num(record, 21)],
                    layer,
                    source,
                );
                return;
            case "ARC": {
                const local = compose(t, ocs(record, num(record, 30)));
                const start = radians(num(record, 50));
                const end = radians(num(record, 51));
                this.arc(
                    local,
                    [num(record, 10), num(record, 20)],
                    num(record, 40),
                    start,
                    end,
                    layer,
                    source,
                );
                return;
            }
            case "CIRCLE": {
                const local = compose(t, ocs(record, num(record, 30)));
                this.arc(
                    local,
                    [num(record, 10), num(record, 20)],
                    num(record, 40),
                    0,
                    2 * Math.PI,
                    layer,
                    source,
                );
                return;
            }
            case "ELLIPSE":
                this.ellipseRecord(record, t, layer, source);
                return;
            case "LWPOLYLINE":
                this.lwpolyline(record, t, layer, source);
                return;
            case "POLYLINE":
                this.polylineRecord(record, t, layer, source);
                return;
            case "SPLINE":
                this.spline(record, t, layer, source);
                return;
            case "TEXT":
            case "ATTRIB":
                this.textRecord(record, t, layer, source);
                return;
            case "MTEXT":
                this.mtext(record, t, layer, source);
                return;
            case "INSERT":
                this.insert(record, context, layer);
                return;
            case "DIMENSION":
                this.dimension(record, context, layer);
                return;
            case "LEADER": {
                const xs = dxfAll(record, 10).map(Number);
                const ys = dxfAll(record, 20).map(Number);
                this.polyline(
                    t,
                    xs.map((x, i): Vec2 => [x, ys[i] ?? 0]),
                    layer,
                    source,
                );
                return;
            }
            case "SOLID":
            case "TRACE":
            case "3DFACE": {
                const p = [10, 11, 12, 13].map((c): Vec2 => [num(record, c), num(record, c + 10)]);
                const local = record.type === "3DFACE" ? t : compose(t, ocs(record, num(record, 30)));
                // SOLID and TRACE list their corners zig-zag (1, 2, 4, 3); 3DFACE goes around.
                const outline =
                    record.type === "3DFACE"
                        ? [p[0], p[1], p[2], p[3], p[0]]
                        : [p[0], p[1], p[3], p[2], p[0]];
                this.polyline(local, outline, layer, source);
                return;
            }
            case "ATTDEF":
            case "SEQEND":
            case "VERTEX":
                return;
            default:
                this.skip(record.type);
        }
    }

    private ellipseRecord(record: DxfRecord, t: Affine, layer: string, source: string): void {
        const center: Vec2 = [num(record, 10), num(record, 20)];
        const major3 = [num(record, 11), num(record, 21), num(record, 31)];
        const n = [num(record, 210, 0), num(record, 220, 0), num(record, 230, 1)];
        const ratio = num(record, 40, 1);
        // Minor axis = ratio · (normal × major), in WCS.
        const minor: Vec2 = [
            ratio * (n[1] * major3[2] - n[2] * major3[1]),
            ratio * (n[2] * major3[0] - n[0] * major3[2]),
        ];
        const t0 = num(record, 41, 0);
        const t1 = num(record, 42, 2 * Math.PI);
        this.ellipse(t, center, [major3[0], major3[1]], minor, t0, t1, layer, source);
    }

    private bulgedPath(
        t: Affine,
        vertices: readonly { point: Vec2; bulge: number }[],
        closed: boolean,
        layer: string,
        source: string,
    ): void {
        const count = closed ? vertices.length : vertices.length - 1;
        for (let i = 0; i < count; i++) {
            const a = vertices[i];
            const b = vertices[(i + 1) % vertices.length];
            const arc = bulgeArc(a.point, b.point, a.bulge);
            if (arc === undefined) this.line(t, a.point, b.point, layer, source);
            else this.arc(t, arc.center, arc.radius, arc.startAngle, arc.endAngle, layer, source);
        }
    }

    private lwpolyline(record: DxfRecord, t: Affine, layer: string, source: string): void {
        const vertices: { point: [number, number]; bulge: number }[] = [];
        for (const [code, value] of record.groups) {
            if (code === 10) vertices.push({ point: [Number(value), 0], bulge: 0 });
            else if (code === 20 && vertices.length > 0)
                vertices[vertices.length - 1].point[1] = Number(value);
            else if (code === 42 && vertices.length > 0) vertices[vertices.length - 1].bulge = Number(value);
        }
        const local = compose(t, ocs(record, num(record, 38)));
        this.bulgedPath(local, vertices, (num(record, 70) & 1) === 1, layer, source);
    }

    private polylineRecord(record: DxfRecord, t: Affine, layer: string, source: string): void {
        const flags = num(record, 70);
        if ((flags & (16 | 64)) !== 0) {
            this.skip("POLYLINE (mesh)");
            return;
        }
        const closed = (flags & 1) === 1;
        const vertices = record.children
            .filter((vertex) => vertex.type === "VERTEX" && (num(vertex, 70) & 16) === 0)
            .map((vertex) => ({ point: [num(vertex, 10), num(vertex, 20)] as Vec2, bulge: num(vertex, 42) }));
        if ((flags & 8) !== 0) {
            // 3D polyline: WCS points, straight segments.
            const points = vertices.map((vertex) => vertex.point);
            this.polyline(t, closed ? [...points, points[0]] : points, layer, source);
            return;
        }
        this.bulgedPath(compose(t, ocs(record, num(record, 30))), vertices, closed, layer, source);
    }

    private spline(record: DxfRecord, t: Affine, layer: string, source: string): void {
        const degree = num(record, 71, 3);
        const xs = dxfAll(record, 10).map(Number);
        const ys = dxfAll(record, 20).map(Number);
        const controlPoints = xs.map((x, i): Vec2 => [x, ys[i] ?? 0]);
        const tolerance = this.localTolerance(t);
        if (controlPoints.length >= 2) {
            const given = dxfAll(record, 40).map(Number);
            const knots =
                given.length === controlPoints.length + degree + 1
                    ? given
                    : clampedKnots(controlPoints.length, degree);
            const weights = dxfAll(record, 41).map(Number);
            const points = sampleNurbs(
                {
                    degree,
                    knots,
                    controlPoints,
                    weights: weights.length === controlPoints.length ? weights : undefined,
                },
                tolerance,
            );
            this.polyline(t, points, layer, source);
            return;
        }
        const fx = dxfAll(record, 11).map(Number);
        const fy = dxfAll(record, 21).map(Number);
        const fitPoints = fx.map((x, i): Vec2 => [x, fy[i] ?? 0]);
        if (fitPoints.length >= 2) {
            this.polyline(
                t,
                sampleFitPoints(fitPoints, (num(record, 70) & 1) === 1, tolerance),
                layer,
                source,
            );
        }
    }

    private textRecord(record: DxfRecord, t: Affine, layer: string, source: string): void {
        if (record.type === "ATTRIB" && (num(record, 70) & 1) === 1) return;
        const text = decodeDxfText(str(record, 1));
        const height = num(record, 40, 1);
        const angle = radians(num(record, 50));
        const width = text.length * height * 0.6 * num(record, 41, 1);
        const horizontal = num(record, 72);
        const vertical = num(record, record.type === "ATTRIB" ? 74 : 73);
        const p10: Vec2 = [num(record, 10), num(record, 20)];
        const p11: Vec2 = [num(record, 11), num(record, 21)];
        let anchor = p10;
        let dx = width / 2;
        let dy = height / 2;
        if (horizontal !== 0 || vertical !== 0) {
            if (horizontal === 3 || horizontal === 5) {
                // aligned / fit: between the two points
                anchor = [(p10[0] + p11[0]) / 2, (p10[1] + p11[1]) / 2];
                dx = 0;
            } else {
                anchor = p11;
                dx = horizontal === 1 || horizontal === 4 ? 0 : horizontal === 2 ? -width / 2 : width / 2;
            }
            dy = horizontal === 4 || vertical === 2 ? 0 : vertical === 3 ? -height / 2 : height / 2;
        }
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const middle: Vec2 = [anchor[0] + c * dx - s * dy, anchor[1] + s * dx + c * dy];
        this.text(compose(t, ocs(record, num(record, 30))), middle, height, angle, text, layer, source);
    }

    private mtext(record: DxfRecord, t: Affine, layer: string, source: string): void {
        const content = [...dxfAll(record, 3), ...dxfAll(record, 1)].map(String).join("");
        const lines = mtextLines(content).filter((line, i, all) => line.trim() !== "" || i < all.length - 1);
        const height = num(record, 40, 1);
        const directionX = num(record, 11, Number.NaN);
        const angle = Number.isNaN(directionX) ? num(record, 50) : Math.atan2(num(record, 21), directionX);
        const attachment = num(record, 71, 1);
        const step = (5 / 3) * height * num(record, 44, 1);
        const widths = lines.map((line) => line.length * height * 0.6);
        const blockHeight = height + step * (lines.length - 1);
        const column = (attachment - 1) % 3; // 0 left, 1 center, 2 right
        const row = Math.floor((attachment - 1) / 3); // 0 top, 1 middle, 2 bottom
        const top = row === 0 ? 0 : row === 1 ? blockHeight / 2 : blockHeight;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const origin: Vec2 = [num(record, 10), num(record, 20)];
        lines.forEach((line, i) => {
            const x = column === 0 ? widths[i] / 2 : column === 1 ? 0 : -widths[i] / 2;
            const y = top - height / 2 - i * step;
            const middle: Vec2 = [origin[0] + c * x - s * y, origin[1] + s * x + c * y];
            this.text(t, middle, height, angle, line, layer, source);
        });
    }

    private block(name: string): DxfBlock | undefined {
        return (
            this.file.blocks.get(name) ??
            [...this.file.blocks.values()].find((b) => b.name.toUpperCase() === name.toUpperCase())
        );
    }

    private insert(record: DxfRecord, context: Context, layer: string): void {
        const name = str(record, 2);
        const block = this.block(name);
        if (block === undefined) {
            this.skip("INSERT (missing block)");
            return;
        }
        if ((block.flags & 4) !== 0) {
            this.skip("INSERT (external reference)");
            return;
        }
        if (context.blocks.includes(name) || context.blocks.length >= MAX_BLOCK_DEPTH) {
            this.skip("INSERT (recursive)");
            return;
        }
        const sx = num(record, 41, 1);
        const sy = num(record, 42, 1);
        const columns = Math.max(1, num(record, 70, 1));
        const rows = Math.max(1, num(record, 71, 1));
        const base = compose(
            compose(context.transform, ocs(record, num(record, 30))),
            compose(translation(num(record, 10), num(record, 20)), rotation(radians(num(record, 50)))),
        );
        const inner = compose(scaling(sx, sy), translation(-block.base[0], -block.base[1]));
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < columns; c++) {
                const cell = translation(c * num(record, 44), r * num(record, 45));
                this.drawRecords(block.entities, {
                    transform: compose(base, compose(cell, inner)),
                    insertLayer: layer,
                    source: context.source ?? "INSERT",
                    insertColor: this.color,
                    blocks: [...context.blocks, name],
                });
            }
        }
        // Attribute values are placed in world coordinates already.
        for (const attribute of record.children)
            this.entity(attribute, { ...context, insertLayer: layer, insertColor: this.color });
    }

    private dimension(record: DxfRecord, context: Context, layer: string): void {
        const name = str(record, 2);
        const block = name === "" ? undefined : this.block(name);
        if (block === undefined || context.blocks.includes(name)) {
            this.skip("DIMENSION (no block)");
            return;
        }
        // The block holds the dimension as drawn, in world coordinates.
        this.drawRecords(block.entities, {
            transform: compose(context.transform, translation(num(record, 12), num(record, 22))),
            insertLayer: layer,
            source: "DIMENSION",
            insertColor: this.color,
            blocks: [...context.blocks, name],
        });
    }
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

function degrees(radiansValue: number): number {
    const value = ((radiansValue * 180) / Math.PI) % 360;
    const normalized = value < 0 ? value + 360 : value;
    return Math.abs(normalized - 360) < 1e-9 ? 0 : normalized;
}

/** Converts a read DXF file to a drawing in millimetres. */
export function dxfToDrawing(file: DxfFile, options: DrawingImportOptions = {}): ImportedDrawing {
    const units = drawingUnits(file, options.toMm);
    const builder = new DrawingBuilder(
        file,
        options.tolerance ?? 0.01,
        options.paperSpace === true,
        options.hiddenLayers,
    );
    builder.drawRecords(file.entities, { transform: scaling(units.toMm, units.toMm), blocks: [] });
    const layers: DrawingLayer[] = [...builder.usedLayers].map((name) => {
        const info = file.layers.get(name);
        const aci = Math.abs(info?.color ?? 7) || 7;
        const lineType = (info?.lineType ?? "CONTINUOUS").toUpperCase();
        return {
            name,
            aci,
            color: aciColor(aci),
            dashed: !["CONTINUOUS", "BYLAYER", "BYBLOCK", ""].includes(lineType),
        };
    });
    const version = file.header.get("$ACADVER");
    return {
        drawing: { layers, entities: builder.entities },
        sources: builder.sources,
        units,
        ...(typeof version === "string" ? { version } : {}),
        skipped: builder.skipped,
    };
}

/** Reads DXF bytes or text into a drawing in millimetres. */
export function importDxf(
    input: Uint8Array | string,
    options: DrawingImportOptions = {},
): Result<ImportedDrawing> {
    const file = readDxfFile(input);
    if (!file.isOk) return Result.err(file.error);
    return Result.ok(dxfToDrawing(file.value, options));
}
