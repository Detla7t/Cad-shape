// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import { FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import {
    compileStudio,
    createInterpreter,
    markOnshapeStdUnavailable,
    onshapeStdVersion,
    provideOnshapeStd,
} from "../../src/featurescript/runtime";
import { compileDocumentStudio, compileStudioSource } from "../../src/featurescript/studioCompiler";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

afterEach(() => provideOnshapeStd(undefined));

const source = {
    path: "studio.fs",
    source: 'FeatureScript 3083; import(path : "onshape/std/geometry.fs", version : "3083.0"); export const length = 3 * millimeter;',
};

test("a failed configured std prevents silently evaluating studios against the native std", () => {
    markOnshapeStdUnavailable(new Error("Asset download failed"));
    expect(() => createInterpreter()).toThrow("Asset download failed");
    const result = compileStudio(source);
    expect(result.error).toContain("Onshape's standard library could not be loaded");
    expect(result.module).toBeUndefined();
    expect(result.features).toEqual([]);
    expect(result.tables).toEqual([]);
});

test("providing the std after a load failure restores compilation", () => {
    markOnshapeStdUnavailable(new Error("Asset download failed"));
    provideOnshapeStd(ONSHAPE_STD);
    const result = compileStudio(source);
    expect(result.error).toBeUndefined();
    expect(result.module?.exports.has("length")).toBe(true);
    expect(onshapeStdVersion()).toBe(3083);
});

test("a load failure also invalidates an already cached interpreter", () => {
    provideOnshapeStd(ONSHAPE_STD);
    expect(compileStudio(source).error).toBeUndefined();
    markOnshapeStdUnavailable("The replacement std is unavailable");
    expect(compileStudio(source).error).toContain("The replacement std is unavailable");
    expect(onshapeStdVersion()).toBeUndefined();
});

test("cached studio compilation reports std failure and retries after recovery", () => {
    provideOnshapeStd(ONSHAPE_STD);
    const compile = () => compileStudioSource("runtime-cache", "Runtime", source.source, () => undefined);
    expect(compile().error).toBeUndefined();
    markOnshapeStdUnavailable("std is offline");
    expect(compile().error).toContain("std is offline");
    expect(compile().features).toEqual([]);
    provideOnshapeStd(ONSHAPE_STD);
    expect(compile().error).toBeUndefined();
});

test("reopened and validation documents do not reuse a live studio's interpreter", () => {
    const first = new TestDocument();
    const second = new TestDocument();
    try {
        for (const document of [first, second])
            document.modelManager.addNode(
                new FeatureStudioNode({ document, id: "same-studio", source: "export const n = 1;" }),
            );
        const a = compileDocumentStudio(first, "same-studio");
        const b = compileDocumentStudio(second, "same-studio");
        expect(a?.error).toBeUndefined();
        expect(b?.error).toBeUndefined();
        expect(a?.module?.exports.get("n")).toBe(1);
        expect(b?.module?.exports.get("n")).toBe(1);
        expect(a?.interpreter).not.toBe(b?.interpreter);
        expect(compileDocumentStudio(first, "same-studio")).toBe(a);
    } finally {
        first.dispose();
        second.dispose();
    }
});
