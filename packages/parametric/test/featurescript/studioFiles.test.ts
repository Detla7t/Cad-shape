// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication } from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { ExportFeatureStudioCommand } from "../../src/commands/exportCommands";
import { FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import { importFeatureStudio, studioNameOfFile, uniqueStudioName } from "../../src/featurescript/studioFiles";

function studioDocument(...studios: [string, string][]) {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.selection = { getSelectedNodes: () => [] } as any;
    for (const [name, source] of studios)
        doc.modelManager.addNode(new FeatureStudioNode({ document: doc, name, source }));
    return doc;
}

/** Captures what `download` hands the browser: the blob and the file name. */
async function captureDownload(run: () => Promise<void>): Promise<{ name: string; blob: Blob }[]> {
    const downloads: { name: string; blob: Blob }[] = [];
    let pending: Blob | undefined;
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob: Blob) => {
        pending = blob;
        return "blob:capture";
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        downloads.push({ name: this.download, blob: pending! });
    };
    try {
        await run();
    } finally {
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
        HTMLAnchorElement.prototype.click = click;
    }
    return downloads;
}

describe("Feature Studio files", () => {
    test("a .fs file name gives the studio name", () => {
        expect(studioNameOfFile("Duct Seams.fs")).toBe("Duct Seams");
        expect(studioNameOfFile("C:\\work\\Bracket.FS")).toBe("Bracket");
        expect(studioNameOfFile("noext")).toBe("noext");
    });

    test("an imported studio keeps its name when free, else gets the next free one", () => {
        const doc = studioDocument(["Bracket", "a"], ["Bracket (2)", "b"]);
        expect(uniqueStudioName(doc, "Plate")).toBe("Plate");
        expect(uniqueStudioName(doc, "Bracket")).toBe("Bracket (3)");

        const studio = importFeatureStudio(doc, "Bracket.fs", "FeatureScript 3083;\n");
        expect(studio.name).toBe("Bracket (3)");
        expect(studio.source).toBe("FeatureScript 3083;\n");
        expect(doc.modelManager.findNodes((node) => node instanceof FeatureStudioNode)).toHaveLength(3);
        // One undo step removes it again.
        doc.history.undo();
        expect(doc.modelManager.findNodes((node) => node instanceof FeatureStudioNode)).toHaveLength(2);
    });

    test("exports the document's only studio as a .fs file with its exact source", async () => {
        const source = 'FeatureScript 3083;\r\nexport const x = "✓";\n';
        const doc = studioDocument(["Seams: Pittsburgh", source]);
        const app = { activeView: { document: doc } } as unknown as IApplication;

        const downloads = await captureDownload(() => new ExportFeatureStudioCommand().execute(app));

        expect(downloads.map((d) => d.name)).toEqual(["Seams_ Pittsburgh.fs"]);
        expect(await downloads[0].blob.text()).toBe(source);
    });

    test("exports several studios as one zip of .fs files", async () => {
        const doc = studioDocument(["A", "a source"], ["B", "b source"]);
        const app = { activeView: { document: doc } } as unknown as IApplication;

        const downloads = await captureDownload(() => new ExportFeatureStudioCommand().execute(app));

        expect(downloads.map((d) => d.name)).toEqual(["test feature studios.zip"]);
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(await downloads[0].blob.arrayBuffer());
        expect(Object.keys(zip.files).sort()).toEqual(["A.fs", "B.fs"]);
        expect(await zip.file("B.fs")!.async("string")).toBe("b source");
    });
});
