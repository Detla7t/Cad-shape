// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    documentParameterInput,
    documentUnits,
    EMPTY_SCOPE,
    formatDocumentValue,
    LENGTH_UNITS,
    resolveUnitSpec,
    setDocumentUnits,
} from "../src";
import { TestDocument } from "../test-utils";

test("document units are independent, undoable metadata and do not rescale stored geometry", () => {
    const doc = new TestDocument(),
        other = new TestDocument();
    setDocumentUnits(doc, { length: "in", angle: "rad", lengthPrecision: 3, anglePrecision: 4 });
    expect(formatDocumentValue(25.4, doc, LENGTH_UNITS)).toBe("1.000 in");
    expect(formatDocumentValue(180, doc, ANGLE_UNITS)).toBe("3.1416 rad");
    expect(documentUnits(other).length).toBe("mm");
    expect(JSON.parse(JSON.stringify(doc.userData)).displayUnits.length).toBe("in");
    doc.history.undo();
    expect(documentUnits(doc).length).toBe("mm");
    doc.history.redo();
    expect(documentUnits(doc).length).toBe("in");
    doc.dispose();
    other.dispose();
});

test.each([
    ["2", 50.8],
    ["1 + 1", 50.8],
    ["10 mm", 10],
    ["#Width * 2", 20],
])("inch document input %s resolves to %s mm", (text, expected) => {
    const doc = new TestDocument();
    setDocumentUnits(doc, { length: "in", angle: "deg", lengthPrecision: 3, anglePrecision: 1 });
    const scope = new Map([["Width", { value: 10, unit: LENGTH_UNITS }]]);
    const result = documentParameterInput(String(text), doc, LENGTH_UNITS, scope);
    expect(result.isOk).toBe(true);
    expect(resolveUnitSpec(result.value, scope, LENGTH_UNITS).value).toBeCloseTo(Number(expected));
    expect(documentParameterInput("invalid!", doc, LENGTH_UNITS, EMPTY_SCOPE).isOk).toBe(false);
    doc.dispose();
});
