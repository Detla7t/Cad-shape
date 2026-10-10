// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { setCurrentApplication } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { customTables, evaluateCustomTable } from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import {
    addFunctionsFeature,
    addStandardSizesStudio,
    END_CAP_STUDIO_NAME,
} from "../src/app/endCapStandardSizes";
import { presetEndCaps } from "../src/endcap/batch";
import { formatFractionalInches } from "../src/endcap/inches";

describe("End Cap Standard Sizes custom table", () => {
    beforeAll(async () => {
        // The table runs in a modeling context, which needs the kernel.
        await initWasm({
            wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../wasm/lib/chili-wasm.wasm")),
        });
        Object.defineProperty(globalThis, "shapeFactory", {
            value: new ShapeFactory(),
            writable: true,
            configurable: true,
        });
        // The FeatureScript runtime reads the application's std configuration.
        try {
            setCurrentApplication(createMockApplication());
        } catch {
            // Another file of this worker already set one.
        }
    });
    test("the studio exports one table of every reducing preset, Size | OD | ID", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc);
        try {
            const studio = addStandardSizesStudio(doc);
            expect(studio.name).toBe(END_CAP_STUDIO_NAME);
            const tables = customTables(doc);
            expect(tables.map((entry) => [entry.tableName, entry.displayName])).toEqual([
                ["sizeTable", "Standard_Sizes"],
            ]);
            const result = evaluateCustomTable(doc, studio.id, "sizeTable");
            expect(result.error).toBeUndefined();
            expect(result.tables).toHaveLength(1);
            const table = result.tables[0];
            expect(table.title).toBe("Standard Sizes");
            expect(table.columns.map((column) => column.name)).toEqual(["Size", "OD", "ID"]);
            const reducers = presetEndCaps().filter((cap) => cap.reducing);
            expect(table.rows).toHaveLength(reducers.length);
            expect(table.rows.map((row) => row.cells["name"]?.text)).toEqual(
                reducers.map(
                    (cap) => `${formatFractionalInches(cap.od)} x ${formatFractionalInches(cap.id!)}`,
                ),
            );
            // Quantities read in the document's units (a millimetre document here).
            expect(table.rows[0].cells["od"]?.text).toMatch(/^114\.3/);
            expect(table.rows[0].cells["id"]?.text).toMatch(/^101\.6/);
            expect(table.rows[0].cells["name"]?.text).toBe('4 1/2" x 4"');
            // The studio's feature stores the two functions as variables of the Part Studio.
            const body = addFunctionsFeature(doc, studio);
            expect(body).not.toBeUndefined();
            expect(body!.shape.isOk).toBe(true);
            expect(body!.featureItems()[0].error).toBeUndefined();
            expect(body!.items.map((item) => [item.name, item.type])).toEqual([
                ["sizeCrimp", "function"],
                ["sizeOverlap", "function"],
            ]);
            expect(doc.variables.evaluate().scope.get("sizeOverlap")?.call).toBeDefined();
        } finally {
            doc.dispose();
        }
    });
});
