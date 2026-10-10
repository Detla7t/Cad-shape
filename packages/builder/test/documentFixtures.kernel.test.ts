// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Golden documents: `fixtures/documents/schema-<n>.json` are documents as saved by the build that
 * introduced schema n. Every one of them must keep loading — through the migrations once the
 * schema moves on — and the current one must serialize back exactly. A schema bump adds a new
 * fixture and keeps the old ones.
 *
 * Regenerate the current schema's fixture (only when it is meant to change):
 * `UPDATE_DOCUMENT_FIXTURES=1 npx rstest packages/builder/test/documentFixtures.kernel.test.ts`
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, openDocumentFile } from "@chili3d/app";
import {
    type ConfigurationInputData,
    canonicalSerializedTypeId,
    DOCUMENT_SCHEMA_VERSION,
    DocumentMigrationRegistry,
    documentSchemaHeader,
    type IApplication,
    type IDocument,
    type IEdge,
    InternalClassName,
    Material,
    Plane,
    type Serialized,
    ShapeTypes,
} from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import { DocumentFileNode } from "@chili3d/documents";
import {
    ConstraintKind,
    captureEdgeRef,
    initGarlicSync,
    ParametricBodyNode,
    SketchNode,
} from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "fixtures/documents");
const CURRENT = path.join(FIXTURES, `schema-${DOCUMENT_SCHEMA_VERSION}.json`);

beforeAll(async () => {
    initGarlicSync(readFileSync(path.resolve(here, "../../parametric/lib/garlic_bg.wasm")));
    await initWasm({ wasmBinary: readFileSync(path.resolve(here, "../../wasm/lib/chili-wasm.wasm")) });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    if (process.env["UPDATE_DOCUMENT_FIXTURES"] === "1") writeCurrentFixture();
});

const documents: IDocument[] = [];
afterEach(() => {
    for (const document of documents.splice(0)) document.dispose();
    rs.restoreAllMocks();
});

function newApp(): IApplication {
    const app = createMockApplication();
    app.loadDocument = (data: Serialized) => Document.load(app, data);
    return app;
}

const NOTES = "# Duct job\n\n- 26 ga galvanized\n- seams: Pittsburgh\n";
const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 254, 255]);
const WIDTH = { S: 40, L: 50 };
const HEIGHT = 20;
const DEPTH = 12;
const FILLET = 2;

/** The representative document: configured variables, a constrained sketch, a body with features, files. */
function representativeDocument(app: IApplication): Document {
    const doc = new Document(app, "Golden duct job", "golden-document");
    doc.modelManager.materials.push(new Material({ document: doc, name: "Galvanized", color: 0xb0b8c0 }));
    const inputs: ConfigurationInputData[] = [
        {
            kind: "list",
            id: "c1",
            name: "Size",
            options: [
                { id: "s", name: "S" },
                { id: "l", name: "L" },
            ],
            defaultOption: "s",
        },
        { kind: "checkbox", id: "c2", name: "Holes", defaultValue: false },
    ];
    doc.variables.setConfigurationInputs(inputs, { Size: "L", Holes: true });
    doc.variables.setItems([
        {
            id: "v1",
            name: "w",
            type: "length",
            expression: `configure(Size, "S": ${WIDTH.S}, "L": ${WIDTH.L})`,
        },
        { id: "v2", name: "h", type: "length", expression: `${DEPTH}` },
        { id: "v3", name: "half", type: "length", expression: "w / 2" },
    ]);

    const corner = (a: number, ai: number, b: number, bi: number, id: number) => ({
        id,
        kind: ConstraintKind.P2PCoincident,
        refs: [
            { entityId: a, pointIndex: ai },
            { entityId: b, pointIndex: bi },
        ],
    });
    const line = (kind: ConstraintKind, entityId: number, id: number, datum?: string) => ({
        id,
        kind,
        refs: [
            { entityId, pointIndex: 0 },
            { entityId, pointIndex: 1 },
        ],
        ...(datum === undefined ? {} : { datum }),
    });
    const sketch = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: {
            entities: [
                { id: 1, type: "line", params: [0, 0, WIDTH.L, 0] },
                { id: 2, type: "line", params: [WIDTH.L, 0, WIDTH.L, HEIGHT] },
                { id: 3, type: "line", params: [WIDTH.L, HEIGHT, 0, HEIGHT] },
                { id: 4, type: "line", params: [0, HEIGHT, 0, 0] },
            ],
            constraints: [
                corner(1, 1, 2, 0, 10),
                corner(2, 1, 3, 0, 11),
                corner(3, 1, 4, 0, 12),
                corner(4, 1, 1, 0, 13),
                line(ConstraintKind.Horizontal, 1, 14),
                line(ConstraintKind.Vertical, 2, 15),
                line(ConstraintKind.Horizontal, 3, 16),
                line(ConstraintKind.Vertical, 4, 17),
                line(ConstraintKind.P2PDistance, 1, 18, "w"),
                line(ConstraintKind.P2PDistance, 4, 19, `${HEIGHT} mm`),
            ],
        },
    });
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "f1", type: "extrude", sketchId: sketch.id, depth: "h" }],
    });
    doc.modelManager.addNode(body);
    // Round the vertical edge at the far corner (x = w, y = height).
    const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const index = edges.findIndex((edge) => {
        const [s, e] = [edge.startPoint(), edge.endPoint()];
        return (
            Math.abs(s.x - WIDTH.L) < 1e-6 &&
            Math.abs(e.x - WIDTH.L) < 1e-6 &&
            Math.abs(s.y - HEIGHT) < 1e-6 &&
            Math.abs(e.y - HEIGHT) < 1e-6
        );
    });
    if (index < 0) throw new Error("the corner edge was not found");
    const edgeId = body.edgeIdAt(index);
    const ref = captureEdgeRef(edges[index], edgeId, body.edgeIdIsShared(edgeId));
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "f2", type: "fillet", radius: FILLET, edges: [ref] },
    ]);

    doc.modelManager.addNode(new DocumentFileNode({ document: doc, fileName: "Notes.md", text: NOTES }));
    doc.modelManager.addNode(new DocumentFileNode({ document: doc, fileName: "Photo.png", bytes: PHOTO }));
    return doc;
}

function writeCurrentFixture(): void {
    const doc = representativeDocument(newApp());
    try {
        const body = doc.modelManager.findNodes(
            (node) => node instanceof ParametricBodyNode,
        )[0] as ParametricBodyNode;
        const errors = body.featureItems().map((item) => item.error);
        if (errors.some((error) => error !== undefined)) throw new Error(`fixture body failed: ${errors}`);
        mkdirSync(FIXTURES, { recursive: true });
        writeFileSync(CURRENT, `${JSON.stringify(doc.serialize(), null, 4)}\n`);
    } finally {
        doc.dispose();
    }
}

const readFixture = (file: string) =>
    JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as Serialized;
// Listed when the tests are collected; a fixture written by UPDATE_DOCUMENT_FIXTURES is checked from the next run.
const fixtureFiles = () =>
    existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((file) => /^schema-\d+\.json$/.test(file)) : [];

async function load(data: Serialized, migrations?: DocumentMigrationRegistry): Promise<Document> {
    const app = newApp();
    const loaded = await Document.load(app, structuredClone(data), migrations);
    expect(loaded).toBeInstanceOf(Document);
    documents.push(loaded as Document);
    return loaded as Document;
}

const bodyOf = (doc: IDocument) =>
    doc.modelManager.findNodes((node) => node instanceof ParametricBodyNode)[0] as ParametricBodyNode;
const filesOf = (doc: IDocument) =>
    doc.modelManager.findNodes((node) => node instanceof DocumentFileNode) as DocumentFileNode[];

/** Every `__cla$$__` in a serialized value. */
function typeIds(value: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(value)) for (const item of value) typeIds(item, into);
    else if (typeof value === "object" && value !== null) {
        const tag = (value as Record<string, unknown>)[InternalClassName];
        if (typeof tag === "string") into.add(tag);
        for (const item of Object.values(value)) typeIds(item, into);
    }
    return into;
}

const EXPECTED_VOLUME = WIDTH.L * HEIGHT * DEPTH - FILLET * FILLET * (1 - Math.PI / 4) * DEPTH;

describe("golden documents", () => {
    test("there is a fixture for the current schema and none for a future one", () => {
        const versions = fixtureFiles().map((file) => Number(/\d+/.exec(file)![0]));
        expect(versions).toContain(DOCUMENT_SCHEMA_VERSION);
        expect(Math.max(...versions)).toBe(DOCUMENT_SCHEMA_VERSION);
    });

    test.each(
        fixtureFiles(),
    )("%s loads with its body, sketch, variables, configuration and files", async (file) => {
        const doc = await load(readFixture(file));

        expect(doc.variables.activeConfiguration).toEqual({ Size: "L", Holes: true });
        expect(doc.variables.configurationInputs.map((input) => input.name)).toEqual(["Size", "Holes"]);
        const scope = doc.variables.evaluate().scope;
        expect(scope.get("w")?.value).toBe(WIDTH.L);
        expect(scope.get("half")?.value).toBe(WIDTH.L / 2);

        const sketch = doc.modelManager.findNodes((node) => node instanceof SketchNode)[0] as SketchNode;
        expect(sketch.data.constraints).toHaveLength(10);
        const [x1, , x2] = sketch.data.entities[0].params;
        expect(Math.abs(x2 - x1)).toBeCloseTo(WIDTH.L, 6);

        const body = bodyOf(doc);
        expect(body.features.map((feature) => feature.type)).toEqual(["extrude", "fillet"]);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.boundingBox().max.z).toBeCloseTo(DEPTH, 6);
        expect(body.shape.value.volume()).toBeCloseTo(EXPECTED_VOLUME, 3);

        const files = filesOf(doc);
        expect(files.map((node) => node.fileName)).toEqual(["Notes.md", "Photo.png"]);
        expect(files[0].text).toBe(NOTES);
        expect([...files[1].bytes]).toEqual([...PHOTO]);
        expect(doc.modelManager.materials.map((material) => material.name)).toContain("Galvanized");
    });

    test.each(fixtureFiles())("%s only uses serialized type ids this build reads", (file) => {
        const ids = [...typeIds(readFixture(file))].filter((id) => id !== "Document");
        expect(ids.length).toBeGreaterThan(5);
        expect(ids.filter((id) => canonicalSerializedTypeId(id) === undefined)).toEqual([]);
    });

    test("the current fixture serializes back exactly (the writer has not drifted)", async () => {
        const fixture = readFixture(`schema-${DOCUMENT_SCHEMA_VERSION}.json`);
        const doc = await load(fixture);
        const { appVersion: _written, ...expected } = fixture;
        const { appVersion, ...actual } = JSON.parse(JSON.stringify(doc.serialize()));
        expect(appVersion).toBe(__APP_VERSION__);
        expect(actual).toEqual(expected);
        expect(actual).toMatchObject({ schemaVersion: DOCUMENT_SCHEMA_VERSION });
    });

    test("migrations run in order on a stored document before it deserializes", async () => {
        const fixture = readFixture(`schema-${DOCUMENT_SCHEMA_VERSION}.json`);
        const registry = new DocumentMigrationRegistry(DOCUMENT_SCHEMA_VERSION + 2);
        const order: string[] = [];
        // Registered out of order: the later schema step must still run second.
        registry.register({
            version: DOCUMENT_SCHEMA_VERSION + 2,
            id: "record the rename",
            migrate: (document) => {
                order.push("record");
                const names = (document["variables"] as { name: string }[]).map((item) => item.name);
                if (!names.includes("depth")) throw new Error("ran before the rename");
                document["userData"] = { ...document["userData"], migrated: [...order] };
                return document;
            },
        });
        registry.register({
            version: DOCUMENT_SCHEMA_VERSION + 1,
            id: "rename h to depth",
            migrate: (document) => {
                order.push("rename");
                for (const item of document["variables"] as { name: string }[])
                    if (item.name === "h") item.name = "depth";
                for (const node of document["models"]["nodes"] as Serialized[]) {
                    if (node[InternalClassName] !== "ParametricBodyNode") continue;
                    const features = JSON.parse(node["featuresJson"]) as { depth?: unknown }[];
                    for (const feature of features) if (feature.depth === "h") feature.depth = "depth";
                    node["featuresJson"] = JSON.stringify(features);
                }
                return document;
            },
        });

        const doc = await load(fixture, registry);

        expect(order).toEqual(["rename", "record"]);
        expect(doc.userData["migrated"]).toEqual(["rename", "record"]);
        expect(doc.variables.items.map((item) => item.name)).toEqual(["w", "depth", "half"]);
        const body = bodyOf(doc);
        expect(body.features[0]).toMatchObject({ type: "extrude", depth: "depth" });
        expect(body.shape.value.volume()).toBeCloseTo(EXPECTED_VOLUME, 3);
        // The fixture itself is untouched.
        expect(readFixture(`schema-${DOCUMENT_SCHEMA_VERSION}.json`)).toEqual(fixture);
    });

    test("a document with a newer schema is refused: nothing loads, the caller gets the reason", async () => {
        const newer = {
            ...readFixture(`schema-${DOCUMENT_SCHEMA_VERSION}.json`),
            ...documentSchemaHeader("99.0.0", DOCUMENT_SCHEMA_VERSION + 1),
        };
        const alert = rs.fn((_message?: string) => {});
        rs.stubGlobal("alert", alert);
        try {
            const app = newApp();
            const loaded = await Document.load(app, newer);
            expect(loaded).toBeUndefined();
            expect(app.documents.size).toBe(0);
            expect(alert).toHaveBeenCalledTimes(1);
            expect(alert.mock.calls[0][0]).toContain("Chili3D 99.0.0");

            // Opening the file reports it as a result, before any document exists.
            const opened = await openDocumentFile(newApp(), new Blob([JSON.stringify(newer)]));
            expect(opened.isOk).toBe(false);
            expect(opened.error).toContain(`schema ${DOCUMENT_SCHEMA_VERSION + 1}`);
            expect(alert).toHaveBeenCalledTimes(1);
        } finally {
            rs.unstubAllGlobals();
        }
    });
});
