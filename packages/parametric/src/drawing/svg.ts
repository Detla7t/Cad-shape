// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    arcSweep,
    type Drawing,
    type DrawingEntity,
    drawingBounds,
    formatNumber as f,
    type Point2,
} from "./drawing";

/**
 * SVG at true scale: the page is sized in millimetres and one user unit is one
 * millimetre, so a printout or a laser cutter reproduces the drawing exactly. The drawing's
 * y axis points up (CAD convention); the writer flips it into SVG's downward y. Each layer
 * is a group (an Inkscape layer).
 */

export interface SvgOptions {
    /** White space around the drawing, mm. */
    readonly margin?: number;
    /** Stroke width, mm. */
    readonly strokeWidth?: number;
    readonly title?: string;
}

const escapeXml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function writeSvg(drawing: Drawing, options: SvgOptions = {}): string {
    const margin = options.margin ?? 5;
    const strokeWidth = options.strokeWidth ?? 0.25;
    const bounds = drawingBounds(drawing) ?? { min: [0, 0] as Point2, max: [0, 0] as Point2 };
    const width = bounds.max[0] - bounds.min[0] + 2 * margin;
    const height = bounds.max[1] - bounds.min[1] + 2 * margin;
    const x = (u: number) => u - bounds.min[0] + margin;
    const y = (v: number) => bounds.max[1] - v + margin;
    const at = (p: Point2) => [x(p[0]), y(p[1])] as const;

    const element = (entity: DrawingEntity, color: string): string => {
        switch (entity.kind) {
            case "line": {
                const [x1, y1] = at(entity.a);
                const [x2, y2] = at(entity.b);
                return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
            }
            case "circle": {
                const [cx, cy] = at(entity.center);
                return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(entity.radius)}"/>`;
            }
            case "arc": {
                const sweep = arcSweep(entity.startAngle, entity.endAngle);
                const [cx, cy] = at(entity.center);
                if (sweep >= 360) return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(entity.radius)}"/>`;
                const point = (deg: number) =>
                    at([
                        entity.center[0] + entity.radius * Math.cos((deg * Math.PI) / 180),
                        entity.center[1] + entity.radius * Math.sin((deg * Math.PI) / 180),
                    ]);
                const [sx, sy] = point(entity.startAngle);
                const [ex, ey] = point(entity.endAngle);
                const r = f(entity.radius);
                // Counter-clockwise with y up is counter-clockwise on screen: sweep-flag 0.
                return `<path d="M ${f(sx)} ${f(sy)} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 0 ${f(ex)} ${f(ey)}"/>`;
            }
            case "text": {
                const [tx, ty] = at(entity.position);
                const rotation =
                    entity.rotation === 0
                        ? ""
                        : ` transform="rotate(${f(-entity.rotation)} ${f(tx)} ${f(ty)})"`;
                return (
                    `<text x="${f(tx)}" y="${f(ty)}" font-size="${f(entity.height)}" fill="${color}" stroke="none"` +
                    ` text-anchor="middle" dominant-baseline="middle"${rotation}>${escapeXml(entity.text)}</text>`
                );
            }
        }
    };

    const groups = drawing.layers
        .map((layer) => {
            const items = drawing.entities.filter((entity) => entity.layer === layer.name);
            if (items.length === 0) return "";
            const dash =
                layer.dashed === true
                    ? ` stroke-dasharray="${f(strokeWidth * 16)} ${f(strokeWidth * 8)}"`
                    : "";
            const name = escapeXml(layer.name);
            return [
                `  <g id="${name}" inkscape:groupmode="layer" inkscape:label="${name}" fill="none" stroke="${layer.color}" stroke-width="${f(strokeWidth)}"${dash}>`,
                ...items.map((entity) => `    ${element(entity, layer.color)}`),
                "  </g>",
            ].join("\n");
        })
        .filter((group) => group.length > 0);

    return [
        `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"` +
            ` width="${f(width)}mm" height="${f(height)}mm" viewBox="0 0 ${f(width)} ${f(height)}">`,
        ...(options.title === undefined ? [] : [`  <title>${escapeXml(options.title)}</title>`]),
        `  <desc>Units: millimetres (1 user unit = 1 mm). Written by Chili3D.</desc>`,
        ...groups,
        "</svg>",
        "",
    ].join("\n");
}
