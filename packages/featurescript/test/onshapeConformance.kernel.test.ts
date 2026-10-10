// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { cases, differences, FIXTURES } from "../../../scripts/onshape-conformance.mjs";
import { FsContext } from "../src/context/fsContext";
import { FsArray, FsMap, type FsValue } from "../src/lang/values";
import { describeStatus, featureState } from "../src/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../src/onshape/onshapeStd";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";
import "./_helpers/cadHost";

const originalFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
const reports: Record<string, unknown>[] = [];
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
afterAll(() => {
    if (originalFactory) Object.defineProperty(globalThis, "shapeFactory", originalFactory);
    if (process.env["ONSHAPE_LOCAL_REPORT"])
        writeFileSync(
            process.env["ONSHAPE_LOCAL_REPORT"],
            JSON.stringify({ engine: "Chili3D", libraryVersion: 3083, cases: reports }, null, 2),
        );
});

function plain(value: FsValue): unknown {
    if (value instanceof FsArray) return value.items.map(plain);
    if (value instanceof FsMap)
        return Object.fromEntries(value.pairs().map(([k, v]) => [String(k), plain(v)]));
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
    throw new Error("Conformance fixtures must return dimensionless JSON values");
}

const referencePath = path.join(FIXTURES, "onshape-reference.json");
const reference = JSON.parse(readFileSync(referencePath, "utf8"));

describe("shared FeatureScript fixtures on a cold Chili3D context", () => {
    test.each(cases())("$id", (item) => {
        const interpreter = createOnshapeInterpreter({ std: ONSHAPE_STD });
        const context = new FsContext();
        try {
            const module = interpreter.load({
                path: "conformance",
                source: `FeatureScript 3083; import(path : "onshape/std/geometry.fs", version : "3083.0"); export const run = ${item.source};`,
            });
            const run = () =>
                interpreter.callFunction(module.env.lookup("run")?.value, [
                    context.value,
                    new FsMap(Object.entries(item.inputs as Record<string, FsValue>) as [string, FsValue][]),
                ]);
            const expected = reference.cases.find((c: { id: string }) => c.id === item.id);
            expect(expected, "Missing Onshape run").not.toBeUndefined();
            expect(expected.sourceSha256, "Stale Onshape run").toBe(item.sourceSha256);
            expect(expected.inputs).toEqual(item.inputs);
            expect(expected.error).toBeUndefined();
            if (item.expectedUnsupported) {
                expect(run).toThrow(item.expectedUnsupported);
                expect(context.bodies.filter((b) => b.isModelGeometry)).toHaveLength(0);
                reports.push({
                    id: item.id,
                    sourceSha256: item.sourceSha256,
                    inputs: item.inputs,
                    error: item.expectedUnsupported,
                });
                return;
            }
            const output = run();
            const errors = [...featureState(context).status.values()]
                .map(describeStatus)
                .filter((s) => s.kind === "ERROR");
            if (item.expectedOperationErrors) expect(errors.length).toBeGreaterThan(0);
            else expect(errors).toEqual([]);
            const bodies = context.bodies.filter((b) => b.isModelGeometry);
            expect(bodies.length).toBeGreaterThan(0);
            expect(bodies.every((b) => b.shape.checkShape())).toBe(true);
            const result = plain(output);
            reports.push({
                id: item.id,
                sourceSha256: item.sourceSha256,
                inputs: item.inputs,
                result,
            });
            const mismatches = differences(
                expected.result,
                result,
                "$",
                item.absoluteTolerance,
                item.relativeTolerance,
            );
            if (item.knownDifferencePaths) {
                // Keep each observed incompatibility visible and narrowly bounded; do not call it parity.
                expect(mismatches.map((message: string) => message.split(":")[0])).toEqual(
                    item.knownDifferencePaths,
                );
            } else expect(mismatches).toEqual([]);
        } catch (error) {
            if (!reports.some((r) => r["id"] === item.id))
                reports.push({
                    id: item.id,
                    sourceSha256: item.sourceSha256,
                    inputs: item.inputs,
                    error: String(error),
                });
            throw error;
        } finally {
            context.dispose();
        }
    });
});
