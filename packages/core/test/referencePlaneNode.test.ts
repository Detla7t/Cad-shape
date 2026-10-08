// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    addDefaultPlanes,
    I18n,
    Matrix4,
    OriginNode,
    Plane,
    ReferencePlaneNode,
    Serializer,
    Transaction,
    XYZ,
} from "../src";
import { TestDocument } from "../test-utils";

test("default planes are named, centered on the origin and serialized as reference geometry", () => {
    const document = new TestDocument();
    addDefaultPlanes(document);
    const nodes = document.modelManager.findNodes().filter((n) => n instanceof ReferencePlaneNode);
    expect(nodes.map((n) => n.name)).toEqual([
        I18n.translate("plane.top"),
        I18n.translate("plane.front"),
        I18n.translate("plane.right"),
    ]);
    expect(nodes.map((n) => n.plane.normal)).toEqual([XYZ.unitZ, XYZ.unitY, XYZ.unitX]);
    for (const node of nodes) {
        expect(node.plane.origin).toEqual(XYZ.zero);
        expect(node.corners().length).toBe(4);
    }
});

test("offset and size survive save/reload and undo/redo", () => {
    const document = new TestDocument();
    const node = new ReferencePlaneNode({ document, basePlane: Plane.XY, offset: 25, name: "Deck" });
    document.modelManager.addNode(node);
    Transaction.execute(document, "move plane", () => {
        node.offset = -12;
        node.size = 160;
    });
    expect(node.plane.origin.z).toBe(-12);
    document.history.undo();
    expect(node.plane.origin.z).toBe(25);
    expect(node.size).toBe(200);
    document.history.redo();
    const copy = Serializer.deserializeObject(
        document,
        Serializer.serializeObject(node),
    ) as ReferencePlaneNode;
    expect(copy.name).toBe("Deck");
    expect(copy.plane.origin.z).toBe(-12);
    expect(copy.size).toBe(160);
    expect(copy.boundingBox().min.x).toBe(-80);
    expect(copy.boundingBox().max.y).toBe(80);
});

test("new documents include a fixed origin that retains its identity and visibility through save/reload", () => {
    const document = new TestDocument();
    addDefaultPlanes(document);
    const origins = document.modelManager.findNodes().filter((node) => node instanceof OriginNode);
    expect(origins).toHaveLength(1);
    const origin = origins[0];
    expect(origin.name).toBe(I18n.translate("body.origin"));
    expect(origin.position).toEqual(XYZ.zero);
    origin.transform = Matrix4.fromTranslation(10, 20, 30);
    expect(origin.transform.ofPoint(origin.position)).toEqual(XYZ.zero);
    origin.visible = false;
    const copy = Serializer.deserializeObject(document, Serializer.serializeObject(origin)) as OriginNode;
    expect(copy).toBeInstanceOf(OriginNode);
    expect(copy.id).toBe(origin.id);
    expect(copy.visible).toBe(false);
    expect(copy.position).toEqual(XYZ.zero);
    expect(copy.boundingBox()).toEqual({ min: XYZ.zero, max: XYZ.zero });
});
