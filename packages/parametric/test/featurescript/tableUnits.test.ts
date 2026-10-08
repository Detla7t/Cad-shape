// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, defaultUserPreferences, initializeDocumentPreferences } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { AREA, MASS } from "../../src/featurescript/lang/values";
import { formatDocumentTableQuantity } from "../../src/featurescript/tableRuntime";

test("FeatureScript table quantities honor document units without changing SI values", () => {
    const saved = Config.instance.preferences;
    const prefs = defaultUserPreferences();
    prefs.defaultUnits.length = "in";
    prefs.quantities.mass = { unit: "lb", precision: 4 };
    prefs.quantities.pressure = { unit: "psi", precision: 2 };
    Config.instance.preferences = prefs;
    const doc = new TestDocument();
    initializeDocumentPreferences(doc);
    try {
        const quantity = { value: 0.0254 ** 2, units: AREA };
        expect(formatDocumentTableQuantity(quantity, doc)).toBe("1 in²");
        expect(quantity.value).toBe(0.0254 ** 2);
        expect(formatDocumentTableQuantity({ value: 0.45359237, units: MASS }, doc, 4, true)).toBe(
            "1.0000 lb",
        );
        expect(
            formatDocumentTableQuantity(
                { value: 6894.757293168, units: { meter: -1, kilogram: 1, radian: 0, second: -2 } },
                doc,
            ),
        ).toBe("1 psi");
        Config.instance.preferences = { ...prefs, decimalComma: true };
        expect(formatDocumentTableQuantity({ value: 0.45359237 * 1.5, units: MASS }, doc)).toBe("1,5 lb");
    } finally {
        doc.dispose();
        Config.instance.preferences = saved;
    }
});
