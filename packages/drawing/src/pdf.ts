// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Drawing, type DrawingLayer, drawingBounds, type Point2, unitScale } from "./drawing";

export interface PdfOptions {
    /** The document's title. */
    readonly title?: string;
    /** Margin around the drawing, drawing units; 5 mm when absent. */
    readonly margin?: number;
    /** Stroke width, drawing units; 0.25 mm when absent. */
    readonly strokeWidth?: number;
}

const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;
/** Helvetica's cap height as a share of the font size: a drawing's text height is a cap height. */
const CAP_HEIGHT = 0.72;
/** Helvetica's average advance as a share of the font size, for centring. */
const ADVANCE = 0.55;

const f = (n: number) => String(Math.round(n * 1000) / 1000);

/** A CSS `#rrggbb` colour as PDF's 0–1 components; black otherwise. */
function rgb(color: string): [number, number, number] {
    const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
    if (!match) return [0, 0, 0];
    const value = Number.parseInt(match[1], 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** A PDF string: parentheses and backslashes escaped, Latin-1 as octal escapes, the rest as `?`. */
function pdfString(text: string): string {
    let out = "";
    for (const char of text) {
        const code = char.codePointAt(0) ?? 63;
        if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
        else if (code >= 32 && code < 127) out += char;
        else if (code < 256) out += `\\${code.toString(8).padStart(3, "0")}`;
        else out += "?";
    }
    return out;
}

/** The counter-clockwise sweep from `start` to `end`, degrees in (0, 360]. */
function sweepOf(start: number, end: number): number {
    const sweep = (((end - start) % 360) + 360) % 360;
    return sweep === 0 ? 360 : sweep;
}

/**
 * A vector PDF of the drawing, true to scale: one page the size of the drawing's bounds plus
 * a margin (1 mm = 72/25.4 pt, 1 in = 72 pt), each layer in its colour, lines and arcs as
 * paths (arcs as cubic Béziers of at most 90°), text in Helvetica. PDF 1.4, uncompressed,
 * self-contained — every reader opens it.
 */
export function writePdf(drawing: Drawing, options: PdfOptions = {}): Uint8Array {
    const mmPerUnit = unitScale(drawing.units);
    const perMm = 1 / mmPerUnit;
    /** Points per drawing unit. */
    const scale = (POINTS_PER_INCH / MM_PER_INCH) * mmPerUnit;
    const margin = options.margin ?? 5 * perMm;
    const strokeWidth = options.strokeWidth ?? 0.25 * perMm;
    const bounds = drawingBounds(drawing) ?? { min: [0, 0] as Point2, max: [0, 0] as Point2 };
    const width = (bounds.max[0] - bounds.min[0] + 2 * margin) * scale;
    const height = (bounds.max[1] - bounds.min[1] + 2 * margin) * scale;
    const px = (u: number) => (u - bounds.min[0] + margin) * scale;
    const py = (v: number) => (v - bounds.min[1] + margin) * scale;
    const layers = new Map(drawing.layers.map((layer) => [layer.name, layer]));
    const ops: string[] = [`${f(strokeWidth * scale)} w 1 J 1 j`];
    let current: DrawingLayer | undefined | null = null;
    const useLayer = (name: string) => {
        const layer = layers.get(name);
        if (layer === current) return;
        current = layer;
        const [r, g, b] = rgb(layer?.color ?? "#000000");
        ops.push(`${f(r)} ${f(g)} ${f(b)} RG ${f(r)} ${f(g)} ${f(b)} rg`);
        ops.push(layer?.dashed ? `[${f(2 * perMm * scale)} ${f(perMm * scale)}] 0 d` : "[] 0 d");
    };
    const arc = (center: Point2, radius: number, start: number, sweep: number): string => {
        const parts: string[] = [];
        const pieces = Math.max(1, Math.ceil(sweep / 90));
        const step = (sweep / pieces) * (Math.PI / 180);
        const k = (4 / 3) * Math.tan(step / 4);
        let a0 = start * (Math.PI / 180);
        const at = (a: number): Point2 => [
            center[0] + radius * Math.cos(a),
            center[1] + radius * Math.sin(a),
        ];
        const p0 = at(a0);
        parts.push(`${f(px(p0[0]))} ${f(py(p0[1]))} m`);
        for (let i = 0; i < pieces; i++) {
            const a1 = a0 + step;
            const [s0, s1] = [at(a0), at(a1)];
            const c1: Point2 = [s0[0] - k * radius * Math.sin(a0), s0[1] + k * radius * Math.cos(a0)];
            const c2: Point2 = [s1[0] + k * radius * Math.sin(a1), s1[1] - k * radius * Math.cos(a1)];
            parts.push(
                `${f(px(c1[0]))} ${f(py(c1[1]))} ${f(px(c2[0]))} ${f(py(c2[1]))} ${f(px(s1[0]))} ${f(py(s1[1]))} c`,
            );
            a0 = a1;
        }
        return parts.join("\n");
    };
    for (const entity of drawing.entities) {
        useLayer(entity.layer);
        switch (entity.kind) {
            case "line":
                ops.push(
                    `${f(px(entity.a[0]))} ${f(py(entity.a[1]))} m ${f(px(entity.b[0]))} ${f(py(entity.b[1]))} l S`,
                );
                break;
            case "circle":
                ops.push(arc(entity.center, entity.radius, 0, 360), "h S");
                break;
            case "arc":
                ops.push(
                    arc(
                        entity.center,
                        entity.radius,
                        entity.startAngle,
                        sweepOf(entity.startAngle, entity.endAngle),
                    ),
                    "S",
                );
                break;
            case "text": {
                const size = (entity.height / CAP_HEIGHT) * scale;
                const theta = entity.rotation * (Math.PI / 180);
                const [cos, sin] = [Math.cos(theta), Math.sin(theta)];
                const halfWidth = (ADVANCE * size * entity.text.length) / 2;
                const halfHeight = (entity.height * scale) / 2;
                // the anchor is the middle of the text: step back half its width along the
                // baseline and half its cap height across it
                const tx = px(entity.position[0]) - halfWidth * cos + halfHeight * sin;
                const ty = py(entity.position[1]) - halfWidth * sin - halfHeight * cos;
                ops.push(
                    `BT /F1 ${f(size)} Tf ${f(cos)} ${f(sin)} ${f(-sin)} ${f(cos)} ${f(tx)} ${f(ty)} Tm (${pdfString(entity.text)}) Tj ET`,
                );
                break;
            }
        }
    }
    const content = ops.join("\n");
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(width)} ${f(height)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        `<< /Producer (Chili3D)${options.title ? ` /Title (${pdfString(options.title)})` : ""} >>`,
    ];
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(out.length);
        out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    // every character is Latin-1 (text was escaped), so a byte per code unit keeps the offsets true
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
    return bytes;
}
