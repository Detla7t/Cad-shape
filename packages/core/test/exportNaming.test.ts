// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { documentExportNameResolver } from "../src/parameters/exportNaming";
import { EXPORT_NAME_PLACEHOLDER, exportFileName, formatExportName } from "../src/userPreferences";
import { TestDocument } from "../test-utils";

describe("export file names", () => {
    test("the rules' placeholders: name, date, document, format, a variable, the configuration", () => {
        const doc = new TestDocument();
        doc.userData = {
            displayUnits: { length: "in", angle: "deg", lengthPrecision: 3, anglePrecision: 1 },
        };
        doc.variables.setConfigurationInputs([
            {
                kind: "list",
                id: "od",
                name: "OD",
                options: [
                    { id: "a", name: '9 5/8"' },
                    { id: "b", name: '12"' },
                ],
                defaultOption: "a",
            },
            { kind: "checkbox", id: "e", name: "Endcap", defaultValue: false },
        ]);
        doc.variables.setItems([{ id: "d", name: "duct_od", type: "length", expression: "9.625 in" }]);
        const resolve = documentExportNameResolver(doc);
        const date = new Date("2026-10-09T12:00:00Z");
        expect(
            formatExportName(
                "{document} - {name} {#duct_od} {config:OD} {format}",
                "Cap",
                ".dxf",
                date,
                resolve,
            ),
        ).toBe("test - Cap 9.625in 9 5_8_ DXF.dxf");
        expect(formatExportName("{name} [{config}] {date}", "Cap", ".dwg", date, resolve)).toBe(
            "Cap [OD=9 5_8_ Endcap=false] 2026-10-09.dwg",
        );
        // An unknown placeholder stays as written; a rule for the format is applied.
        expect(formatExportName("{name} {#nope}", "Cap", ".svg", date, resolve)).toBe("Cap {#nope}.svg");
        expect(
            exportFileName(
                "Cap",
                "dxf",
                [{ extension: "dxf", template: "{document}_{name}" }],
                date,
                resolve,
            ),
        ).toBe("test_Cap.dxf");
        expect(
            "{name} {#duct_od} {config:OD} {config} {date} {document} {format}".replace(
                EXPORT_NAME_PLACEHOLDER,
                "",
            ),
        ).toBe("      ");
    });
});
