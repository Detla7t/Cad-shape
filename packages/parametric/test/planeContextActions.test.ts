// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BoundingBox, EditableShapeNode, NodeActions, Plane, ReferencePlaneNode, XYZ } from "@chili3d/core";
import { MockShape, TestDocument } from "@chili3d/core/test-utils";
import { patternedPositions } from "../src/sketch/entityMesh";
import { sizePlaneToPartStudio } from "../src/sketch/planeContextActions";

test("plane menu hides other planes in one undo step and projects model bounds into the selected plane", () => {
    const doc = new TestDocument();
    const top = new ReferencePlaneNode({ document: doc, basePlane: Plane.XY, name: "Top" });
    const right = new ReferencePlaneNode({ document: doc, basePlane: Plane.YZ, name: "Right" });
    const part = new EditableShapeNode({ document: doc, shape: new MockShape(), name: "Part" });
    part.boundingBox = () => new BoundingBox(new XYZ(-30, -10, 0), new XYZ(20, 40, 15));
    doc.modelManager.addNode(top, right, part);
    try {
        const action = NodeActions.forNode(top).find((item) => item.id === "hideOtherPlanes");
        expect(action).not.toBeUndefined();
        action!.run!();
        expect([top.visible, right.visible, part.visible]).toEqual([true, false, true]);
        doc.history.undo();
        expect(right.visible).toBe(true);
        expect(sizePlaneToPartStudio(top)).toBe(88);
        expect(sizePlaneToPartStudio(right)).toBe(88);
        expect(NodeActions.forNode(top).map((action) => action.label)).toContain("Offset plane…");
    } finally {
        doc.dispose();
    }
});

test("four-part construction pattern maintains phase across tessellation segments", () => {
    const points = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 0, 46, 0, 0]);
    const result = patternedPositions(points, [4, 6, 30, 6]);
    expect([...result]).toEqual([0, 0, 0, 4, 0, 0, 10, 0, 0, 40, 0, 0]);
});
