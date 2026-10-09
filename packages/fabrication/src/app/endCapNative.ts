// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FolderNode, type IDocument, Plane, quoteConfiguredString, Transaction } from "@chili3d/core";
import {
    ConstraintKind,
    MeasuredVariableNode,
    originRef,
    type SketchConstraintData,
    type SketchConstraintRole,
    type SketchData,
    type SketchEntityData,
    SketchNode,
    type SketchPointRef,
} from "@chili3d/parametric";
import type { EndCapParams } from "../endcap/endCap";
import { DUCT_SIZES } from "../endcap/sizes";
import { ensureEndCapConfiguration, END_CAP_INPUT_NAMES as N } from "./endCapConfiguration";

/**
 * The End Cap Configurator as a native Part Studio, built the way the Onshape document is:
 * variable features computed from the configuration (`END_CAP_VARIABLES`), and two fully
 * constrained sketches — "End Cap" and "Reducing End Cap", one suppressed by the Endcap
 * checkbox — whose dimensions are those variables. Nothing regenerates geometry: switching the
 * configuration changes the variables, and the sketch solver moves the constrained geometry.
 *
 * Every rule was read off the Onshape exports (see `endcap/endCap.ts`); the sketches solve to
 * the same flats for every preset (`endCapNative.kernel.test.ts`).
 */

export interface EndCapVariable {
    readonly name: string;
    readonly expression: string;
    readonly description: string;
}

const sizeExpression = (list: string, custom: string) =>
    `configure(${list}, ${[
        ...DUCT_SIZES.map((size) => `${quoteConfiguredString(size.label)}: ${size.inches} in`),
        `${quoteConfiguredString("Custom")}: ${custom}`,
    ].join(", ")})`;

/** The variable features, in dependency order (a variable sees the ones above it). */
export const END_CAP_VARIABLES: readonly EndCapVariable[] = [
    { name: "duct_od", expression: sizeExpression(N.od, N.customOd), description: "Outside diameter (OD)" },
    {
        name: "duct_id",
        expression: sizeExpression(N.id, N.customId),
        description: "Diameter of the smaller duct (ID)",
    },
    { name: "bend_radius", expression: "duct_od / 2", description: "Where the rim folds over the duct" },
    {
        name: "flange",
        expression:
            "duct_od < 5.25 in ? 0.375 in : duct_od < 9.125 in ? 0.5 in : duct_od < 13.375 in ? 0.625 in : duct_od < 18.5 in ? 0.75 in : 1 in",
        description: "Rim allowance beyond the bend, by size",
    },
    { name: "cap_radius", expression: "bend_radius + flange", description: "Cut radius of the half discs" },
    {
        name: "hole_radius",
        expression: "duct_id / 2 - 0.09375 in",
        description: "Hole: 3/32 under the small duct",
    },
    {
        name: "tab_start",
        expression: "duct_id / 2 + 0.03125 in",
        description: "Seam tab starts 1/32 over the small duct",
    },
    { name: "ring", expression: "(duct_od - duct_id) / 2", description: "Width of the reducer's ring" },
    {
        name: "tab",
        expression: "ring < 0.75 in ? ring : 1 in",
        description: "Seam tab height (the ring, when narrow)",
    },
    {
        name: "tab_outer",
        expression: "sqrt(bend_radius * bend_radius - tab * tab) + 0.0625 in",
        description: "Outer tab corner: 1/16 outside the bend circle",
    },
    {
        name: "tab_inner",
        expression: "tab_start + abs(tab_outer - bend_radius)",
        description: "Inner tab corner leans out as the outer moved",
    },
    { name: "seam_tab", expression: "1 in", description: "Plain cap's seam tab height" },
    {
        name: "tab_end",
        expression: "sqrt(bend_radius * bend_radius - seam_tab * seam_tab) - 0.0625 in",
        description: "Plain cap's tab corner: 1/16 inside the bend circle",
    },
    {
        name: "default_wall",
        expression: "duct_od <= 7.125 in ? 2.125 in : 2.875 in",
        description: "Collar wall height unless set (by OD)",
    },
    {
        name: "wall",
        expression: `configure(${N.wall}, true: ${N.finishWall}, false: default_wall)`,
        description: "Collar finish wall height",
    },
    { name: "collar_height", expression: "wall + 0.8125 in", description: "Collar strip height" },
    {
        name: "rolled",
        expression: "pi / 2 * (duct_id + 0.125 in)",
        description: "Half circumference of the collar",
    },
    {
        name: "collar_length",
        expression: "rolled + 0.03125 in + duct_id / 156",
        description: "Plain collar strip length",
    },
    {
        name: "lap_length",
        expression: "rolled + 2 in",
        description: "Lapped collar strip length (1 in each end)",
    },
    {
        name: "lap_band",
        expression: "max(0 in, wall - 0.687 in)",
        description: "Lap height (0.687 as typed in the Onshape sketch)",
    },
];

/** The configured suppression of each sketch: "End Cap" shows for Endcap, "Reducing End Cap" otherwise. */
export const END_CAP_SUPPRESSION = {
    plain: `configure(${N.endcap}, true: false, false: true)`,
    reducing: `configure(${N.endcap}, true: true, false: false)`,
} as const;

type Point = readonly [number, number];
const MM = 25.4;

/** Builds sketch data entity by entity, constraint by constraint, in millimetres. */
class SketchBuilder {
    private readonly entities: SketchEntityData[] = [];
    private readonly constraints: SketchConstraintData[] = [];
    private nextEntity = 1;
    private nextConstraint = 1;

    line(a: Point, b: Point): number {
        const id = this.nextEntity++;
        this.entities.push({ id, type: "line", params: [a[0] * MM, a[1] * MM, b[0] * MM, b[1] * MM] });
        return id;
    }

    /** A counter-clockwise arc from `start` to `end` degrees (inches in). */
    arc(center: Point, radius: number, start: number, end: number, construction = false): number {
        const id = this.nextEntity++;
        const at = (deg: number) => [
            (center[0] + radius * Math.cos((deg * Math.PI) / 180)) * MM,
            (center[1] + radius * Math.sin((deg * Math.PI) / 180)) * MM,
        ];
        this.entities.push({
            id,
            type: "arc",
            params: [center[0] * MM, center[1] * MM, ...at(start), ...at(end)],
            ...(construction ? { construction: true } : {}),
        });
        // The structural constraint the editor gives every arc: its end stays on the circle.
        this.add(ConstraintKind.PointOnArc, [p(id, 2), p(id, 0), p(id, 1)]);
        return id;
    }

    add(
        kind: ConstraintKind,
        refs: SketchPointRef[],
        extra: { datum?: string; role?: SketchConstraintRole } = {},
    ) {
        this.constraints.push({ id: this.nextConstraint++, kind, refs, ...extra });
    }

    coincident(a: SketchPointRef, b: SketchPointRef) {
        this.add(ConstraintKind.P2PCoincident, [a, b]);
    }

    horizontal(line: number) {
        this.add(ConstraintKind.Horizontal, [p(line, 0), p(line, 1)]);
    }

    vertical(line: number) {
        this.add(ConstraintKind.Vertical, [p(line, 0), p(line, 1)]);
    }

    /** `x(b) − x(a) = expression` */
    dx(a: SketchPointRef, b: SketchPointRef, expression: string) {
        this.add(ConstraintKind.HorizontalDistance, [a, b], { datum: expression });
    }

    /** `y(b) − y(a) = expression` */
    dy(a: SketchPointRef, b: SketchPointRef, expression: string) {
        this.add(ConstraintKind.VerticalDistance, [a, b], { datum: expression });
    }

    radius(arc: number, expression: string) {
        this.add(ConstraintKind.Radius, [p(arc, 0)], { datum: expression });
    }

    concentric(a: number, b: number) {
        this.add(ConstraintKind.P2PCoincident, [p(a, 0), p(b, 0)], { role: "concentric" });
    }

    /** The point lies on the (infinite) line. */
    onLine(point: SketchPointRef, line: number) {
        this.add(ConstraintKind.PointOnLine, [point, p(line, 0), p(line, 1)]);
    }

    data(): SketchData {
        return {
            entities: this.entities,
            constraints: this.constraints,
            entityIdSeq: this.nextEntity,
        };
    }
}

const p = (entityId: number, pointIndex: number): SketchPointRef => ({ entityId, pointIndex });
/** Arc points: 0 center, 1 start, 2 end. */
const center = (arc: number) => p(arc, 0);
const start = (arc: number) => p(arc, 1);
const end = (arc: number) => p(arc, 2);

/**
 * A half disc hanging below its center line: outer cut arc, optional hole arc, and the rim's
 * bend arc (construction), concentric, their radii the variables. Returns the arcs; the caller
 * closes the straight edge.
 */
function halfDisc(b: SketchBuilder, cy: number, radii: { cap: number; bend: number; hole?: number }) {
    const outer = b.arc([0, cy], radii.cap, 180, 360);
    const bend = b.arc([0, cy], radii.bend, 180, 360, true);
    const hole = radii.hole === undefined ? undefined : b.arc([0, cy], radii.hole, 180, 360);
    b.concentric(bend, outer);
    if (hole !== undefined) b.concentric(hole, outer);
    b.radius(outer, "cap_radius");
    b.radius(bend, "bend_radius");
    if (hole !== undefined) b.radius(hole, "hole_radius");
    return { outer, bend, hole };
}

/** A chain of lines through `points` (inches); consecutive lines share their joint. */
function chain(b: SketchBuilder, points: readonly Point[]): number[] {
    const lines: number[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
        const line = b.line(points[i], points[i + 1]);
        if (lines.length) b.coincident(p(lines[lines.length - 1], 1), p(line, 0));
        lines.push(line);
    }
    return lines;
}

/** Geometry of the default configuration, where each sketch starts (it then solves from there). */
function defaults(params: EndCapParams) {
    const od = params.od;
    const id = params.id ?? 0;
    const bend = od / 2;
    const flange = od < 5.25 ? 0.375 : od < 9.125 ? 0.5 : od < 13.375 ? 0.625 : od < 18.5 ? 0.75 : 1;
    const ring = (od - id) / 2;
    const tab = ring < 0.75 ? ring : 1;
    const tabStart = id / 2 + 0.03125;
    const tabOuter = Math.sqrt(bend * bend - tab * tab) + 0.0625;
    const wall = params.wallHeight ?? (od <= 7.125 ? 2.125 : 2.875);
    const height = wall + 0.8125;
    const rolled = (Math.PI / 2) * (id + 0.125);
    return {
        od,
        bend,
        cap: bend + flange,
        hole: id / 2 - 0.09375,
        tab,
        tabStart,
        tabOuter,
        tabInner: tabStart + Math.abs(tabOuter - bend),
        tabEnd: Math.sqrt(bend * bend - 1) - 0.0625,
        height,
        collar: rolled + 0.03125 + id / 156,
        lap: rolled + 2,
        band: Math.max(0, wall - 0.687),
    };
}

/** "Reducing End Cap": the two half rings with the lap seam, and the two collar strips. */
export function reducingEndCapSketch(
    initial: EndCapParams = { reducing: true, od: 9.625, id: 6.625 },
): SketchData {
    const g = defaults(initial);
    const b = new SketchBuilder();
    const origin = originRef();

    // ---- Half without the seam: center on the origin
    const a = halfDisc(b, 0, { cap: g.cap, bend: g.bend, hole: g.hole });
    b.coincident(center(a.outer), origin);
    // left edge: cap → bend → hole; right edge: hole → bend → cap
    const [la1, la2] = chain(b, [
        [-g.cap, 0],
        [-g.bend, 0],
        [-g.hole, 0],
    ]);
    const [ra1, ra2] = chain(b, [
        [g.hole, 0],
        [g.bend, 0],
        [g.cap, 0],
    ]);
    b.coincident(start(a.outer), p(la1, 0));
    b.coincident(end(a.bend), p(ra1, 1));
    b.coincident(start(a.bend), p(la1, 1));
    b.coincident(p(la2, 1), start(a.hole!));
    b.coincident(end(a.hole!), p(ra1, 0));
    b.coincident(p(ra2, 1), end(a.outer));
    for (const line of [la1, la2, ra1, ra2]) b.horizontal(line);
    b.onLine(center(a.outer), la1);
    b.onLine(center(a.outer), ra2);

    // ---- Half with the lap seam: center straight above, the OD up
    const cy = g.od;
    const s = halfDisc(b, cy, { cap: g.cap, bend: g.bend, hole: g.hole });
    b.dy(origin, center(s.outer), "duct_od");
    b.dx(origin, center(s.outer), "0 in");
    const side = (sign: 1 | -1) => {
        // cap → bend, up the tab, across, down to the tab start, over to the hole
        const lines = chain(b, [
            [sign * g.cap, cy],
            [sign * g.bend, cy],
            [sign * g.tabOuter, cy + g.tab],
            [sign * g.tabInner, cy + g.tab],
            [sign * g.tabStart, cy],
            [sign * g.hole, cy],
        ]);
        const [rim, , top, , inner] = lines;
        b.coincident(sign > 0 ? end(s.outer) : start(s.outer), p(rim, 0));
        b.coincident(sign > 0 ? end(s.bend) : start(s.bend), p(rim, 1));
        b.coincident(p(inner, 1), sign > 0 ? end(s.hole!) : start(s.hole!));
        b.horizontal(rim);
        b.horizontal(top);
        b.horizontal(inner);
        b.onLine(center(s.outer), rim);
        b.onLine(center(s.outer), inner);
        const x = (expression: string) => (sign > 0 ? expression : `-(${expression})`);
        b.dy(center(s.outer), p(top, 0), "tab");
        b.dx(center(s.outer), p(top, 0), x("tab_outer"));
        b.dx(center(s.outer), p(top, 1), x("tab_inner"));
        b.dx(center(s.outer), p(inner, 0), x("tab_start"));
    };
    side(1);
    side(-1);

    // ---- Collar strips (the walls), centered on the axis above the halves
    const y1 = g.od + 2 * g.height;
    const [c1, c2, c3, c4] = chain(b, [
        [-g.collar / 2, y1],
        [g.collar / 2, y1],
        [g.collar / 2, y1 + g.height],
        [-g.collar / 2, y1 + g.height],
        [-g.collar / 2, y1],
    ]);
    b.coincident(p(c4, 1), p(c1, 0));
    b.horizontal(c1);
    b.horizontal(c3);
    b.vertical(c2);
    b.vertical(c4);
    b.dy(origin, p(c1, 0), "duct_od + 2 * collar_height");
    b.dx(origin, p(c1, 1), "collar_length / 2");
    b.dx(p(c1, 0), p(c1, 1), "collar_length");
    b.dy(p(c2, 0), p(c2, 1), "collar_height");

    const y2 = g.od + 4 * g.height;
    const yb = y2 + g.band;
    const lap = chain(b, [
        [-g.lap / 2, y2],
        [g.lap / 2, y2],
        [g.lap / 2, yb],
        [g.collar / 2, yb],
        [g.collar / 2, y2 + g.height],
        [-g.collar / 2, y2 + g.height],
        [-g.collar / 2, yb],
        [-g.lap / 2, yb],
        [-g.lap / 2, y2],
    ]);
    b.coincident(p(lap[7], 1), p(lap[0], 0));
    for (const [i, line] of lap.entries()) i % 2 === 0 ? b.horizontal(line) : b.vertical(line);
    b.dy(origin, p(lap[0], 0), "duct_od + 4 * collar_height");
    b.dx(origin, p(lap[0], 0), "-(lap_length / 2)");
    b.dx(origin, p(lap[0], 1), "lap_length / 2");
    b.dy(p(lap[1], 0), p(lap[1], 1), "lap_band");
    b.dy(p(lap[0], 0), p(lap[6], 1), "lap_band");
    b.dx(origin, p(lap[3], 0), "collar_length / 2");
    b.dx(origin, p(lap[5], 0), "-(collar_length / 2)");
    b.dy(p(lap[3], 0), p(lap[3], 1), "collar_height - lap_band");
    return b.data();
}

/** "End Cap": the two plain half discs, the second with its 1 in lap seam tab. */
export function plainEndCapSketch(initial: EndCapParams = { reducing: false, od: 9.625 }): SketchData {
    const g = defaults(initial);
    const b = new SketchBuilder();
    const origin = originRef();

    const a = halfDisc(b, 0, { cap: g.cap, bend: g.bend });
    b.coincident(center(a.outer), origin);
    const [l1, l2, l3] = chain(b, [
        [-g.cap, 0],
        [-g.bend, 0],
        [g.bend, 0],
        [g.cap, 0],
    ]);
    b.coincident(start(a.outer), p(l1, 0));
    b.coincident(start(a.bend), p(l1, 1));
    b.coincident(end(a.bend), p(l2, 1));
    b.coincident(p(l3, 1), end(a.outer));
    for (const line of [l1, l2, l3]) b.horizontal(line);
    b.onLine(center(a.outer), l2);

    const cy = g.od + 1;
    const s = halfDisc(b, cy, { cap: g.cap, bend: g.bend });
    b.dy(origin, center(s.outer), "duct_od + seam_tab");
    b.dx(origin, center(s.outer), "0 in");
    // The tab's top edge is two lines meeting on the axis, as the Onshape sketch drew it.
    const [rimL, , topL, topR, , rimR] = chain(b, [
        [-g.cap, cy],
        [-g.bend, cy],
        [-g.tabEnd, cy + 1],
        [0, cy + 1],
        [g.tabEnd, cy + 1],
        [g.bend, cy],
        [g.cap, cy],
    ]);
    b.coincident(start(s.outer), p(rimL, 0));
    b.coincident(start(s.bend), p(rimL, 1));
    b.coincident(end(s.bend), p(rimR, 0));
    b.coincident(p(rimR, 1), end(s.outer));
    for (const line of [rimL, topL, topR, rimR]) b.horizontal(line);
    b.onLine(center(s.outer), rimL);
    b.onLine(center(s.outer), rimR);
    b.dy(center(s.outer), p(topL, 0), "seam_tab");
    b.dx(center(s.outer), p(topL, 0), "-(tab_end)");
    b.dx(center(s.outer), p(topL, 1), "0 in");
    b.dx(center(s.outer), p(topR, 1), "tab_end");
    return b.data();
}

export interface NativeEndCap {
    readonly variables: readonly MeasuredVariableNode[];
    readonly plain: SketchNode;
    readonly reducing: SketchNode;
}

/**
 * Adds the End Cap Configurator to `document` as one undo step, the way the Onshape Part
 * Studio is built: its configuration inputs, a "Variables" folder of variable features, and
 * the "End Cap" and "Reducing End Cap" sketches, each suppressed in the other's configuration.
 * Variables the document already has (a second end cap) are reused, not redefined.
 */
export function addNativeEndCap(document: IDocument): NativeEndCap {
    let added: NativeEndCap | undefined;
    Transaction.execute(document, "End Cap", () => {
        ensureEndCapConfiguration(document);
        const scope = document.variables.evaluate().scope;
        const variables = END_CAP_VARIABLES.every((variable) => scope.has(variable.name))
            ? []
            : END_CAP_VARIABLES.map(
                  (variable) =>
                      new MeasuredVariableNode({
                          document,
                          definition: {
                              name: variable.name,
                              description: variable.description,
                              source: "assigned",
                              expression: variable.expression,
                              mode: "length",
                              entities: [],
                          },
                      }),
              );
        if (variables.length > 0) {
            const folder = new FolderNode({ document, name: "Variables" });
            folder.add(...variables);
            document.modelManager.addNode(folder);
        }
        const sketch = (name: string, data: SketchData, suppression: string) => {
            const node = new SketchNode({ document, plane: Plane.XY, data });
            node.name = name;
            node.suppression = suppression;
            document.modelManager.addNode(node);
            return node;
        };
        const plain = sketch("End Cap", plainEndCapSketch(), END_CAP_SUPPRESSION.plain);
        const reducing = sketch("Reducing End Cap", reducingEndCapSketch(), END_CAP_SUPPRESSION.reducing);
        // Solve both for the document's configuration now (a second cap may be added to a
        // document set to another size).
        for (const node of [...variables, plain, reducing]) node.applyVariables();
        added = { variables, plain, reducing };
    });
    return added!;
}
