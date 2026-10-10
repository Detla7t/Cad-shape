// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Assemblies on real geometry: a 40×40×10 base plate and a Ø10×20 pin from the Part Studio,
 * mate connectors inferred from picked faces, every mate type solved, over-constraint
 * detected, connectors re-anchored after a part edit, BOM counts (flattened and through a
 * sub-assembly), the placed-instance STEP export read back, and how the version history sees
 * an assembly.
 */

import { BoxNode, CylinderNode } from "@chili3d/app";
import {
    type FolderNode,
    type IFace,
    type IShape,
    NodeUtils,
    Plane,
    Serializer,
    ShapeNode,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@chili3d/core";
import { arrayToRigid, axisAngle, rigidToArray, type Vec3 } from "../src/math/rigid";
import { AssemblyNode } from "../src/model/assemblyNode";
import type { MateConnectorData, MateData } from "../src/model/assemblyTypes";
import { bomToCsv, buildBom } from "../src/model/bom";
import { connectorFromSubShape, inferConnector, subShapesOf } from "../src/model/connectors";
import { evaluateAssembly, type PlacedPart } from "../src/model/evaluate";
import { exportAssemblyShapes } from "../src/model/export";
import { insertInstance } from "../src/model/insert";
import { reanchorMates, solveAssembly } from "../src/model/solve";
import type { MateType } from "../src/solver/mateSolver";
import "../src/versioning";
import {
    createApp,
    initKernel,
    installService,
    MemoryStorage,
    newDocument,
    type SavableDocument,
    settle,
    versioned,
} from "./helpers";

beforeAll(initKernel);

const PIN_VOLUME = (dz: number) => Math.PI * 25 * dz;
const BASE_VOLUME = 40 * 40 * 10;

/** The index of the face of `shape` whose outward normal is `normal` at height `z`. */
function planarFace(shape: IShape, normal: Vec3, z: number): number {
    const faces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex((face) => {
        if (!face.surface().isPlanar()) return false;
        const [point, n] = face.normal(0, 0);
        const unit = n.normalize()!;
        return (
            Math.abs(point.z - z) < 1e-6 &&
            Math.abs(unit.x - normal[0]) < 1e-6 &&
            Math.abs(unit.y - normal[1]) < 1e-6 &&
            Math.abs(unit.z - normal[2]) < 1e-6
        );
    });
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
}

function cylindricalFace(shape: IShape): number {
    const faces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex((face) => !face.surface().isPlanar());
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
}

describe("assemblies (kernel)", () => {
    let doc: SavableDocument;
    let base: BoxNode;
    let pin: CylinderNode;
    let assembly: AssemblyNode;

    beforeEach(async () => {
        const storage = new MemoryStorage();
        const app = createApp(storage);
        installService(storage, app);
        doc = newDocument(app, "assembly-doc", "Fixture");
        base = new BoxNode({ document: doc, plane: Plane.XY, dx: 40, dy: 40, dz: 10 });
        pin = new CylinderNode({ document: doc, normal: XYZ.unitZ, center: XYZ.zero, radius: 5, dz: 20 });
        assembly = new AssemblyNode({ document: doc, name: "Assembly 1" });
        Transaction.execute(doc, "parts", () => {
            base.name = "Base";
            pin.name = "Pin";
            doc.modelManager.addNode(base, pin, assembly);
        });
    });

    function parts(): readonly PlacedPart[] {
        return evaluateAssembly(doc, assembly).parts;
    }

    function partOf(instanceId: string): PlacedPart {
        const part = parts().find((p) => p.instanceId === instanceId);
        expect(part).toBeDefined();
        return part!;
    }

    function connector(instanceId: string, face: (shape: IShape) => number): MateConnectorData {
        const part = partOf(instanceId);
        const index = face(part.shape);
        const faces = subShapesOf(part.shape, "face");
        const result = connectorFromSubShape(part, faces[index], index);
        expect(result).toBeDefined();
        return result!;
    }

    /** Base (fixed) and a pin dropped at a skewed placement. */
    function placeBoth() {
        const baseInstance = insertInstance(assembly, { kind: "part", nodeId: base.id }, "Base");
        const skew = { r: axisAngle([0.6, 0, 0.8], 0.9), t: [70, -30, 25] as Vec3 };
        const pinInstance = insertInstance(assembly, { kind: "part", nodeId: pin.id }, "Pin", {
            transform: rigidToArray(skew),
        });
        expect(assembly.instance(baseInstance.id)!.grounded).toBe(true);
        expect(assembly.instance(pinInstance.id)!.grounded).toBeUndefined();
        return { baseId: baseInstance.id, pinId: pinInstance.id };
    }

    function mate(type: MateType, a: MateConnectorData, b: MateConnectorData, id = `${type}-1`): MateData {
        return { id, name: id, type, a, b };
    }

    test("a face-to-face fastened mate seats the pin on the plate", () => {
        const { baseId, pinId } = placeBoth();
        const top = connector(baseId, (s) => planarFace(s, [0, 0, 1], 10));
        const bottom = connector(pinId, (s) => planarFace(s, [0, 0, -1], 0));
        expect(top.entity?.inference).toBe("planarFace");
        expect(top.origin).toEqual([expect.closeTo(20, 6), expect.closeTo(20, 6), expect.closeTo(10, 6)]);
        expect(bottom.zAxis[2]).toBeCloseTo(-1, 9);

        assembly.addMate(mate("fastened", top, bottom));
        const result = solveAssembly(assembly);
        expect(result.status).toBe("solved");
        expect(result.dof).toBe(0);
        const box = partOf(pinId).shape.transformed(partOf(pinId).placement).boundingBox();
        expect(box.min.z).toBeCloseTo(10, 5);
        expect(box.max.z).toBeCloseTo(30, 5);
        expect((box.min.x + box.max.x) / 2).toBeCloseTo(20, 2);
        expect((box.min.y + box.max.y) / 2).toBeCloseTo(20, 2);
        // Exactly: the placed pin's bottom face is centered on the plate's top face.
        const placed = partOf(pinId).shape.transformedMul(partOf(pinId).placement);
        const seated = planarFace(placed, [0, 0, -1], 10);
        const frame = inferConnector(subShapesOf(placed, "face")[seated])!.frame;
        expect(frame.origin).toEqual([expect.closeTo(20, 6), expect.closeTo(20, 6), expect.closeTo(10, 6)]);
    });

    test.each([
        ["fastened", 0],
        ["revolute", 1],
        ["slider", 1],
        ["planar", 3],
        ["ball", 3],
    ] as const)("%s on picked faces leaves %i DOF", (type, dof) => {
        const { baseId, pinId } = placeBoth();
        const top = connector(baseId, (s) => planarFace(s, [0, 0, 1], 10));
        const bottom = connector(pinId, (s) => planarFace(s, [0, 0, -1], 0));
        assembly.addMate(mate(type, top, bottom));
        const result = solveAssembly(assembly);
        expect(result.failingMates).toEqual([]);
        expect(result.mates[0].residual).toBeLessThan(1e-6);
        expect(result.instanceDof.get(pinId)).toBe(dof);
    });

    test("cylindrical on the pin's axis: it turns and slides along the plate normal", () => {
        const { baseId, pinId } = placeBoth();
        const top = connector(baseId, (s) => planarFace(s, [0, 0, 1], 10));
        const axis = connector(pinId, cylindricalFace);
        expect(axis.entity?.inference).toBe("cylindricalFace");
        expect(Math.abs(axis.zAxis[2])).toBeCloseTo(1, 9);
        assembly.addMate(mate("cylindrical", top, axis));
        const result = solveAssembly(assembly);
        expect(result.status).toBe("solved");
        expect(result.dof).toBe(2);
        // The pin's axis now runs through the plate's center.
        const box = partOf(pinId).shape.transformed(partOf(pinId).placement).boundingBox();
        expect((box.min.x + box.max.x) / 2).toBeCloseTo(20, 2);
        expect((box.min.y + box.max.y) / 2).toBeCloseTo(20, 2);
    });

    test("a contradicting second mate is reported; removing it solves again", () => {
        const { baseId, pinId } = placeBoth();
        const top = connector(baseId, (s) => planarFace(s, [0, 0, 1], 10));
        const bottom = connector(pinId, (s) => planarFace(s, [0, 0, -1], 0));
        const pinTop = connector(pinId, (s) => planarFace(s, [0, 0, 1], 20));
        assembly.setMates([mate("fastened", top, bottom, "m1"), mate("fastened", top, pinTop, "m2")]);
        const result = solveAssembly(assembly);
        expect(result.status).toBe("conflicting");
        expect(result.overConstrained).toBe(true);
        expect(result.failingMates.length).toBeGreaterThan(0);
        assembly.removeMates(["m2"]);
        expect(solveAssembly(assembly).status).toBe("solved");
    });

    test("the picked point chooses among a face's candidate origins, kept when re-anchoring", () => {
        const { baseId, pinId } = placeBoth();
        const part = partOf(baseId);
        const index = planarFace(part.shape, [0, 0, 1], 10);
        const top = subShapesOf(part.shape, "face")[index];
        const at = (point: Vec3) => connectorFromSubShape(part, top, index, point)!;
        // Near a corner → the vertex; near an edge's middle → its midpoint; inside → the centroid.
        expect(at([38, 37, 10]).origin).toEqual([
            expect.closeTo(40, 9),
            expect.closeTo(40, 9),
            expect.closeTo(10, 9),
        ]);
        expect(at([38, 37, 10]).entity?.anchor?.kind).toBe("vertex");
        expect(at([21, 39, 10]).origin).toEqual([
            expect.closeTo(20, 9),
            expect.closeTo(40, 9),
            expect.closeTo(10, 9),
        ]);
        expect(at([21, 39, 10]).entity?.anchor?.kind).toBe("edgeMid");
        expect(at([22, 18, 10]).entity?.anchor).toEqual({ kind: "centroid" });

        // The pin's cylinder face: on the axis, at the ring nearest the pick.
        const pinPart = partOf(pinId);
        const side = cylindricalFace(pinPart.shape);
        const lateral = subShapesOf(pinPart.shape, "face")[side];
        const nearTop = pinPart.placement.ofPoint({ x: 5, y: 0, z: 19 });
        const ring = connectorFromSubShape(pinPart, lateral, side, [nearTop.x, nearTop.y, nearTop.z])!;
        expect(ring.entity?.anchor?.kind).toBe("circleCenter");
        expect(ring.origin).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9), expect.closeTo(20, 9)]);

        // A corner connector stays on its corner when the plate grows.
        const corner = at([38, 37, 10]);
        assembly.addMate(mate("ball", corner, ring));
        Transaction.execute(doc, "wider", () => {
            base.dx = 50;
        });
        expect(reanchorMates(assembly, evaluateAssembly(doc, assembly))).toBe(1);
        expect(assembly.mates[0].a.origin).toEqual([
            expect.closeTo(50, 9),
            expect.closeTo(40, 9),
            expect.closeTo(10, 9),
        ]);
    });

    test("mate connectors follow a part edit", () => {
        const { baseId, pinId } = placeBoth();
        const top = connector(baseId, (s) => planarFace(s, [0, 0, 1], 10));
        const pinTop = connector(pinId, (s) => planarFace(s, [0, 0, 1], 20));
        // Face to face on its top face: the pin stands upside down on the plate.
        assembly.addMate(mate("fastened", top, pinTop));
        solveAssembly(assembly);
        Transaction.execute(doc, "longer pin", () => {
            pin.dz = 30;
        });
        const moved = reanchorMates(assembly, evaluateAssembly(doc, assembly));
        expect(moved).toBe(1);
        expect(assembly.mates[0].b.origin[2]).toBeCloseTo(30, 6);
        expect(solveAssembly(assembly).status).toBe("solved");
        const box = partOf(pinId).shape.transformed(partOf(pinId).placement).boundingBox();
        expect(box.max.z - box.min.z).toBeCloseTo(30, 5);
        expect(box.min.z).toBeCloseTo(10, 5);
    });

    test("BOM counts parts flattened and instances structured; CSV escapes", () => {
        insertInstance(assembly, { kind: "part", nodeId: base.id }, "Base");
        for (let i = 0; i < 3; i++) insertInstance(assembly, { kind: "part", nodeId: pin.id }, "Pin");
        const rows = buildBom(evaluateAssembly(doc, assembly));
        expect(rows.map((r) => [r.name, r.quantity])).toEqual([
            ["Base", 1],
            ["Pin", 3],
        ]);
        expect(assembly.instances.map((x) => x.name)).toEqual(["Base <1>", "Pin <1>", "Pin <2>", "Pin <3>"]);
        // Repeated instances are laid out side by side, not stacked.
        const xs = assembly.instances.slice(1).map((x) => x.transform[12]);
        expect(new Set(xs).size).toBe(3);

        const top = new AssemblyNode({ document: doc, name: 'Top, "final"' });
        Transaction.execute(doc, "top", () => doc.modelManager.addNode(top));
        insertInstance(top, { kind: "assembly", nodeId: assembly.id }, "Assembly 1");
        insertInstance(top, { kind: "part", nodeId: pin.id }, "Pin");
        const flattened = buildBom(evaluateAssembly(doc, top));
        expect(flattened.map((r) => [r.name, r.quantity])).toEqual([
            ["Base", 1],
            ["Pin", 4],
        ]);
        const structured = buildBom(evaluateAssembly(doc, top), { structured: true });
        expect(structured.map((r) => [r.name, r.quantity])).toEqual([
            ["Assembly 1", 1],
            ["Pin", 1],
        ]);
        const csv = bomToCsv([{ ...structured[0], name: top.name }]);
        expect(csv).toBe('Item,Name,Source,Quantity\r\n1,"Top, ""final""",This document,1\r\n');

        // An assembly cannot contain itself.
        insertInstance(assembly, { kind: "assembly", nodeId: top.id }, "Top");
        const cyclic = evaluateAssembly(doc, top).instances[0];
        expect(cyclic.status).toBe("error");
    });

    test("STEP export writes every placed solid", () => {
        const { baseId, pinId } = placeBoth();
        insertInstance(assembly, { kind: "part", nodeId: pin.id }, "Pin");
        insertInstance(assembly, { kind: "part", nodeId: pin.id }, "Pin", {
            transform: rigidToArray({ r: axisAngle([1, 0, 0], Math.PI / 2), t: [0, -50, 0] }),
        });
        const top = connector(baseId, (s) => planarFace(s, [0, 0, 1], 10));
        const bottom = connector(pinId, (s) => planarFace(s, [0, 0, -1], 0));
        assembly.addMate(mate("fastened", top, bottom));
        solveAssembly(assembly);

        const evaluation = evaluateAssembly(doc, assembly);
        expect(evaluation.parts).toHaveLength(4);
        const step = exportAssemblyShapes(evaluation, ".step");
        expect(step.isOk).toBe(true);
        const folder = shapeConverter.convertFromSTEP(
            doc,
            new TextEncoder().encode(step.unchecked() as string),
        );
        expect(folder.isOk).toBe(true);
        const solids = NodeUtils.findNodes(
            folder.unchecked() as FolderNode,
            (x) => x instanceof ShapeNode,
        ).flatMap((node) => (node as ShapeNode).shape.unchecked()?.findSubShapes(ShapeTypes.solid) ?? []);
        expect(solids).toHaveLength(4);
        const total = solids.reduce((sum, solid) => sum + solid.volume(), 0);
        expect(total).toBeCloseTo(BASE_VOLUME + 3 * PIN_VOLUME(20), 1);
        // The seated pin is where the mate put it.
        const tops = solids.map((solid) => solid.boundingBox().max.z);
        expect(tops.some((z) => Math.abs(z - 30) < 1e-4)).toBe(true);
    });

    test("instances and mates are versioned one by one, and survive serialization", async () => {
        const storage = new MemoryStorage();
        const vc = versioned(doc, storage);
        const { pinId } = placeBoth();
        await settle();
        expect(vc.headCommit().summary).toEqual([
            "Assembly 1 › Added Instance Base <1>",
            "Assembly 1 › Added Instance Pin <1>",
        ]);
        assembly.updateInstance(
            pinId,
            {
                transform: rigidToArray({
                    r: arrayToRigid(assembly.instance(pinId)!.transform).r,
                    t: [1, 2, 3],
                }),
            },
            "move",
        );
        await settle();
        expect(vc.headCommit().summary).toEqual([
            "Assembly 1 › Instance Pin <1>: placement (70, -30, 25) → (1, 2, 3)",
        ]);
        assembly.updateInstance(pinId, { grounded: true }, "fix");
        await settle();
        expect(vc.headCommit().summary).toEqual(["Assembly 1 › Instance Pin <1>: fixed set to on"]);

        const copy = newDocument(doc.application, "copy", "Copy");
        const restored = Serializer.deserializeObject(
            copy,
            Serializer.serializeObject(assembly),
        ) as AssemblyNode;
        expect(restored.instances).toEqual(assembly.instances);
        expect(restored.mates).toEqual(assembly.mates);
        vc.dispose();
    });
});
