// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import { forEachDiagnostic } from "@codemirror/lint";
import { DEFAULT_STUDIO_SOURCE, FeatureStudioNode } from "../../../src/featurescript/featureStudioNode";
import { FeatureScriptIde } from "../../../src/featurescript/ui/ide/featureScriptIde";

/**
 * The IDE component in Happy-DOM: the studio workflow it keeps from the textarea editor —
 * drafts, Apply as one undo step, Revert, following undo/redo — plus diagnostics and the
 * outline driven by the live compile. (Native std: no std bundle is provided here.)
 */

function setup() {
    const document = new TestDocument();
    const studio = new FeatureStudioNode({ document, name: "Studio" });
    document.modelManager.addNode(studio);
    const ide = new FeatureScriptIde(studio);
    window.document.body.append(ide.root);
    const append = (text: string) =>
        ide.view.dispatch({ changes: { from: ide.view.state.doc.length, insert: text } });
    return { document, studio, ide, append };
}

function diagnostics(ide: FeatureScriptIde): { from: number; message: string }[] {
    const found: { from: number; message: string }[] = [];
    forEachDiagnostic(ide.view.state, (diagnostic, from) =>
        found.push({ from, message: diagnostic.message }),
    );
    return found;
}

describe("FeatureScriptIde", () => {
    let current: ReturnType<typeof setup> | undefined;
    afterEach(() => {
        current?.ide.dispose();
        current?.ide.root.remove();
        current = undefined;
    });

    test("opens on the studio's source with no edits pending", () => {
        current = setup();
        expect(current.ide.source).toBe(DEFAULT_STUDIO_SOURCE);
        expect(current.ide.dirty).toBe(false);
        // Tests run with an identity locale: labels are their i18n keys.
        const apply = [...current.ide.root.querySelectorAll("button")].find(
            (b) => b.textContent === "featurescript.editor.apply",
        );
        expect(apply).not.toBeUndefined();
        expect(apply?.disabled).toBe(true);
    });

    test("edits are a draft until applied; applying is one undo step", () => {
        current = setup();
        const { ide, studio, document, append } = current;
        append("\n// draft\n");
        expect(ide.dirty).toBe(true);
        expect(studio.source).toBe(DEFAULT_STUDIO_SOURCE);
        ide.apply();
        expect(studio.source).toBe(`${DEFAULT_STUDIO_SOURCE}\n// draft\n`);
        expect(ide.dirty).toBe(false);
        document.history.undo();
        expect(studio.source).toBe(DEFAULT_STUDIO_SOURCE);
        // A clean draft follows undo and redo of the studio's source.
        expect(ide.source).toBe(DEFAULT_STUDIO_SOURCE);
        document.history.redo();
        expect(ide.source).toBe(`${DEFAULT_STUDIO_SOURCE}\n// draft\n`);
    });

    test("a draft with edits of its own is kept when the source changes underneath", () => {
        current = setup();
        const { ide, studio, document, append } = current;
        append("\n// applied\n");
        ide.apply();
        append("// mine\n");
        document.history.undo();
        expect(studio.source).toBe(DEFAULT_STUDIO_SOURCE);
        expect(ide.source).toBe(`${DEFAULT_STUDIO_SOURCE}\n// applied\n// mine\n`);
        ide.revert();
        expect(ide.source).toBe(DEFAULT_STUDIO_SOURCE);
        expect(ide.dirty).toBe(false);
    });

    test("a compile error becomes a diagnostic at its position and the status says so", () => {
        current = setup();
        const { ide, append } = current;
        expect(diagnostics(ide)).toEqual([]);
        append("\nexport const broken = ;\n");
        ide.refresh();
        const [diagnostic] = diagnostics(ide);
        expect(diagnostic.from).toBe(ide.source.indexOf("= ;") + 2);
        expect(diagnostic.message).toMatch(/Unexpected/);
        const status = ide.root.querySelector("span[title]");
        expect(status).not.toBeNull();
        expect(status?.textContent).toMatch(/Unexpected/);
    });

    test("the outline lists the studio's declarations and jumps to them", () => {
        current = setup();
        const { ide } = current;
        const rows = [...ide.root.querySelectorAll("div[title]")].filter((row) =>
            row.textContent?.includes("Rounded Plate"),
        );
        expect(rows).toHaveLength(1);
        (rows[0] as HTMLElement).click();
        const selection = ide.view.state.selection.main;
        expect(ide.source.slice(selection.from, selection.to)).toBe("roundedPlate");
    });

    test("dispose stops following the studio", () => {
        current = setup();
        const { ide, studio } = current;
        ide.dispose();
        studio.source = "FeatureScript 3083;\n";
        expect(ide.view.state.doc.toString()).toBe(DEFAULT_STUDIO_SOURCE);
    });
});
