// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A user's Onshape Feature Studio, verbatim (FeatureScript 2931): a feature that stores
 * FUNCTIONS as variables with `setVariable`, helpers with `while`, `%`, `+=`, `/=` and
 * string concatenation, and a custom table of every standard duct size pair. It must run
 * the same on Onshape's std and on the native std.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import type { Interpreter } from "../../src/featurescript/lang/interpreter";
import { FsMap, FsQuantity, type FsValue, isCallable, LENGTH } from "../../src/featurescript/lang/values";
import { createNativeInterpreter } from "../../src/featurescript/nativeStd";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { runFeature } from "../../src/featurescript/runtime";
import { runTable } from "../../src/featurescript/tableRuntime";
import { fixture, ONSHAPE_STD } from "./_helpers/onshapeStd";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

const STDS = ["onshape", "native"] as const;
type Std = (typeof STDS)[number];
let interpreters: Record<Std, Interpreter>;
const SOURCE = fixture("endCapFunctions.fs");
const INCH = 0.0254;
const inches = (value: number) => new FsQuantity(value * INCH, LENGTH);
const inchesOf = (value: FsValue) => {
    if (value instanceof FsQuantity) return value.value / INCH;
    if (value instanceof FsMap && typeof value.field("value") === "number")
        return (value.field("value") as number) / INCH;
    throw new Error(`Not a length: ${String(value)}`);
};

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    interpreters = {
        onshape: createOnshapeInterpreter({ std: ONSHAPE_STD }),
        native: createNativeInterpreter(),
    };
});

describe.each(STDS)("the End Cap functions studio on the %s std", (std) => {
    test("loads: one feature and one table exported, at FeatureScript 2931 with std 2931 imports", () => {
        const module = interpreters[std].load({ path: `endCapFunctions-${std}`, source: SOURCE });
        expect(module.features.map((feature) => feature.name)).toEqual(["addMyFunctions"]);
        expect(module.tables.map((table) => [table.name, table.displayName])).toEqual([
            ["sizeTable", "Standard_Sizes"],
        ]);
    });

    test("the feature stores sizeCrimp and sizeOverlap as callable variables", () => {
        const interpreter = interpreters[std];
        const module = interpreter.load({ path: `endCapFunctions-run-${std}`, source: SOURCE });
        const feature = module.features[0];
        const run = runFeature({
            interpreter,
            feature,
            definition: () => new FsMap(),
            instanceId: "addMyFunctions1",
        });
        try {
            const sizeCrimp = run.context.variables.get("sizeCrimp");
            const sizeOverlap = run.context.variables.get("sizeOverlap");
            expect(isCallable(sizeCrimp)).toBe(true);
            expect(isCallable(sizeOverlap)).toBe(true);
            // Arguments as the std represents lengths (a std ValueWithUnits on Onshape's std).
            const length = (value: number) => interpreter.adaptHostValue(inches(value));
            const crimp = (od: number) => inchesOf(interpreter.callFunction(sizeCrimp, [length(od)]));
            expect(crimp(4)).toBeCloseTo(3 / 8, 9);
            expect(crimp(5)).toBeCloseTo(3 / 8, 9);
            expect(crimp(8.625)).toBeCloseTo(1 / 2, 9);
            expect(crimp(9.625)).toBeCloseTo(5 / 8, 9);
            expect(crimp(14)).toBeCloseTo(3 / 4, 9);
            expect(crimp(24)).toBeCloseTo(1, 9);
            expect(crimp(30)).toBeCloseTo(1.5, 9);
            const overlap = (od: number, id: number) =>
                inchesOf(interpreter.callFunction(sizeOverlap, [length(od), length(id)]));
            expect(overlap(9.625, 6.625)).toBeCloseTo(1, 9);
            expect(overlap(7, 6.5)).toBeCloseTo(0.25, 9);
            expect(overlap(4, 4)).toBeCloseTo(1, 9);
            expect(overlap(4, 5)).toBeCloseTo(1, 9);
        } finally {
            run.context.dispose();
        }
    });

    test("Standard_Sizes lists every OD × smaller ID pair with fractional inch names", () => {
        const interpreter = interpreters[std];
        const module = interpreter.load({ path: `endCapFunctions-table-${std}`, source: SOURCE });
        const table = module.table("sizeTable");
        expect(table).not.toBeUndefined();
        const result = runTable({ interpreter, table: table!, bodies: [], definition: new FsMap() });
        expect(result.error).toBeUndefined();
        expect(result.tables).toHaveLength(1);
        const [sizes] = result.tables;
        expect(sizes.title).toBe("Standard Sizes");
        expect(sizes.columns.map((column) => column.name)).toEqual(["Size", "OD", "ID"]);
        expect(sizes.rows).toHaveLength(231);
        const names = sizes.rows.map((row) => row.cells["name"]?.text);
        expect(names[0]).toBe('4 1/2" x 4"');
        expect(names[1]).toBe('5" x 4"');
        expect(names[2]).toBe('5" x 4 1/2"');
        expect(names[3]).toBe('5 9/16" x 4"');
        expect(names[names.length - 1]).toBe('24" x 23"');
        expect(sizes.rows[0].cells["od"]?.text).toBe("114.3 mm");
        expect(sizes.rows[0].cells["id"]?.text).toBe("101.6 mm");
    });
});
