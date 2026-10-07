// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommitKind, GraphRow } from "@chili3d/core";

const SVG_NS = "http://www.w3.org/2000/svg";
const LANE = 14;
const PAD = 9;
/** The dot sits on the row's first text line. */
const DOT_Y = 14;
/** How far below the dot an edge to another lane reaches that lane. */
const BEND = 12;

/** Lane colors by branch index — readable on both themes. */
export const LANE_COLORS = [
    "#3b82f6",
    "#e8590c",
    "#2f9e44",
    "#ae3ec9",
    "#f08c00",
    "#0c8599",
    "#d6336c",
    "#74b816",
];

export const laneColor = (index: number) => LANE_COLORS[index % LANE_COLORS.length];

export function graphColumnWidth(lanes: number): number {
    return PAD * 2 + (lanes - 1) * LANE;
}

function element<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
}

const x = (lane: number) => PAD + lane * LANE;

/**
 * One row of the version graph: lines for the lanes crossing the row, edges into and out of the
 * commit, and its dot — a filled dot for a microversion, a diamond for a version, a ring for a
 * merge; the checked-out head gets a halo. Lines run to `100%` so an expanded row keeps the
 * lanes connected.
 */
export function graphCell(
    row: GraphRow,
    lanes: number,
    kind: CommitKind,
    isHead: boolean,
    className: string,
): HTMLElement {
    // The SVG is absolutely positioned in a column that stretches with the row, so it takes
    // the row's height instead of imposing the default 150 px of an unsized SVG.
    const width = graphColumnWidth(lanes);
    const svg = element("svg", { width, height: "100%" });
    const column = document.createElement("div");
    column.className = className;
    column.style.width = `${width}px`;
    column.append(svg);
    const line = (x1: number, y1: number | string, x2: number, y2: number | string, color: number) =>
        svg.append(
            element("line", {
                x1,
                y1,
                x2,
                y2,
                stroke: laneColor(color),
                "stroke-width": 2,
                "stroke-linecap": "round",
            }),
        );
    for (const edge of row.through) line(x(edge.from), 0, x(edge.to), "100%", edge.color);
    for (const edge of row.above) line(x(edge.from), 0, x(edge.to), DOT_Y, edge.color);
    for (const edge of row.below) {
        if (edge.from === edge.to) {
            line(x(edge.from), DOT_Y, x(edge.to), "100%", edge.color);
        } else {
            line(x(edge.from), DOT_Y, x(edge.to), DOT_Y + BEND, edge.color);
            line(x(edge.to), DOT_Y + BEND, x(edge.to), "100%", edge.color);
        }
    }

    const cx = x(row.lane);
    const color = laneColor(row.color);
    if (isHead) {
        svg.append(
            element("circle", {
                cx,
                cy: DOT_Y,
                r: 7,
                fill: "none",
                stroke: color,
                "stroke-width": 1.5,
                opacity: 0.6,
            }),
        );
    }
    if (kind === "version") {
        svg.append(
            element("rect", {
                x: cx - 4,
                y: DOT_Y - 4,
                width: 8,
                height: 8,
                fill: color,
                transform: `rotate(45 ${cx} ${DOT_Y})`,
            }),
        );
    } else if (kind === "merge") {
        svg.append(
            element("circle", {
                cx,
                cy: DOT_Y,
                r: 4.5,
                fill: "var(--background-color)",
                stroke: color,
                "stroke-width": 2.5,
            }),
        );
    } else {
        svg.append(element("circle", { cx, cy: DOT_Y, r: 3.5, fill: color }));
    }
    return column;
}
