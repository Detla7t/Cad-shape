// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Serializer } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { CamStudioNode, machineProfile, type SetupData } from "../src";

const SETUP: SetupData = {
    id: "s1",
    name: "Op 10",
    machineId: "shop-mill",
    wcs: { origin: [0, 0, 25], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
    stock: { kind: "box", margin: { x: 2, y: 2, zTop: 1, zBottom: 0 } },
    partIds: ["p1"],
    operations: [{ id: "o1", type: "pocket", name: "Pocket 1", toolId: "t2", params: { depth: 4 } }],
    postId: "haas",
    postOptions: { lineNumbers: true },
};

test("a CAM Studio saves and loads with its setups and its own machine profiles", () => {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const machine = { ...machineProfile("generic-3-axis")!, id: "shop-mill", name: "Shop mill" };
    const studio = new CamStudioNode({
        document: doc,
        name: "CAM Studio 1",
        setups: [SETUP],
        machines: [machine],
    });
    const data = Serializer.serializeObject(studio);
    expect(Object.keys(data)).toEqual(expect.arrayContaining(["setupsJson", "machinesJson", "name", "id"]));
    const loaded = Serializer.deserializeObject(doc, data) as CamStudioNode;
    expect(loaded).toBeInstanceOf(CamStudioNode);
    expect(loaded.id).toBe(studio.id);
    expect(loaded.name).toBe("CAM Studio 1");
    expect(loaded.setups).toEqual([SETUP]);
    expect(loaded.machines).toEqual([machine]);
});

test("a document saved before machine profiles existed loads with none", () => {
    const doc = new TestDocument();
    const studio = new CamStudioNode({ document: doc, setupsJson: JSON.stringify([SETUP]) });
    const { machinesJson: _machines, ...older } = Serializer.serializeObject(studio) as Record<
        string,
        unknown
    >;
    const loaded = Serializer.deserializeObject(doc, older as any) as CamStudioNode;
    expect(loaded.machines).toEqual([]);
    expect(loaded.setups).toEqual([SETUP]);
});
