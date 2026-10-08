// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Serializer } from "@chili3d/core";
import {
    createMockApplication,
    createMockDocument,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { cases } from "../../../../scripts/onshape-conformance.mjs";
import { FsContext } from "../../src/featurescript/context/fsContext";
import { FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import { FsMap } from "../../src/featurescript/lang/values";
import { describeStatus, featureState } from "../../src/featurescript/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { provideOnshapeStd } from "../../src/featurescript/runtime";
import {
    insertStandardFeature,
    STANDARD_FEATURE_SOURCE,
    STANDARD_FEATURES,
} from "../../src/featurescript/standardFeatures";
import {
    compileDocumentStudio,
    compileStudioSource,
    documentStudios,
} from "../../src/featurescript/studioCompiler";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

const originalFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    provideOnshapeStd(ONSHAPE_STD);
});
afterAll(() => {
    provideOnshapeStd(undefined);
    if (originalFactory) Object.defineProperty(globalThis, "shapeFactory", originalFactory);
});

function newDoc() {
    const doc = new TestDocument({
        application: createMockApplication(),
        selection: createMockDocument().selection,
    });
    doc.visual = createMockVisualWithDocument(doc) as typeof doc.visual;
    return doc;
}

test.each([
    {
        id: "draft-feature",
        call: "draft",
        wrapper: "neutralPlaneDraft",
        measure: "volume",
        expected: 4127.496144703928,
    },
    {
        id: "spline-feature-False",
        call: "fitSpline",
        wrapper: "splineThroughVertices",
        measure: "length",
        expected: 27.864022183348084,
    },
    { id: "fill-feature", call: "fill", wrapper: "fillBoundary", measure: "area", expected: 400 },
])("insertable $wrapper cold-rebuilds the live-reference fixture", (tool) => {
    const item = cases().find((candidate) => candidate.id === tool.id)!;
    let source = item.source.replace(`${tool.call}(context,`, `${tool.wrapper}(context,`);
    if (tool.call === "fill")
        source = source.replace(
            /fillBoundary\(context,[\s\S]*?\);/,
            `fillBoundary(context, id + "result", { "boundary" : qCreatedBy(id + "boundary", EntityType.EDGE), "guides" : qNothing() });`,
        );
    const interpreter = createOnshapeInterpreter({
        std: ONSHAPE_STD,
        resolveModule: (name) =>
            name === "tools" ? { path: name, source: STANDARD_FEATURE_SOURCE } : undefined,
    });
    const module = interpreter.load({
        path: "wrapper-test",
        source: `FeatureScript 3083; import(path : "onshape/std/geometry.fs", version : "3083.0"); import(path : "tools", version : ""); export const run = ${source};`,
    });
    const context = new FsContext();
    try {
        const result = interpreter.callFunction(module.env.lookup("run")?.value, [
            context.value,
            new FsMap(Object.entries(item.inputs)),
        ]);
        expect(result).toBeInstanceOf(FsMap);
        expect((result as FsMap).field(tool.measure)).toBeCloseTo(tool.expected, 5);
        expect(
            [...featureState(context).status.values()].map(describeStatus).filter((s) => s.kind === "ERROR"),
        ).toEqual([]);
        expect(context.bodies.filter((b) => b.isModelGeometry).every((b) => b.shape.checkShape())).toBe(true);
    } finally {
        context.dispose();
    }
});

test("standard wrappers expose only supported parameters through the existing feature editor", () => {
    const compiled = compileStudioSource("tools-test", "Tools", STANDARD_FEATURE_SOURCE, () => undefined);
    expect(compiled.error).toBeUndefined();
    expect(compiled.features.map((feature) => feature.name)).toEqual(
        STANDARD_FEATURES.map((feature) => feature.featureName),
    );
    const draft = compiled.spec("neutralPlaneDraft");
    expect(draft?.parameters.map((p) => [p.key, p.kind])).toEqual([
        ["neutralPlane", "query"],
        ["draftFaces", "query"],
        ["angle", "angle"],
        ["pullDirection", "boolean"],
        ["tangentPropagation", "boolean"],
    ]);
    expect(compiled.spec("splineThroughVertices")?.parameters.map((p) => p.key)).toEqual([
        "vertices",
        "closed",
    ]);
    expect(compiled.spec("fillBoundary")?.parameters.map((p) => p.key)).toEqual(["boundary", "guides"]);
});

test("insert, undo and redo keep the standard source and feature together; source survives serialization", async () => {
    const doc = newDoc();
    const inserted = insertStandardFeature(doc, "neutralPlaneDraft");
    expect(inserted.isOk).toBe(true);
    const studio = documentStudios(doc)[0];
    expect(studio).toBeInstanceOf(FeatureStudioNode);
    expect(inserted.value.features).toHaveLength(1);
    expect(inserted.value.features[0]).toMatchObject({
        type: "featurescript",
        studioId: studio.id,
        featureName: "neutralPlaneDraft",
    });
    expect(studio.source).toBe(STANDARD_FEATURE_SOURCE);
    const serialized = Serializer.serializeObject(studio);
    const reopened = newDoc();
    const copy = Serializer.deserializeObject(reopened, serialized) as FeatureStudioNode;
    reopened.modelManager.addNode(copy);
    const compiled = compileDocumentStudio(reopened, copy.id);
    expect(compiled?.error).toBeUndefined();
    expect(compiled?.features.map((f) => f.name)).toEqual(STANDARD_FEATURES.map((f) => f.featureName));
    await doc.history.undo();
    expect(documentStudios(doc)).toHaveLength(0);
    expect(doc.modelManager.findNode((n) => n.id === inserted.value.id)).toBeUndefined();
    await doc.history.redo();
    expect(documentStudios(doc)).toHaveLength(1);
    expect(doc.modelManager.findNode((n) => n.id === inserted.value.id)?.id).toBe(inserted.value.id);
    const again = insertStandardFeature(doc, "splineThroughVertices");
    expect(again.isOk).toBe(true);
    expect(documentStudios(doc)).toHaveLength(1);
});
