// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    DOCUMENT_SCHEMA_VERSION,
    type DocumentMigration,
    DocumentMigrationRegistry,
    documentMigrations,
    documentSchemaHeader,
    LEGACY_DOCUMENT_VERSION,
    Logger,
    legacyDocumentVersion,
    prepareDocumentForLoad,
    type Serialized,
} from "../src";

function documentAt(schemaVersion: number | undefined, extra: Record<string, unknown> = {}): Serialized {
    return {
        __cla$$__: "Document",
        ...(schemaVersion === undefined
            ? { version: LEGACY_DOCUMENT_VERSION }
            : documentSchemaHeader("9.9.9", schemaVersion)),
        id: "doc",
        name: "Doc",
        models: { components: [], nodes: [], materials: [] },
        variables: [],
        acts: [],
        userData: {},
        ...extra,
    };
}

/** A migration that appends its id to `steps`, so the order they ran in is visible in the output. */
function step(version: number, id: string): DocumentMigration {
    return {
        version,
        id,
        migrate: (document) => {
            document["steps"] = [...(document["steps"] ?? []), id];
            return document;
        },
    };
}

describe("document schema header", () => {
    test("schema 1 keeps the legacy version marker older builds open; later schemas replace it", () => {
        expect(documentSchemaHeader("0.8.0", 1)).toEqual({
            version: LEGACY_DOCUMENT_VERSION,
            schemaVersion: 1,
            appVersion: "0.8.0",
        });
        expect(legacyDocumentVersion(2)).toBe("schema-2");
        expect(documentSchemaHeader("0.9.0", 3).version).toBe("schema-3");
    });

    test("the application's registry reads the current schema", () => {
        expect(documentMigrations.supportedVersion).toBe(DOCUMENT_SCHEMA_VERSION);
        const prepared = prepareDocumentForLoad(documentAt(DOCUMENT_SCHEMA_VERSION));
        expect(prepared.isOk).toBe(true);
        expect(prepared.value.fromVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    });
});

describe("schemaVersionOf", () => {
    const registry = new DocumentMigrationRegistry(3);

    test("a document without schemaVersion but with the legacy version is schema 1", () => {
        const version = registry.schemaVersionOf(documentAt(undefined));
        expect(version.isOk).toBe(true);
        expect(version.value).toBe(1);
    });

    test("reads schemaVersion and ignores the version marker then", () => {
        const version = registry.schemaVersionOf({ ...documentAt(2), version: "anything" });
        expect(version.value).toBe(2);
    });

    test("refuses a newer schema with who wrote it and what this build reads", () => {
        const version = registry.schemaVersionOf(documentAt(4));
        expect(version.isOk).toBe(false);
        expect(version.error).toMatchObject({
            kind: "newer",
            schemaVersion: 4,
            supportedVersion: 3,
            appVersion: "9.9.9",
        });
        expect(version.error.message).toContain("Chili3D 9.9.9");
        expect(version.error.message).toContain("schema 4");
    });

    test("a document without schemaVersion is schema 1 whatever its version marker says", () => {
        const warn = rs.spyOn(Logger, "warn").mockImplementation(() => {});
        try {
            // The Turbopack builds of 9 October 2026 wrote the marker with embedded quotes.
            const quoted = registry.schemaVersionOf({ ...documentAt(undefined), version: '"0.7.1"' });
            expect(quoted.isOk).toBe(true);
            expect(quoted.value).toBe(1);
            expect(registry.schemaVersionOf({ ...documentAt(undefined), version: "0.6" }).value).toBe(1);
            expect(registry.schemaVersionOf({ ...documentAt(undefined), version: undefined }).value).toBe(1);
            expect(warn).toHaveBeenCalledTimes(3);
            expect(String(warn.mock.calls[0][0])).toContain('"\\"0.7.1\\""');
            // The legacy marker itself is silent.
            expect(registry.schemaVersionOf(documentAt(undefined)).value).toBe(1);
            expect(warn).toHaveBeenCalledTimes(3);
        } finally {
            warn.mockRestore();
        }
    });

    test.each([
        ["not an object", "document"],
        ["an array", []],
        ["a string schema", { ...documentAt(1), schemaVersion: "2" }],
        ["a fractional schema", { ...documentAt(1), schemaVersion: 1.5 }],
        ["schema 0", { ...documentAt(1), schemaVersion: 0 }],
    ])("refuses %s as invalid", (_name, data) => {
        expect(registry.schemaVersionOf(data).error.kind).toBe("invalid");
    });
});

describe("DocumentMigrationRegistry", () => {
    test("runs the migrations above the document's schema by version, then registration order", () => {
        const registry = new DocumentMigrationRegistry(4);
        registry.register(step(4, "d"));
        registry.register(step(2, "a"));
        registry.register(step(3, "b"));
        registry.register(step(3, "c"));
        expect(registry.migrations().map((x) => x.id)).toEqual(["a", "b", "c", "d"]);

        const fromOne = registry.prepare(documentAt(1));
        expect(fromOne.value.applied).toEqual(["a", "b", "c", "d"]);
        expect(fromOne.value.document["steps"]).toEqual(["a", "b", "c", "d"]);
        expect(fromOne.value.fromVersion).toBe(1);

        const fromThree = registry.prepare(documentAt(3));
        expect(fromThree.value.applied).toEqual(["d"]);
        expect(fromThree.value.document["steps"]).toEqual(["d"]);
    });

    test("stamps the migrated document with the supported schema and never modifies the input", () => {
        const registry = new DocumentMigrationRegistry(2);
        registry.register(step(2, "a"));
        const input = documentAt(undefined);
        const before = structuredClone(input);

        const prepared = registry.prepare(input);
        expect(prepared.value.document).toMatchObject({
            schemaVersion: 2,
            version: "schema-2",
            steps: ["a"],
        });
        expect(input).toEqual(before);
    });

    test("a current document passes through untouched", () => {
        const registry = new DocumentMigrationRegistry(2);
        registry.register(step(2, "a"));
        const input = documentAt(2);
        const prepared = registry.prepare(input);
        expect(prepared.value.document).toBe(input);
        expect(prepared.value.applied).toEqual([]);
    });

    test("a migration that throws or returns nothing fails the load and names itself", () => {
        const registry = new DocumentMigrationRegistry(3);
        registry.register(step(2, "fine"));
        registry.register({
            version: 3,
            id: "broken",
            migrate: () => {
                throw new Error("no models");
            },
        });
        const failed = registry.prepare(documentAt(1));
        expect(failed.error).toMatchObject({ kind: "migration", migration: "broken", schemaVersion: 1 });
        expect(failed.error.message).toContain("no models");

        const empty = new DocumentMigrationRegistry(2);
        empty.register({ version: 2, id: "empty", migrate: () => undefined as unknown as Serialized });
        expect(empty.prepare(documentAt(1)).error.migration).toBe("empty");
    });

    test("rejects a migration outside 2…supported and a repeated id", () => {
        const registry = new DocumentMigrationRegistry(2);
        expect(() => registry.register(step(1, "too old"))).toThrow(/targets schema 1/);
        expect(() => registry.register(step(3, "too new"))).toThrow(/supports 2…2/);
        expect(() => registry.register(step(2.5, "fraction"))).toThrow(/targets schema 2.5/);
        registry.register(step(2, "a"));
        expect(() => registry.register(step(2, "a"))).toThrow(/already registered/);
    });

    test("the function register returns removes the migration", () => {
        const registry = new DocumentMigrationRegistry(2);
        const remove = registry.register(step(2, "a"));
        remove();
        expect(registry.migrations()).toEqual([]);
        expect(registry.prepare(documentAt(1)).value.applied).toEqual([]);
    });

    test("refuses a newer document before running any migration", () => {
        const registry = new DocumentMigrationRegistry(2);
        const migrate = rs.fn((document: Serialized) => document);
        registry.register({ version: 2, id: "a", migrate });
        expect(registry.prepare(documentAt(3)).error.kind).toBe("newer");
        expect(migrate).not.toHaveBeenCalled();
    });
});
