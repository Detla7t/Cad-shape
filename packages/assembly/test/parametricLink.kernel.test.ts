// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Links to a PARAMETRIC part: the source body is rebuilt from its feature list in a detached
 * copy of the source at the linked commit, and the link carries the body's stable face ids, so
 * a mate connector on a linked face follows that face — by id — when the source changes.
 */

import { type IFace, Plane, PubSub, ShapeTypes, Transaction } from "@chili3d/core";
import type { FeatureData } from "../../parametric/src/features/feature";
import { captureProfileRef } from "../../parametric/src/features/profileRef";
import { ParametricBodyNode } from "../../parametric/src/parametricBodyNode";
import type { SketchData } from "../../parametric/src/sketch/sketchModel";
import { SketchNode } from "../../parametric/src/sketch/sketchNode";
import "../../parametric/test/sketch/setup";
import { setLinkService } from "../src/link/linkRegistry";
import type { PartLinkService } from "../src/link/partLinkService";
import { AssemblyNode } from "../src/model/assemblyNode";
import { connectorFromSubShape, subShapesOf } from "../src/model/connectors";
import { evaluateAssembly } from "../src/model/evaluate";
import { insertInstance } from "../src/model/insert";
import { solveAssembly } from "../src/model/solve";
import "../src/versioning";
import {
    createApp,
    initKernel,
    installService,
    MemoryStorage,
    newDocument,
    save,
    settle,
    versioned,
} from "./helpers";

beforeAll(initKernel);

const rect = (size: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [0, 0, size, 0] },
        { id: 2, type: "line", params: [size, 0, size, size] },
        { id: 3, type: "line", params: [size, size, 0, size] },
        { id: 4, type: "line", params: [0, size, 0, 0] },
    ],
    constraints: [],
    entityIdSeq: 5,
});

describe("links to parametric parts (kernel)", () => {
    let service: PartLinkService;

    afterEach(() => {
        service.dispose();
        setLinkService(undefined);
    });

    test("a linked body keeps its face ids; a connector on a linked face follows it by id", async () => {
        const storage = new MemoryStorage();
        const app = createApp(storage);
        service = installService(storage, app, true);

        // Source: a 30×30 block extruded 10 from a sketch.
        const source = newDocument(app, "parametric-source", "Blocks");
        const sourceVc = versioned(source, storage);
        const sketch = new SketchNode({ document: source, plane: Plane.XY, data: rect(30) });
        Transaction.execute(source, "sketch", () => source.modelManager.addNode(sketch));
        await settle();
        const profiles = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
        const body = new ParametricBodyNode({
            document: source,
            features: [
                {
                    id: "e1",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 10,
                    profiles: [captureProfileRef(profiles[0].shape as unknown as IFace)],
                },
            ],
        });
        Transaction.execute(source, "extrude", () => {
            body.name = "Block";
            source.modelManager.addNode(body);
        });
        await settle();
        expect(body.shape.unchecked()!.volume()).toBeCloseTo(9000, 6);
        await save(source, storage, sourceVc);

        // Consumer: a fixed copy of the block (linked) with a second one stacked on its top face.
        const doc = newDocument(app, "parametric-consumer", "Stack");
        versioned(doc, storage);
        const assembly = new AssemblyNode({ document: doc, name: "Assembly 1" });
        Transaction.execute(doc, "assembly", () => doc.modelManager.addNode(assembly));
        const following = await service.resolveNew(source.id, body.id, { kind: "branch", name: "Main" });
        expect(following.isOk).toBe(true);
        const entry = following.unchecked()!.entry;
        expect(entry.parts[0].faceIds?.length).toBe(6);
        expect(entry.parts[0].faceIds?.every((id) => typeof id === "string")).toBe(true);
        const bottom = insertInstance(assembly, { kind: "link", link: following.unchecked()!.link }, "Block");
        const top = insertInstance(assembly, { kind: "link", link: following.unchecked()!.link }, "Block");
        await service.settled();

        const part = (id: string) => evaluateAssembly(doc, assembly).parts.find((p) => p.instanceId === id)!;
        const face = (id: string, z: number, nz: number) => {
            const placed = part(id);
            const faces = subShapesOf(placed.shape, "face");
            const index = faces.findIndex((f) => {
                const [point, normal] = (f as IFace).normal(0, 0);
                return Math.abs(point.z - z) < 1e-6 && Math.abs(normal.normalize()!.z - nz) < 1e-9;
            });
            expect(index).toBeGreaterThanOrEqual(0);
            return connectorFromSubShape(placed, faces[index], index)!;
        };
        const topFace = face(bottom.id, 10, 1);
        expect(topFace.entity?.id).toBe(entry.parts[0].faceIds?.[topFace.entity!.index]);
        Transaction.execute(doc, "stack", () => {
            assembly.addMate({ id: "m", name: "m", type: "fastened", a: topFace, b: face(top.id, 0, -1) });
            solveAssembly(assembly);
        });
        const lowest = () => {
            const placed = part(top.id);
            return Math.round(placed.shape.transformed(placed.placement).boundingBox().min.z * 1e6) / 1e6;
        };
        expect(lowest()).toBe(10);

        // The source block gets deeper: the stacked block follows the moved top face.
        Transaction.execute(source, "deeper", () =>
            body.setFeaturesEmitShapeChanged(
                body.features.map((f) => (f.id === "e1" ? ({ ...f, depth: 25 } as FeatureData) : f)),
            ),
        );
        await settle();
        await save(source, storage, sourceVc);
        PubSub.default.pub("documentSaved", source);
        await service.settled();
        expect(assembly.mates[0].a.entity?.id).toBe(topFace.entity?.id);
        expect(assembly.mates[0].a.origin[2]).toBeCloseTo(25, 6);
        expect(lowest()).toBe(25);
    });
});
