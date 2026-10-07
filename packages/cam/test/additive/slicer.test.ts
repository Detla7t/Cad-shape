// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    camOperation,
    expandPrusaMacros,
    extrusionArea,
    extrusionSpacing,
    machineProfile,
    type PrusaConfig,
    parsePrinterGcode,
    postProcessor,
    printerConfigOf,
    prusaMacroScope,
    resolvePrusaJob,
    type SliceResult,
    slicePrint,
    type ToolpathMove,
} from "../../src";
import {
    areaMm2 as areaMm2Of,
    bounds,
    islands as islandsOf,
    signedArea as signedAreaOf,
} from "../../src/additive/geometry/polygons";
import { unescapeString } from "../../src/additive/prusa/values";
import { ok, printerContext } from "./context";
import { boxMesh, cylinderMesh, mergeMeshes } from "./meshes";

const BED = "0x0,200x0,200x200,0x200";
const FILAMENT_AREA = (Math.PI * 1.75 ** 2) / 4;

/** A plain config: 0.2 mm layers, 0.45 mm lines, 3 perimeters, 4 top / 3 bottom layers. */
const PLAIN: PrusaConfig = {
    bed_shape: BED,
    max_print_height: "200",
    layer_height: "0.2",
    first_layer_height: "0.2",
    perimeters: "3",
    top_solid_layers: "4",
    bottom_solid_layers: "3",
    top_solid_min_thickness: "0",
    bottom_solid_min_thickness: "0",
    extrusion_width: "0.45",
    perimeter_extrusion_width: "0.45",
    external_perimeter_extrusion_width: "0.45",
    infill_extrusion_width: "0.45",
    solid_infill_extrusion_width: "0.45",
    top_infill_extrusion_width: "0.45",
    first_layer_extrusion_width: "0.42",
    elefant_foot_compensation: "0",
    fill_density: "20%",
    fill_pattern: "rectilinear",
    skirts: "1",
    skirt_distance: "2",
    min_skirt_length: "0",
    retract_length: "0.8",
    retract_before_travel: "1.5",
    retract_lift: "0.2",
    start_gcode: "G28 ; home\\nG1 Z5 F3000",
    end_gcode: "M104 S0\\nM84",
};

const slice = (mesh = boxMesh(90, 90, 0, 110, 110, 10), config: PrusaConfig = PLAIN) =>
    ok(slicePrint(mesh, config, { placement: "keep" }));

const box = (paths: SliceResult["layers"][number]["slices"]) => {
    const b = bounds(paths);
    if (!b) throw new Error("empty region");
    return [b.minX / 1000, b.minY / 1000, b.maxX / 1000, b.maxY / 1000];
};

interface Segment {
    readonly layer: number;
    readonly role: string;
    readonly from: readonly number[];
    readonly move: Extract<ToolpathMove, { kind: "extrude" }>;
    readonly length: number;
}

/** Every extrusion with its layer, feature and length (positions tracked through travels). */
function extrusions(moves: readonly ToolpathMove[]): Segment[] {
    const out: Segment[] = [];
    let layer = -1;
    let role = "";
    let at: readonly number[] | undefined;
    for (const move of moves) {
        if (move.kind === "comment") {
            if (move.text === "LAYER_CHANGE") layer++;
            if (move.text.startsWith("TYPE:")) role = move.text.slice(5);
        } else if (move.kind === "raw") at = undefined;
        else if (move.kind === "rapid" || move.kind === "extrude") {
            if (move.kind === "extrude" && at) {
                const length = Math.hypot(move.to[0] - at[0], move.to[1] - at[1]);
                out.push({ layer, role, from: at, move, length });
            }
            at = move.to;
        }
    }
    return out;
}

describe("built-in slicer: a 20 × 20 × 10 box", () => {
    const result = slice();

    test("0.2 mm layers give 50 layers topped at the box height", () => {
        expect(result.layers).toHaveLength(50);
        expect(result.layers[0].z).toBeCloseTo(0.2, 9);
        expect(result.layers[49].z).toBeCloseTo(10, 9);
        expect(result.layers.every((layer) => Math.abs(layer.height - 0.2) < 1e-9)).toBe(true);
        expect(
            result.toolpath.moves.filter((m) => m.kind === "comment" && m.text === "LAYER_CHANGE"),
        ).toHaveLength(50);
        expect(result.stats.layers).toBe(50);
    });

    test("every layer is one square island, the box's own outline", () => {
        for (const layer of result.layers) {
            expect(layer.slices).toHaveLength(1);
            expect(box(layer.slices)).toEqual([90, 90, 110, 110]);
        }
    });

    test("perimeters sit at exact offsets: half a width, then one spacing each", () => {
        const s = extrusionSpacing(0.45, 0.2);
        expect(s).toBeCloseTo(0.45 - 0.2 * (1 - Math.PI / 4), 12);
        const layer = result.layers[10];
        const insets = [0.225, 0.225 + s, 0.225 + 2 * s];
        expect(layer.perimeters.map((loop) => loop.depth)).toEqual([0, 1, 2]);
        layer.perimeters.forEach((loop, k) => {
            const [x0, y0, x1, y1] = box([loop.path]);
            for (const [value, expected] of [
                [x0, 90 + insets[k]],
                [y0, 90 + insets[k]],
                [x1, 110 - insets[k]],
                [y1, 110 - insets[k]],
            ]) {
                expect(value).toBeCloseTo(expected, 3);
            }
            expect(loop.path).toHaveLength(4);
            expect(loop.hole).toBe(false);
        });
        // The first layer's perimeters use the first-layer width.
        const first = result.layers[0].perimeters;
        expect(box([first[0].path])[0]).toBeCloseTo(90.21, 3);
        expect(box([first[1].path])[0]).toBeCloseTo(90.21 + extrusionSpacing(0.42, 0.2), 3);
    });

    test("3 bottom and 4 top layers are solid, the ones between sparse", () => {
        const solid = (i: number) => {
            const layer = result.layers[i];
            return areaMm2Of([...layer.solid, ...layer.top, ...layer.bridge]);
        };
        const sparse = (i: number) => areaMm2Of(result.layers[i].sparse);
        const fullySolid = result.layers.map((l) => l.index).filter((i) => sparse(i) === 0 && solid(i) > 0);
        expect(fullySolid).toEqual([0, 1, 2, 46, 47, 48, 49]);
        for (let i = 3; i <= 45; i++) {
            expect(solid(i)).toBe(0);
            expect(sparse(i)).toBeCloseTo(areaMm2Of(result.layers[i].fill), 6);
        }
        expect(areaMm2Of(result.layers[49].top)).toBeCloseTo(areaMm2Of(result.layers[49].fill), 6);
        expect(areaMm2Of(result.layers[48].top)).toBe(0);
        // The fill area starts half a spacing (less 10 % overlap) inside the innermost perimeter.
        const s = extrusionSpacing(0.45, 0.2);
        const inner = 0.225 + 2 * s + s / 2 - 0.1 * s;
        expect(box(result.layers[10].fill)[0]).toBeCloseTo(90 + inner, 2);
    });

    test("filament per mm is the extrusion cross-section over the filament area", () => {
        const segments = extrusions(result.toolpath.moves).filter((s) => s.length > 0.5);
        const perLayer = (layer: number, role: string) =>
            segments.filter((s) => s.layer === layer && s.role === role);
        const external = perLayer(10, "External perimeter");
        const infill = perLayer(10, "Internal infill");
        const firstLayer = perLayer(0, "External perimeter");
        expect(external.length).toBeGreaterThan(3);
        expect(infill.length).toBeGreaterThan(5);
        expect(firstLayer.length).toBeGreaterThan(3);
        const ratio = extrusionArea(0.45, 0.2) / FILAMENT_AREA;
        expect(ratio).toBeCloseTo((0.2 * (0.45 - 0.2 * (1 - Math.PI / 4))) / FILAMENT_AREA, 12);
        for (const s of [...external, ...infill]) expect(s.move.extrude / s.length).toBeCloseTo(ratio, 9);
        for (const s of firstLayer)
            expect(s.move.extrude / s.length).toBeCloseTo(extrusionArea(0.42, 0.2) / FILAMENT_AREA, 9);
    });

    test("sparse layers alternate the rectilinear angle; solid layers fill at the line spacing", () => {
        const segments = extrusions(result.toolpath.moves).filter((s) => s.length > 2);
        const angle = (s: Segment) => {
            const a = (Math.atan2(s.move.to[1] - s.from[1], s.move.to[0] - s.from[0]) * 180) / Math.PI;
            return ((a % 180) + 180) % 180;
        };
        // Share of a layer's infill length running at an angle (connectors run along the walls).
        const share = (layer: number, degrees: number) => {
            const infill = segments.filter((s) => s.layer === layer && s.role === "Internal infill");
            const total = infill.reduce((sum, s) => sum + s.length, 0);
            const along = infill
                .filter((s) => Math.abs(angle(s) - degrees) < 0.5)
                .reduce((sum, s) => sum + s.length, 0);
            return along / total;
        };
        expect(share(10, 45)).toBeGreaterThan(0.8);
        expect(share(11, 135)).toBeGreaterThan(0.8);
        expect(share(10, 135)).toBeLessThan(0.1);
        // Solid infill: ~ fill area / spacing of line length.
        const solidLength = segments
            .filter((s) => s.layer === 1 && s.role === "Solid infill")
            .reduce((sum, s) => sum + s.length, 0);
        const expected = areaMm2Of(result.layers[1].fill) / extrusionSpacing(0.45, 0.2);
        expect(solidLength / expected).toBeGreaterThan(0.9);
        expect(solidLength / expected).toBeLessThan(1.1);
    });

    test("long travels are retracted (with z-hop), extrusions never run retracted", () => {
        let retracted = false;
        let at: readonly number[] | undefined;
        let longTravels = 0;
        for (const move of result.toolpath.moves) {
            if (move.kind === "raw") at = undefined;
            if (move.kind === "extrude") {
                const moved = at !== undefined && Math.hypot(move.to[0] - at[0], move.to[1] - at[1]) > 1e-9;
                if (!moved && move.extrude < 0) retracted = true;
                else if (!moved && move.extrude > 0) retracted = false;
                else expect(retracted).toBe(false);
                at = move.to;
            } else if (move.kind === "rapid") {
                if (at && Math.hypot(move.to[0] - at[0], move.to[1] - at[1]) > 1.5) {
                    longTravels++;
                    expect(retracted).toBe(true);
                    expect(move.to[2]).toBeCloseTo(
                        result.layers.find((l) => l.z >= move.to[2] - 0.2 - 1e-6)!.z + 0.2,
                        6,
                    );
                }
                at = move.to;
            }
        }
        expect(longTravels).toBeGreaterThan(50);
    });

    test("perimeters print inside out by default, outside in with external_perimeters_first", () => {
        const order = (moves: readonly ToolpathMove[]) =>
            extrusions(moves)
                .filter((s) => s.layer === 10 && s.role.includes("erimeter"))
                .map((s) => s.role)
                .filter((role, i, all) => i === 0 || all[i - 1] !== role);
        expect(order(result.toolpath.moves)).toEqual(["Perimeter", "External perimeter"]);
        const outsideIn = slice(boxMesh(90, 90, 0, 110, 110, 10), {
            ...PLAIN,
            external_perimeters_first: "1",
        });
        expect(order(outsideIn.toolpath.moves)).toEqual(["External perimeter", "Perimeter"]);
        // Aligned seams: every layer's external loop starts at the same corner.
        const seams = new Set<string>();
        for (let layer = 1; layer < 50; layer++) {
            const first = extrusions(result.toolpath.moves).find(
                (s) => s.layer === layer && s.role === "External perimeter",
            );
            seams.add(`${first?.from[0]},${first?.from[1]}`);
        }
        expect(seams.size).toBe(1);
    });

    test("no skirt without skirt loops, even with a minimum skirt length", () => {
        const none = slice(boxMesh(90, 90, 0, 110, 110, 1), {
            ...PLAIN,
            skirts: "0",
            min_skirt_length: "50",
        });
        expect(none.skirt).toEqual([]);
        const long = slice(boxMesh(90, 90, 0, 110, 110, 1), {
            ...PLAIN,
            skirts: "1",
            min_skirt_length: "50",
        });
        // Loops are added until they feed 50 mm of filament: one fewer would not.
        const fed = long.skirt.map((loop) => {
            let length = 0;
            for (let i = 0; i < loop.length; i++) {
                const a = loop[i];
                const b = loop[(i + 1) % loop.length];
                length += Math.hypot(b.x - a.x, b.y - a.y) / 1000;
            }
            return (length * extrusionArea(0.42, 0.2)) / FILAMENT_AREA;
        });
        const total = fed.reduce((a, b) => a + b, 0);
        expect(long.skirt.length).toBeGreaterThan(5);
        expect(total).toBeGreaterThanOrEqual(50);
        expect(total - Math.min(...fed)).toBeLessThan(50);
    });

    test("a skirt loop goes around the first layer at the skirt distance", () => {
        expect(result.skirt).toHaveLength(1);
        const [x0, y0, x1, y1] = box(result.skirt);
        const d = 2 + 0.21;
        expect([x0, y0, x1, y1].map((v) => Math.round(v * 1000) / 1000)).toEqual([
            90 - d,
            90 - d,
            110 + d,
            110 + d,
        ]);
        expect(extrusions(result.toolpath.moves).some((s) => s.layer === 0 && s.role === "Skirt/Brim")).toBe(
            true,
        );
        expect(extrusions(result.toolpath.moves).some((s) => s.layer === 1 && s.role === "Skirt/Brim")).toBe(
            false,
        );
    });

    test("print time and filament estimates add up", () => {
        const fed = result.toolpath.moves.reduce((sum, m) => sum + (m.kind === "extrude" ? m.extrude : 0), 0);
        // The first retraction after raw start code is raw itself (the position is unknown).
        expect(result.stats.filamentMm).toBeCloseTo(fed - 0.8, 6);
        expect(result.stats.filamentCm3).toBeCloseTo((result.stats.filamentMm * FILAMENT_AREA) / 1000, 9);
        expect(result.stats.filamentGrams).toBeCloseTo(result.stats.filamentCm3 * 1.24, 9);
        // Shell + 20 % infill of a 4 cm³ box: well under its volume, well over its skin.
        expect(result.stats.filamentCm3).toBeGreaterThan(1);
        expect(result.stats.filamentCm3).toBeLessThan(3);
        expect(result.stats.seconds).toBeGreaterThan(5 * 60);
        expect(result.stats.seconds).toBeLessThan(60 * 60);
        const footer = result.toolpath.moves
            .filter((m) => m.kind === "comment")
            .map((m) => (m as { text: string }).text);
        expect(footer).toContain(`filament used [mm] = ${result.stats.filamentMm.toFixed(2)}`);
        expect(footer.some((text) => text.startsWith("estimated printing time (normal mode) = "))).toBe(true);
    });
});

describe("built-in slicer: shapes", () => {
    test("a cylinder slices to circles; its perimeters are concentric circles", () => {
        const result = slice(cylinderMesh(100, 100, 10, 0, 6, 128));
        expect(result.layers).toHaveLength(30);
        for (const layer of result.layers) {
            expect(layer.slices).toHaveLength(1);
            for (const p of layer.slices[0]) {
                // On the circle, or on a facet's chord (the quads' diagonals), to the 1 µm grid.
                const r = Math.hypot(p.x / 1000 - 100, p.y / 1000 - 100);
                expect(r).toBeLessThan(10 + 1.5e-3);
                expect(r).toBeGreaterThan(10 * Math.cos(Math.PI / 128) - 1.5e-3);
            }
            expect(areaMm2Of(layer.slices)).toBeCloseTo(Math.PI * 100, -0.5);
        }
        const external = result.layers[5].perimeters.find((loop) => loop.depth === 0)!;
        for (const p of external.path) {
            expect(Math.abs(Math.hypot(p.x / 1000 - 100, p.y / 1000 - 100) - (10 - 0.225))).toBeLessThan(
                2e-3,
            );
        }
    });

    test("a tube's hole is a hole: one island, perimeters inside and out", () => {
        const outer = cylinderMesh(100, 100, 10, 0, 4, 96);
        const inner = cylinderMesh(100, 100, 5, 0, 4, 96);
        // Turn the inner cylinder inside out: it bounds the material from inside.
        const flipped = { positions: inner.positions, indices: inner.indices.slice() };
        for (let t = 0; t < flipped.indices.length; t += 3) {
            [flipped.indices[t + 1], flipped.indices[t + 2]] = [
                flipped.indices[t + 2],
                flipped.indices[t + 1],
            ];
        }
        const result = slice(mergeMeshes(outer, flipped));
        const layer = result.layers[8];
        const islands = islandsOf(layer.slices);
        expect(islands).toHaveLength(1);
        expect(islands[0].holes).toHaveLength(1);
        expect(areaMm2Of(layer.slices)).toBeCloseTo(Math.PI * (100 - 25), -0.5);
        const holeLoop = layer.perimeters.find((loop) => loop.depth === 0 && loop.hole)!;
        expect(signedAreaOf(holeLoop.path)).toBeLessThan(0);
        for (const p of holeLoop.path) {
            expect(Math.abs(Math.hypot(p.x / 1000 - 100, p.y / 1000 - 100) - (5 + 0.225))).toBeLessThan(3e-3);
        }
    });

    test("an inside-out mesh slices like a proper one", () => {
        const mesh = boxMesh(90, 90, 0, 110, 110, 2);
        const reversed = { positions: mesh.positions, indices: mesh.indices.slice().reverse() };
        expect(box(slice(reversed).layers[3].slices)).toEqual([90, 90, 110, 110]);
    });

    test("a brim of 3 mm lays whole loops, the skirt goes around it", () => {
        const result = slice(boxMesh(90, 90, 0, 110, 110, 2), { ...PLAIN, brim_width: "3" });
        const s = extrusionSpacing(0.42, 0.2);
        const loops = Math.floor(3 / s);
        expect(result.brim).toHaveLength(loops);
        const outermost = 0.21 + (loops - 1) * s;
        expect(box(result.brim)[0]).toBeCloseTo(90 - outermost, 3);
        expect(box(result.skirt)[0]).toBeCloseTo(90 - outermost - 2 - 0.21, 3);
    });

    test("supports hold an overhang: columns below it, a gap under it, clear of the part", () => {
        const pillar = boxMesh(95, 95, 0, 105, 105, 20);
        const slab = boxMesh(80, 95, 15, 120, 105, 20);
        const result = slice(mergeMeshes(pillar, slab), { ...PLAIN, support_material: "1" });
        const support = (i: number) => result.layers[i].support;
        // The slab starts in layer 75 (cut at z 15.1); one contact layer stays empty below it.
        expect(areaMm2Of(support(74).area) + areaMm2Of(support(74).interface)).toBe(0);
        expect(areaMm2Of(support(73).interface)).toBeGreaterThan(100);
        expect(areaMm2Of(support(72).interface)).toBeGreaterThan(100);
        expect(areaMm2Of(support(71).interface)).toBe(0);
        expect(areaMm2Of(support(10).area)).toBeGreaterThan(200);
        const [x0, , x1] = box(support(10).area);
        expect(x0).toBeGreaterThanOrEqual(80 - 1e-3);
        expect(x1).toBeLessThanOrEqual(120 + 1e-3);
        // Clear of the pillar by the XY gap (60 % of 0.45 mm).
        for (const path of support(10).area) {
            for (const p of path)
                expect(p.x / 1000 <= 95 - 0.27 + 1e-3 || p.x / 1000 >= 105 + 0.27 - 1e-3).toBe(true);
        }
        expect(
            extrusions(result.toolpath.moves).some((s) => s.role === "Support material" && s.layer === 10),
        ).toBe(true);
        expect(extrusions(result.toolpath.moves).some((s) => s.role === "Support material interface")).toBe(
            true,
        );
        // Without supports nothing is generated.
        expect(slice(mergeMeshes(pillar, slab)).layers.every((l) => l.support.area.length === 0)).toBe(true);
    });

    test.each(["grid", "gyroid", "concentric"])("%s sparse infill fills sparse layers", (pattern) => {
        const result = slice(boxMesh(90, 90, 0, 110, 110, 3), {
            ...PLAIN,
            fill_pattern: pattern,
            top_solid_layers: "1",
            bottom_solid_layers: "1",
        });
        const infill = extrusions(result.toolpath.moves).filter(
            (s) => s.layer === 5 && s.role === "Internal infill",
        );
        const length = infill.reduce((sum, s) => sum + s.length, 0);
        const area = areaMm2Of(result.layers[5].sparse);
        // About density × area / spacing of line (gyroid and grid are not exact).
        const expected = (0.2 * area) / extrusionSpacing(0.45, 0.2);
        expect(length / expected).toBeGreaterThan(0.7);
        expect(length / expected).toBeLessThan(1.4);
        for (const s of infill) {
            for (const v of [s.move.to[0], s.move.to[1]]) {
                expect(v).toBeGreaterThan(90);
                expect(v).toBeLessThan(110);
            }
        }
    });

    test("parts are placed on the bed: dropped to z = 0 and centred when off the bed", () => {
        const result = ok(slicePrint(boxMesh(-50, -50, 5, -30, -30, 7), PLAIN));
        expect(result.translation).toEqual([140, 140, -5]);
        expect(box(result.layers[0].slices)).toEqual([90, 90, 110, 110]);
        expect(result.layers).toHaveLength(10);
        const tooBig = slicePrint(boxMesh(0, 0, 0, 250, 20, 5), PLAIN);
        expect(tooBig.isOk).toBe(false);
        expect(tooBig.error).toContain("do not fit");
        const tooTall = slicePrint(boxMesh(0, 0, 0, 20, 20, 250), PLAIN);
        expect(tooTall.error).toContain("tall");
    });
});

describe("built-in slicer: printer profiles and G-code", () => {
    const job = (machineId: string) => ok(resolvePrusaJob(machineProfile(machineId)!, {}));

    test("the program starts with the printer's start G-code and stays on the bed (Ender-3, Marlin)", () => {
        const machine = machineProfile("creality-ender-3")!;
        const config = job("creality-ender-3").config;
        const result = ok(slicePrint(boxMesh(0, 0, 0, 20, 20, 10), config));
        const firstRaw = result.toolpath.moves.find((m) => m.kind === "raw") as { code: string };
        const start = expandPrusaMacros(
            unescapeString(printerConfigOf(machine)["start_gcode"]),
            prusaMacroScope(config, { layer_num: 0 }),
        );
        expect(start.errors).toEqual([]);
        expect(firstRaw.code).toBe(start.text);
        expect(start.text).toContain("M140 S60 ; heat the bed");
        expect(start.text).toContain("M109 S215 ; wait for the nozzle");
        const gcode = ok(
            postProcessor("marlin")!.post({
                name: "box",
                machine,
                setup: printerContext("creality-ender-3", boxMesh(0, 0, 0, 1, 1, 1)).setup,
                tools: new Map(),
                toolpaths: [result.toolpath],
            }),
        );
        const lines = gcode.split("\n");
        const startAt = gcode.indexOf(start.text);
        expect(startAt).toBeGreaterThan(0);
        expect(startAt).toBeLessThan(gcode.indexOf(";LAYER_CHANGE"));
        const before = gcode
            .slice(0, startAt)
            .split("\n")
            .filter((line) => line.trim() !== "");
        expect(before.every((line) => line.startsWith(";") || /^(G21|G90|M83)\b/.test(line))).toBe(true);
        expect(lines).toContain("M83 ; relative extrusion");
        // Every position the printer is sent to is on its 220 × 220 bed, under 250 mm.
        const parsed = parsePrinterGcode(gcode);
        expect(parsed.moves.length).toBeGreaterThan(1000);
        for (const move of parsed.moves) {
            if (move.kind !== "rapid" && move.kind !== "extrude") continue;
            expect(move.to[0]).toBeGreaterThanOrEqual(0);
            expect(move.to[1]).toBeGreaterThanOrEqual(0);
            expect(move.to[0]).toBeLessThanOrEqual(220);
            expect(move.to[1]).toBeLessThanOrEqual(220);
            expect(move.to[2]).toBeLessThanOrEqual(250);
        }
        // In the bed's corner the skirt would leave the bed: the part was centred.
        expect(result.translation).toEqual([100, 100, 0]);
        expect(result.warnings).toEqual([]);
        expect(gcode).toContain("M84 X Y E ; motors off");
    });

    test("Prusa jobs emit the machine limits first and change temperatures after the first layer", () => {
        const config = job("prusa-mk4s").config;
        const result = ok(slicePrint(boxMesh(100, 90, 0, 120, 110, 1), config));
        const raws = result.toolpath.moves
            .filter((m) => m.kind === "raw")
            .map((m) => (m as { code: string }).code);
        expect(raws[0]).toContain("M201 X4000 Y4000");
        expect(raws[0]).toContain("M203 X400 Y400 Z12 E120");
        expect(raws[1].startsWith('M862.3 P "MK4S" ; printer model check\nM862.1 P0.4')).toBe(true);
        expect(raws).toContain("M104 S210 ; nozzle temperature");
        // PLA's fan stays off on the first layer, then runs.
        const fan = raws.filter((code) => /^M10[67]/.test(code));
        expect(fan[0]).toBe("M107");
        expect(fan[1]).toBe("M106 S255");
        // The end G-code's macros lift by 10 mm above the last layer.
        expect(raws.some((code) => code.startsWith("G1 Z11 F720 ; lift away from the print"))).toBe(true);
    });

    test("a Klipper start macro gets the bed temperature emitted before it (autoemit)", () => {
        const result = ok(slicePrint(boxMesh(100, 100, 0, 120, 120, 1), job("voron-2-4-350").config));
        const raws = result.toolpath.moves
            .filter((m) => m.kind === "raw")
            .map((m) => (m as { code: string }).code);
        expect(raws[0]).toBe("M190 S60 ; set bed temperature and wait");
        expect(raws[1].startsWith("PRINT_START BED=60 EXTRUDER=215")).toBe(true);
        expect(raws.some((code) => code.startsWith("M104 S215 ; set nozzle"))).toBe(false);
        expect(raws[raws.length - 1]).toBe("PRINT_END ; the printer's end macro");
    });

    test("the slice operation turns a setup into a toolpath with the job's presets", async () => {
        const handler = camOperation("slice")!;
        expect(handler.machineKinds).toEqual(["printer"]);
        expect(handler.category).toBe("additive");
        const machine = machineProfile("prusa-mk3s")!;
        const defaults = handler.defaults(machine);
        expect(defaults).toMatchObject({ printPreset: "0.20mm QUALITY", filamentPreset: "Generic PLA" });
        const context = printerContext("prusa-mk3s", boxMesh(100, 90, 0, 120, 110, 4));
        const operation = {
            id: "op",
            type: "slice",
            name: "Print box",
            params: { ...defaults, perimeters: 4, infillDensity: 30 },
        };
        const toolpath = ok(await handler.generate(operation, context));
        expect(toolpath.label).toBe("Print box");
        expect(toolpath.toolId).toBe("nozzle-0.4");
        expect(toolpath.moves.filter((m) => m.kind === "comment" && m.text === "LAYER_CHANGE")).toHaveLength(
            20,
        );
        expect(toolpath.moves).toContainEqual({ kind: "comment", text: "print: 0.20mm QUALITY" });
        const perimeters = new Set(
            extrusions(toolpath.moves)
                .filter((s) => s.layer === 10 && (s.role === "Perimeter" || s.role === "External perimeter"))
                .map((s) => `${s.role}`),
        );
        expect(perimeters.size).toBe(2);
        const params = handler.parameters(operation).map((p) => p.key);
        expect(params).toEqual(
            expect.arrayContaining([
                "printPreset",
                "filamentPreset",
                "layerHeight",
                "infillDensity",
                "supports",
            ]),
        );
        const tooBig = await handler.generate(
            operation,
            printerContext("prusa-mk3s", boxMesh(0, 0, 0, 300, 10, 4)),
        );
        expect(tooBig.isOk).toBe(false);
    });
});
