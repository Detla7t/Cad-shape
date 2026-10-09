// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Stock simulation of a real setup on the real kernel: an 80 × 60 × 20 block with a
 * 40 × 30 pocket 6 deep and two Ø8 through holes, machined by the built-in face, pocket and
 * drill operations with the generic 3-axis machine's tools — the program the post writes,
 * cut into the Rust Z-map.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { EditableShapeNode, type IFace, type IShape, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import {
    CamGenerator,
    type CamOperationData,
    CamStudioNode,
    drillOperation,
    faceOperation,
    machineProfile,
    pocketOperation,
    type SetupData,
    setupSimulationInput,
    setupTools,
    simulateSetup,
} from "../src";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync(path.join(ROOT, "wasm/lib/chili-wasm.wasm")) });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function ok<T>(result: { isOk: boolean; value: T; error: unknown }): T {
    if (!result.isOk) throw new Error(String(result.error));
    return result.value;
}

function defined<T>(value: T | undefined): T {
    expect(value).not.toBeUndefined();
    return value as T;
}

const up = { x: 0, y: 0, z: 1 };

function machinedBlock(): IShape {
    const block = ok(shapeFactory.box(Plane.XY, 80, 60, 20));
    const pocket = ok(
        shapeFactory.box(
            new Plane({ origin: new XYZ(20, 15, 14), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            40,
            30,
            7,
        ),
    );
    const holes = [
        ok(shapeFactory.cylinder(up, { x: 10, y: 10, z: -1 }, 4, 22)),
        ok(shapeFactory.cylinder(up, { x: 70, y: 50, z: -1 }, 4, 22)),
    ];
    return ok(shapeFactory.booleanCut([block], [pocket, ...holes]));
}

function setup() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as unknown as typeof doc.visual;
    const shape = machinedBlock();
    const node = new EditableShapeNode({ document: doc, name: "Block", shape });
    doc.modelManager.addNode(node);
    const floor = (shape.findSubShapes(ShapeTypes.face) as IFace[]).findIndex((face) => {
        const box = face.boundingBox();
        return Math.abs(box.min.z - 14) < 1e-6 && Math.abs(box.max.z - 14) < 1e-6;
    });
    expect(floor).toBeGreaterThanOrEqual(0);
    const machine = defined(machineProfile("generic-3-axis"));
    const base: SetupData = {
        id: "s1",
        name: "Setup 1",
        machineId: "generic-3-axis",
        wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
        stock: { kind: "box", margin: { x: 2, y: 2, zTop: 1, zBottom: 0 } },
        partIds: [node.id],
        operations: [],
    };
    const tools = setupTools(base, machine);
    const tool = (id: string) => tools.find((x) => x.id === id);
    const operations: CamOperationData[] = [
        {
            id: "face",
            type: "face",
            name: "Face",
            toolId: "t1",
            params: faceOperation.defaults(machine, tool("t1")),
        },
        {
            id: "pocket",
            type: "pocket2d",
            name: "Pocket",
            toolId: "t2",
            selection: [{ kind: "face", nodeId: node.id, index: floor }],
            params: pocketOperation.defaults(machine, tool("t2")),
        },
        {
            id: "drill",
            type: "drill",
            name: "Drill",
            toolId: "t4",
            params: drillOperation.defaults(machine, tool("t4")),
        },
    ];
    const studio = new CamStudioNode({ document: doc });
    doc.modelManager.addNode(studio);
    studio.setSetups([{ ...base, operations }]);
    const generator = new CamGenerator(studio, { autoRegenerate: false });
    return { doc, generator };
}

describe("simulating a setup", () => {
    test("face, pocket and drill leave the part, the pocket's corner radii and the stock margins", async () => {
        const { generator } = setup();
        const input = await setupSimulationInput(generator, "s1");
        expect(input.isOk).toBe(true);
        expect(input.value.toolpaths.map((x) => [x.id, x.tool.id])).toEqual([
            ["face", "t1"],
            ["pocket", "t2"],
            ["drill", "t4"],
        ]);
        expect(input.value.stock.min).toEqual([-2, -2, 0]);
        expect(input.value.stock.max).toEqual([82, 62, 21]);
        expect(input.value.part?.indices.length).toBeGreaterThan(0);

        const result = await simulateSetup(generator, "s1", { cellSize: 0.2, regenerate: false });
        expect(result.isOk).toBe(true);
        const simulation = result.value;
        expect(simulation.warnings).toEqual([]);
        const comparison = simulation.comparison();
        expect(comparison?.gougeCells).toBe(0);
        // What remains: the part, the 2 mm margins around it (20 high once faced) and the
        // Ø6 end mill's radius in the pocket's four sharp corners.
        const part = 80 * 60 * 20 - 40 * 30 * 6 - 2 * Math.PI * 16 * 20;
        const margins = (84 * 64 - 80 * 60) * 20;
        const corners = (4 - Math.PI) * 9 * 6;
        const remaining = simulation.volume();
        expect(Math.abs(remaining - (part + margins + corners)) / remaining).toBeLessThan(0.003);
        // The rest in the corners is excess, not a gouge.
        expect((comparison?.excessVolume ?? 0) - margins).toBeGreaterThan(0.5 * corners);

        // Playback: before the drill the holes are still there to cut.
        const drillStart = simulation.firstMoveOf(2);
        simulation.seek(drillStart);
        const holes = 2 * Math.PI * 16 * 20;
        expect(Math.abs(simulation.volume() - remaining - holes) / holes).toBeLessThan(0.015);
        simulation.seek(simulation.moveCount);
        expect(simulation.volume()).toBe(remaining);
        simulation.dispose();
        generator.dispose();
    });

    test("a holder too close to the tip is flagged on the pocket's moves", async () => {
        const { generator } = setup();
        const studio = generator.studio;
        const current = studio.setups[0];
        // The Ø6 end mill with a Ø30 holder 5 above its tip, in a pocket 6 deep.
        const machine = defined(machineProfile("generic-3-axis"));
        const t2 = defined(setupTools(current, machine).find((x) => x.id === "t2"));
        studio.setSetups([
            {
                ...current,
                tools: [{ ...t2, fluteLength: 4, stickout: 5, holder: { diameter: 30, length: 40 } }],
            },
        ]);
        const result = await simulateSetup(generator, "s1", { cellSize: 0.25 });
        expect(result.isOk).toBe(true);
        const kinds = new Set(result.value.warnings.map((w) => `${w.kind}:${w.id}`));
        expect(kinds.has("holderCollision:pocket")).toBe(true);
        expect(kinds.has("gouge:pocket")).toBe(false);
        const holder = defined(result.value.warnings.find((w) => w.kind === "holderCollision"));
        expect(result.value.move(holder.firstMove).id).toBe("pocket");
        expect(holder.depth).toBeGreaterThan(0);
        result.value.dispose();
        generator.dispose();
    });

    test("only mills are simulated", async () => {
        const { generator } = setup();
        generator.studio.setSetups([{ ...generator.studio.setups[0], machineId: "generic-waterjet" }]);
        const result = await setupSimulationInput(generator, "s1");
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("mills");
        generator.dispose();
    });
});
