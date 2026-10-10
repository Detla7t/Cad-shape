// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentElements, EditorBuffers } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { DEFAULT_STUDIO_SOURCE, FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import { featureStudioBuffer } from "../../src/featurescript/ui/featureStudioBuffer";
import "../../src/featurescript/ui/featureStudioElement";
import { FeatureScriptIde } from "../../src/featurescript/ui/ide/featureScriptIde";

function setup() {
    const document = new TestDocument();
    const studio = new FeatureStudioNode({ document, name: "Studio" });
    document.modelManager.addNode(studio);
    const ide = new FeatureScriptIde(studio);
    window.document.body.append(ide.root);
    const changed = rs.fn(() => {});
    const buffer = featureStudioBuffer(ide, changed);
    const append = (text: string) =>
        ide.view.dispatch({ changes: { from: ide.view.state.doc.length, insert: text } });
    const close = () => {
        ide.dispose();
        ide.root.remove();
    };
    return { document, studio, ide, buffer, changed, append, close };
}

describe("a Feature Studio's editor buffer", () => {
    test("the unapplied source is the draft; commit is Apply, one undo step", async () => {
        const { document, studio, buffer, changed, append, close } = setup();
        try {
            expect(buffer.editor).toBe("featureStudio");
            expect(buffer.node).toBe(studio);
            append("\n// draft\n");
            expect(buffer.isDirty()).toBe(true);
            expect(changed).toHaveBeenCalled();

            const before = document.history.undoCount();
            expect((await buffer.commit()).isOk).toBe(true);
            expect(studio.source).toBe(`${DEFAULT_STUDIO_SOURCE}\n// draft\n`);
            expect(buffer.isDirty()).toBe(false);
            expect(document.history.undoCount()).toBe(before + 1);
        } finally {
            close();
        }
    });

    test("revert drops the draft; a snapshot restores it, with its selection, as an edit", () => {
        const { studio, ide, buffer, append, close } = setup();
        try {
            expect(buffer.snapshot?.()).toBeUndefined();
            append("\n// mine\n");
            ide.view.dispatch({ selection: { anchor: 3, head: 9 } });
            const snapshot = buffer.snapshot?.();
            expect(snapshot).toEqual({
                data: `${DEFAULT_STUDIO_SOURCE}\n// mine\n`,
                selection: { anchor: 3, head: 9 },
            });

            buffer.revert();
            expect(ide.source).toBe(DEFAULT_STUDIO_SOURCE);
            expect(buffer.isDirty()).toBe(false);

            buffer.restore?.(snapshot!);
            expect(ide.source).toBe(`${DEFAULT_STUDIO_SOURCE}\n// mine\n`);
            expect(ide.view.state.selection.main.from).toBe(3);
            expect(ide.view.state.selection.main.to).toBe(9);
            expect(buffer.isDirty()).toBe(true);
            expect(studio.source).toBe(DEFAULT_STUDIO_SOURCE);
        } finally {
            close();
        }
    });

    test("the element view registers the IDE's buffer once it is up, and unregisters on dispose", async () => {
        const document = new TestDocument();
        const studio = new FeatureStudioNode({ document, name: "Studio" });
        document.modelManager.addNode(studio);
        const view = DocumentElements.createView(studio, document);
        expect(view).toBeDefined();
        window.document.body.append(view!.element);
        try {
            const start = Date.now();
            while (EditorBuffers.buffersOf(document, studio).length === 0 && Date.now() - start < 5000) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const [buffer] = EditorBuffers.buffersOf(document, studio);
            expect(buffer?.editor).toBe("featureStudio");
        } finally {
            view!.dispose();
            view!.element.remove();
        }
        expect(EditorBuffers.buffersOf(document, studio)).toEqual([]);
    });
});
