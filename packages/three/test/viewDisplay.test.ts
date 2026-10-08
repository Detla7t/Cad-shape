// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EditableShapeNode, type IFace, PhongMaterial } from "@chili3d/core";
import { createMockEdge, createMockVisual, MockShape, TestDocument } from "@chili3d/core/test-utils";
import { GreaterDepth, Scene } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { ThreeGeometry } from "../src/threeGeometry";
import type { ThreeView } from "../src/threeView";
import { ThreeVisualContext } from "../src/threeVisualContext";
import { ViewDisplay } from "../src/viewDisplay";

test("edge presentation masks tangents, draws boundary and hidden overlays, then restores shared pick geometry", () => {
    const doc = new TestDocument();
    const shape = new MockShape();
    const tangent = createMockEdge(),
        boundary = createMockEdge();
    tangent.findAncestor = () => [new MockShape(), new MockShape()];
    tangent.hasContinuity = (_a: IFace, _b: IFace) => true;
    tangent.continuity = () => "g1";
    boundary.findAncestor = () => [new MockShape()];
    shape.mesh.edges!.range = [
        { start: 0, count: 2, shape: tangent as never },
        { start: 2, count: 2, shape: boundary as never },
    ];
    const context = new ThreeVisualContext(createMockVisual({ document: doc }), new Scene());
    doc.modelManager.materials.push(new PhongMaterial({ document: doc, name: "Default", color: 0xdddddd }));
    const node = new EditableShapeNode({ document: doc, name: "Part", shape });
    doc.modelManager.addNode(node);
    const geometry = context.getVisual(node);
    expect(geometry).toBeInstanceOf(ThreeGeometry);
    const visual = geometry as ThreeGeometry;
    const original = visual.edges()!.geometry;
    const display = new ViewDisplay({ content: context } as ThreeView);
    Object.assign(display.options, { tangentEdges: "phantom", boundaryEdges: true, hiddenEdges: true });
    let rendered: { end: number; lines: number; hidden: number } | undefined;
    try {
        display.render(() => {
            const lines = visual.children.filter((child) => child instanceof LineSegments2);
            rendered = {
                end: visual.edges()!.geometry.getAttribute("instanceEnd").getX(0),
                lines: lines.length,
                hidden: lines.filter((line) => line.material.depthFunc === GreaterDepth).length,
            };
        });
        expect(rendered).toEqual({ end: 0, lines: 4, hidden: 1 });
        expect(visual.edges()!.geometry).toBe(original);
        expect(original.getAttribute("instanceEnd").getX(0)).toBe(1);
        expect(visual.children.filter((child) => child instanceof LineSegments2)).toHaveLength(1);
    } finally {
        display.dispose();
        context.dispose();
        doc.dispose();
    }
});
