// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export * from "./autoConstraints";
export * from "./editor/sketchEditor";
export * from "./externalRef";
export * from "./garlic";
export * from "./ribbon";
export * from "./sketchDrawing";
export * from "./sketchModel";
export * from "./sketchNode";
export * from "./solver";
import "./commands";

import { OperationLog, PubSub, ReferencePlaneNode } from "@chili3d/core";
import { SketchEditor } from "./editor/sketchEditor";
import { SketchNode } from "./sketchNode";

// Every diagnostic event records which sketch is being edited, and how far it is solved.
OperationLog.addContextProvider(() => {
    const editor = SketchEditor.getActive();
    if (editor === undefined) return undefined;
    return {
        activeSketchId: editor.node.id,
        activeSketchName: editor.node.name,
        sketchPicking: editor.isPicking,
        sketchDofs: editor.lastSolveOutcome.dofs,
        sketchSolve: editor.lastSolveOutcome.result,
    };
});

// Double-clicking a sketch node in the project tree enters its editing session.
PubSub.default.sub("nodeDoubleClicked", (node) => {
    if (node instanceof ReferencePlaneNode) {
        node.document.selection.setSelectedNodes([node], false);
        PubSub.default.pub("executeCommand", "sketch.create");
    }
    if (node instanceof SketchNode && SketchEditor.getActive()?.node !== node) {
        SketchEditor.enter(node);
    }
});
import "./modelParameters";
import "./contextActions";

import "./planeContextActions";

export { appendSketch } from "./sketchClipboard";
