// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    defaultUserPreferences,
    displayPixelRatio,
    documentParameterInput,
    documentQuantityUnits,
    documentUnits,
    EMPTY_SCOPE,
    exportFileName,
    formatDocumentQuantity,
    formatDocumentValue,
    initializeDocumentPreferences,
    LENGTH_UNITS,
    resolveUnitSpec,
    setDocumentQuantityUnits,
} from "../src";
import { TestDocument } from "../test-utils";

const saved = Config.instance.preferences;
afterEach(() => {
    Config.instance.preferences = saved;
});

test("new documents snapshot unit defaults; changes never reinterpret existing or legacy documents", () => {
    const legacy = new TestDocument();
    Config.instance.preferences = {
        ...defaultUserPreferences(),
        defaultUnits: { length: "in", angle: "deg", lengthPrecision: 3, anglePrecision: 2 },
    };
    const first = new TestDocument();
    initializeDocumentPreferences(first);
    Config.instance.preferences = {
        ...Config.instance.preferences,
        defaultUnits: { length: "m", angle: "rad", lengthPrecision: 4, anglePrecision: 3 },
    };
    const second = new TestDocument();
    initializeDocumentPreferences(second);
    expect(documentUnits(first).length).toBe("in");
    expect(documentUnits(second).length).toBe("m");
    expect(documentUnits(legacy).length).toBe("mm");
    expect(formatDocumentValue(25.4, first, LENGTH_UNITS)).toBe("1.000 in");
    first.dispose();
    second.dispose();
    legacy.dispose();
});

test("localized dimension literals accept commas without rewriting function argument separators", () => {
    Config.instance.preferences = { ...defaultUserPreferences(), decimalComma: true };
    const doc = new TestDocument();
    expect(formatDocumentValue(12.5, doc, LENGTH_UNITS)).toBe("12,50 mm");
    const input = documentParameterInput("1,25 in", doc, LENGTH_UNITS, EMPTY_SCOPE);
    expect(input.isOk).toBe(true);
    expect(resolveUnitSpec(input.value, EMPTY_SCOPE, LENGTH_UNITS).value).toBeCloseTo(31.75);
    const expression = documentParameterInput("max(1,2)", doc, LENGTH_UNITS, EMPTY_SCOPE);
    expect(expression.isOk).toBe(true);
    expect(resolveUnitSpec(expression.value, EMPTY_SCOPE, LENGTH_UNITS).value).toBe(2);
    doc.dispose();
});

test("physical quantity settings convert SI values and undo independently of global defaults", () => {
    Config.instance.preferences = defaultUserPreferences();
    const doc = new TestDocument();
    const before = documentQuantityUnits(doc);
    setDocumentQuantityUnits(doc, { ...before, mass: { unit: "lb", precision: 4 } });
    expect(formatDocumentQuantity(0.45359237, doc, "mass")).toBe("1.0000 lb");
    expect(JSON.parse(JSON.stringify(doc.userData)).quantityUnits.mass.unit).toBe("lb");
    doc.history.undo();
    expect(formatDocumentQuantity(0.45359237, doc, "mass")).toBe("0.454 kg");
    doc.history.redo();
    expect(documentQuantityUnits(doc).mass.unit).toBe("lb");
    doc.dispose();
});

test("export rules retain format extensions and sanitize names after template substitution", () => {
    const rules = [{ extension: "step", template: "{date}_{name}" }];
    expect(exportFileName("Part/1", ".STEP", rules, new Date("2026-10-08T12:00:00Z"))).toBe(
        "2026-10-08_Part_1.STEP",
    );
    expect(exportFileName("Part", "dxf", rules)).toBe("Part.dxf");
});

test.each([
    ["standard", 3, 1],
    ["device", 3, 3],
    ["device", 8, 4],
    ["automatic", 3, 2],
    ["automatic", 1, 1],
    ["automatic", 1.25, 1.25],
    ["automatic", Number.NaN, 1],
] as const)("%s display density at %s gives %s", (mode, device, expected) => {
    expect(displayPixelRatio(mode, device)).toBe(expected);
});
