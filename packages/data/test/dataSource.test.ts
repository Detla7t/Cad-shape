// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    evaluateExpression,
    findPropertySplitter,
    InternalClassName,
    packProject,
    type Serialized,
    Serializer,
    Transaction,
    unpackProject,
    VariableStudioNode,
} from "@chili3d/core";
import { rs } from "@rstest/core";
import {
    clearSessionSecrets,
    collectDataDependencies,
    type DataSourceNode,
    dataSourcesOf,
    dependenciesOn,
    excelOnlineExport,
    googleSheetExports,
    importVariablesFromTable,
    parseSnapshot,
} from "../src";
import { csvSource, newDoc, sourceOf, sqliteFile, useNodeSqlJs, utf8 } from "./_helpers";

beforeAll(() => useNodeSqlJs());

const DIMS = "Name,Value\nDepth,10\nAngle,30 deg";

function evaluate(doc: ReturnType<typeof newDoc>, expression: string) {
    return evaluateExpression(expression, doc.variables.evaluate().scope);
}

/** A typed fetch mock answering `body` with `type` for every request. */
function answering(body: string, init: ResponseInit & { type?: string } = {}) {
    return rs.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(body, {
                status: init.status ?? 200,
                statusText: init.statusText,
                headers: { "content-type": init.type ?? "application/json" },
            }),
    );
}

function requestOf(mock: ReturnType<typeof answering>, call = 0) {
    const [input, init] = mock.mock.calls[call];
    return { url: String(input), init: init ?? {}, headers: new Headers(init?.headers) };
}

afterEach(() => {
    rs.unstubAllGlobals();
});

// ------------------------------------------------------------------ The node

describe("a Data Source in a document", () => {
    test("attaching a file caches typed tables and re-scopes the document", async () => {
        const doc = newDoc();
        const before = doc.variables.revision;
        const source = await csvSource(doc, "Dims", DIMS);
        expect(source.tables).toEqual([
            {
                name: "dims",
                columns: ["Name", "Value"],
                rows: [
                    ["Depth", 10],
                    ["Angle", "30 deg"],
                ],
                hasHeader: true,
            },
        ]);
        expect(source.status.state).toBe("ready");
        expect(doc.variables.revision).toBeGreaterThan(before);
        expect(evaluate(doc, 'data("Dims", "B2")').value.value).toBe(10);
    });

    test("a refresh that finds the same tables writes nothing", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        const revision = doc.variables.revision;
        const json = source.snapshotJson;
        const read = await source.refresh();
        expect(read.isOk).toBe(true);
        expect(source.snapshotJson).toBe(json);
        expect(doc.variables.revision).toBe(revision);
    });

    test("an edit of the attachment is one undo step with its tables", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        await source.apply({ fileText: "Name,Value\nDepth,25" });
        expect(evaluate(doc, 'data("Dims", "B2")').value.value).toBe(25);
        doc.history.undo();
        expect(source.fileText).toBe(DIMS);
        expect(evaluate(doc, 'data("Dims", "B2")').value.value).toBe(10);
        doc.history.redo();
        expect(evaluate(doc, 'data("Dims", "B2")').value.value).toBe(25);
    });

    test("a broken attachment leaves no tables and says why", async () => {
        const doc = newDoc();
        const source = await sourceOf(doc, "Feed", { kind: "file" });
        const read = await source.attachFile("feed.json", utf8("{broken"));
        expect(read.isOk).toBe(false);
        expect(source.status).toMatchObject({ state: "error" });
        expect(source.status.message).toMatch(/^Not valid JSON/);
        expect(evaluate(doc, 'data("Feed", "A1")').error).toMatch(
            /^Data source "Feed" has no tables yet: Not valid JSON/,
        );
    });

    test("renaming or removing a source re-scopes what reads it", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        Transaction.execute(doc, "rename", () => {
            source.name = "Sizes";
        });
        expect(evaluate(doc, 'data("Sizes", "B2")').value.value).toBe(10);
        expect(evaluate(doc, 'data("Dims", "B2")').error).toMatch(/^Unknown data table "Dims"/);
        Transaction.execute(doc, "remove", () => source.parent?.remove(source));
        expect(evaluate(doc, 'data("Sizes", "B2")').error).toMatch(/the document has no data sources/);
        doc.history.undo();
        expect(evaluate(doc, 'data("Sizes", "B2")').value.value).toBe(10);
    });

    test("switching kind drops the attachment and its tables", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        source.setKind("http");
        expect(source.definition).toMatchObject({ kind: "http", url: "" });
        expect(source.fileText).toBe("");
        expect(source.tables).toEqual([]);
        doc.history.undo();
        expect(source.definition.kind).toBe("file");
        expect(source.tables).toHaveLength(1);
    });
});

// ------------------------------------------------------------------ Web sources

describe("HTTP sources", () => {
    test("GET JSON: the rows at the JSON path; secret headers come from the session", async () => {
        const doc = newDoc();
        const fetch = answering(
            JSON.stringify({ result: { parts: [{ name: "Bracket", length: "12 mm" }] } }),
        );
        rs.stubGlobal("fetch", fetch);
        const source = await sourceOf(doc, "Api", {
            kind: "http",
            url: "https://api.example.com/parts",
            headers: [
                { name: "Accept", value: "application/json" },
                { name: "Authorization", value: "Bearer s3cret", secret: true },
            ],
            jsonPath: "result.parts",
            tableName: "parts",
        });
        const read = await source.refresh();
        expect(read.isOk).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        const request = requestOf(fetch);
        expect(request.url).toBe("https://api.example.com/parts");
        expect(request.init.method).toBe("GET");
        expect(request.headers.get("authorization")).toBe("Bearer s3cret");
        expect(request.headers.get("accept")).toBe("application/json");
        expect(source.tables).toEqual([
            { name: "parts", columns: ["name", "length"], rows: [["Bracket", "12 mm"]], hasHeader: true },
        ]);
        expect(evaluate(doc, 'lookup("Api", "name", "Bracket", "length")').value.value).toBe(12);
    });

    test("POST with a JSON body adds its content type; a CSV answer is read as CSV", async () => {
        const doc = newDoc();
        const fetch = answering("a,b\n1,2", { type: "text/csv; charset=utf-8" });
        rs.stubGlobal("fetch", fetch);
        const source = await sourceOf(doc, "Report", {
            kind: "http",
            url: "https://api.example.com/report",
            method: "POST",
            body: '{"year": 2026}',
        });
        await source.refresh();
        const request = requestOf(fetch);
        expect(request.init.method).toBe("POST");
        expect(request.init.body).toBe('{"year": 2026}');
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(source.tables[0].rows).toEqual([[1, 2]]);
    });

    test("a failed refresh keeps the last tables, offline-first, and reports the failure", async () => {
        const doc = newDoc();
        rs.stubGlobal("fetch", answering(JSON.stringify([{ v: 1 }])));
        const source = await sourceOf(doc, "Api", { kind: "http", url: "https://api.example.com/v" });
        await source.refresh();
        rs.stubGlobal(
            "fetch",
            answering("upstream down", { status: 503, statusText: "Service Unavailable" }),
        );
        const failed = await source.refresh();
        expect(failed.error).toBe(
            "https://api.example.com/v answered 503 Service Unavailable: upstream down",
        );
        expect(source.status.state).toBe("error");
        expect(evaluate(doc, 'data("Api", "A2")').value.value).toBe(1);
        rs.stubGlobal(
            "fetch",
            rs.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
                throw new TypeError("Failed to fetch");
            }),
        );
        expect((await source.refresh()).error).toMatch(
            /^Could not reach api\.example\.com: Failed to fetch\. .*CORS/,
        );
    });

    test("a missing secret, a bad URL and a non-http URL are errors before any request", async () => {
        const doc = newDoc();
        const fetch = answering("[]");
        rs.stubGlobal("fetch", fetch);
        const secret = await sourceOf(doc, "A", {
            kind: "http",
            url: "https://x.example.com",
            headers: [{ name: "Authorization", secret: true }],
        });
        expect((await secret.refresh()).error).toMatch(/^Enter the value of "Authorization"/);
        const bad = await sourceOf(doc, "B", { kind: "http", url: "not a url" });
        expect((await bad.refresh()).error).toBe("Not a URL: not a url");
        const file = await sourceOf(doc, "C", { kind: "http", url: "file:///etc/passwd" });
        expect((await file.refresh()).error).toMatch(/^Only http and https URLs/);
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe("databases over HTTP", () => {
    test("PostgREST / Supabase: GET <url>/<resource path>, credentials from the session", async () => {
        const doc = newDoc();
        const fetch = answering(JSON.stringify([{ name: "Bracket", length: 12 }]));
        rs.stubGlobal("fetch", fetch);
        const source = await sourceOf(doc, "Db", {
            kind: "sql",
            dialect: "postgrest",
            url: "https://project.supabase.co/rest/v1/",
            headers: [
                { name: "apikey", value: "anon-key", secret: true },
                { name: "Authorization", value: "Bearer anon-key", secret: true },
            ],
            queries: [{ name: "Parts", query: "/parts?select=name,length&order=name" }],
        });
        await source.refresh();
        const request = requestOf(fetch);
        expect(request.url).toBe("https://project.supabase.co/rest/v1/parts?select=name,length&order=name");
        expect(request.init.method).toBe("GET");
        expect(request.headers.get("apikey")).toBe("anon-key");
        expect(source.tables).toEqual([
            { name: "Parts", columns: ["name", "length"], rows: [["Bracket", 12]], hasHeader: true },
        ]);
    });

    test("Hasura run_sql: read-only SQL, its text values typed", async () => {
        const doc = newDoc();
        const fetch = answering(
            JSON.stringify({
                result_type: "TuplesOk",
                result: [
                    ["name", "length"],
                    ["Plate", "30.5"],
                    ["Rod", null],
                ],
            }),
        );
        rs.stubGlobal("fetch", fetch);
        const source = await sourceOf(doc, "Hasura", {
            kind: "sql",
            dialect: "hasura",
            url: "https://h.example.com/v2/query",
            queries: [{ name: "Parts", query: "SELECT name, length FROM parts" }],
        });
        await source.refresh();
        expect(JSON.parse(String(requestOf(fetch).init.body))).toEqual({
            type: "run_sql",
            args: { source: "default", sql: "SELECT name, length FROM parts", read_only: true },
        });
        expect(source.tables[0].rows).toEqual([
            ["Plate", 30.5],
            ["Rod", null],
        ]);
    });

    test("GraphQL: the first list under data; errors are the source's error", async () => {
        const doc = newDoc();
        rs.stubGlobal("fetch", answering(JSON.stringify({ data: { parts: [{ id: 1, w: 2 }] } })));
        const source = await sourceOf(doc, "Gql", {
            kind: "sql",
            dialect: "graphql",
            url: "https://g.example.com/graphql",
            queries: [{ name: "Parts", query: "{ parts { id w } }" }],
        });
        await source.refresh();
        expect(source.tables[0]).toEqual({
            name: "Parts",
            columns: ["id", "w"],
            rows: [[1, 2]],
            hasHeader: true,
        });
        rs.stubGlobal("fetch", answering(JSON.stringify({ errors: [{ message: "field 'x' not found" }] })));
        expect((await source.refresh()).error).toBe(`Query "Parts": field 'x' not found`);
    });

    test("a generic endpoint: POST { sql } answering { columns, rows }", async () => {
        const doc = newDoc();
        const fetch = answering(JSON.stringify({ columns: ["k", "v"], rows: [["w", 40]] }));
        rs.stubGlobal("fetch", fetch);
        const source = await sourceOf(doc, "Sql", {
            kind: "sql",
            dialect: "generic",
            url: "https://db.example.com/query",
            queries: [{ name: "Params", query: "SELECT k, v FROM params" }],
        });
        await source.refresh();
        expect(JSON.parse(String(requestOf(fetch).init.body))).toEqual({ sql: "SELECT k, v FROM params" });
        expect(evaluate(doc, 'lookup("Sql", "k", "w", "v")').value.value).toBe(40);
    });
});

describe("online sheets", () => {
    test.each([
        [
            "https://docs.google.com/spreadsheets/d/abc123/edit#gid=456",
            [],
            [
                {
                    name: "gid 456",
                    url: "https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=456",
                },
            ],
        ],
        [
            "https://docs.google.com/spreadsheets/d/abc123/edit",
            ["Parts", "gid=7"],
            [
                {
                    name: "Parts",
                    url: "https://docs.google.com/spreadsheets/d/abc123/gviz/tq?tqx=out:csv&sheet=Parts",
                },
                {
                    name: "gid 7",
                    url: "https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=7",
                },
            ],
        ],
        [
            "https://docs.google.com/spreadsheets/d/e/2PACX-pub/pubhtml",
            ["3"],
            [
                {
                    name: "gid 3",
                    url: "https://docs.google.com/spreadsheets/d/e/2PACX-pub/pub?output=csv&single=true&gid=3",
                },
            ],
        ],
    ])("Google Sheets %s → its CSV export links", (link, sheets, expected) => {
        expect(googleSheetExports(link, sheets).value).toEqual(expected);
    });

    test("Excel Online is downloaded; other links are refused", () => {
        expect(excelOnlineExport("https://onedrive.live.com/edit?id=1&resid=X").value).toEqual({
            url: "https://onedrive.live.com/edit?id=1&resid=X&download=1",
            csv: false,
        });
        expect(googleSheetExports("https://example.com/sheet").error).toMatch(/^Not a Google Sheets link/);
    });

    test("a sheet that is not shared answers a sign-in page, which is reported", async () => {
        const doc = newDoc();
        rs.stubGlobal("fetch", answering("<html>Sign in</html>", { type: "text/html; charset=utf-8" }));
        const source = await sourceOf(doc, "Sheet", {
            kind: "sheet",
            provider: "google",
            url: "https://docs.google.com/spreadsheets/d/abc/edit",
        });
        expect((await source.refresh()).error).toMatch(/share it with anyone with the link/);
        rs.stubGlobal("fetch", answering("Name,Value\nw,5", { type: "text/csv" }));
        await source.refresh();
        expect(evaluate(doc, 'data("Sheet", "B2")').value.value).toBe(5);
    });
});

// ------------------------------------------------------------------ Secrets

describe("secrets", () => {
    test("are never serialized unless the source opts in", async () => {
        const doc = newDoc();
        const source = await sourceOf(doc, "Api", {
            kind: "http",
            url: "https://api.example.com",
            headers: [{ name: "Authorization", value: "Bearer TOP-SECRET", secret: true }],
        });
        const json = JSON.stringify(Serializer.serializeObject(source));
        expect(json).not.toContain("TOP-SECRET");
        expect(source.definitionJson).not.toContain("TOP-SECRET");
        expect(source.secretsJson).toBe("");
        expect(source.secrets()).toEqual({ Authorization: "Bearer TOP-SECRET" });

        // A copy loaded in a fresh session has the header but not its value.
        const copy = Serializer.deserializeObject(newDoc(), JSON.parse(json)) as DataSourceNode;
        clearSessionSecrets(copy.id);
        rs.stubGlobal("fetch", answering("[]"));
        expect((await copy.refresh()).error).toMatch(/^Enter the value of "Authorization"/);
    });

    test("an opted-in source carries them in the document", async () => {
        const doc = newDoc();
        const source = await sourceOf(doc, "Api", {
            kind: "http",
            url: "https://api.example.com",
            headers: [{ name: "Authorization", value: "Bearer KEPT", secret: true }],
            storeSecrets: true,
        });
        const serialized = Serializer.serializeObject(source);
        expect(serialized["secretsJson"]).toBe('{"Authorization":"Bearer KEPT"}');
        clearSessionSecrets(source.id);
        const copy = Serializer.deserializeObject(newDoc(), serialized) as DataSourceNode;
        expect(copy.secrets()).toEqual({ Authorization: "Bearer KEPT" });
    });

    test("setSecret keeps a value for the session only", async () => {
        const doc = newDoc();
        const source = await sourceOf(doc, "Api", {
            kind: "http",
            url: "https://api.example.com",
            headers: [{ name: "X-Key", secret: true }],
        });
        source.setSecret("X-Key", "abc");
        const fetch = answering("[]");
        rs.stubGlobal("fetch", fetch);
        await source.refresh();
        expect(requestOf(fetch).headers.get("x-key")).toBe("abc");
        expect(JSON.stringify(Serializer.serializeObject(source))).not.toContain("abc");
    });
});

// ------------------------------------------------------------------ Variables

describe("Variable Studios read data", () => {
    test("a studio row bound to a cell follows the source, undo included", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        const studio = new VariableStudioNode({
            document: doc,
            items: [
                { id: "d", name: "depth", type: "length", expression: 'data("Dims", "B2") * 2' },
                {
                    id: "a",
                    name: "tilt",
                    type: "angle",
                    expression: 'lookup("Dims", "Name", "Angle", "Value")',
                },
            ],
        });
        Transaction.execute(doc, "studio", () => doc.modelManager.addNode(studio));
        Transaction.execute(doc, "table", () =>
            doc.variables.setItems([{ id: "h", name: "h", type: "length", expression: "depth + 1" }]),
        );
        const values = () => doc.variables.evaluate().values;
        expect(values().get("d")?.value).toBe(20);
        expect(values().get("a")?.value).toBe(30);
        expect(values().get("h")?.value).toBe(21);

        await source.apply({ fileText: "Name,Value\nDepth,4\nAngle,45 deg" });
        expect(values().get("d")?.value).toBe(8);
        expect(values().get("a")?.value).toBe(45);
        expect(values().get("h")?.value).toBe(9);
        doc.history.undo();
        expect(values().get("h")?.value).toBe(21);
    });

    test("Import variables: rows linked by name, types from units, bad names skipped, re-import in place", async () => {
        const doc = newDoc();
        const source = await csvSource(
            doc,
            "Params",
            "Parameter,Value,Description\nwidth,40,Overall width\nangle,15 deg,\nbad name,1,\nheight,2 in,",
        );
        const imported = importVariablesFromTable(doc, source.tables[0], "Params");
        expect(imported.isOk).toBe(true);
        const { studio, added, skipped } = imported.value;
        expect(added).toBe(3);
        expect(skipped).toEqual(["bad name (not a variable name)"]);
        expect(studio.name).toBe("Params variables 1");
        expect(
            studio.items.map(({ name, type, expression, description }) => ({
                name,
                type,
                expression,
                description,
            })),
        ).toEqual([
            {
                name: "width",
                type: "length",
                expression: 'lookup("Params", "Parameter", "width", "Value")',
                description: "Overall width",
            },
            {
                name: "angle",
                type: "angle",
                expression: 'lookup("Params", "Parameter", "angle", "Value")',
                description: undefined,
            },
            {
                name: "height",
                type: "length",
                expression: 'lookup("Params", "Parameter", "height", "Value")',
                description: undefined,
            },
        ]);
        const scope = () => doc.variables.evaluate().scope;
        expect(scope().get("height")?.value).toBeCloseTo(50.8, 9);

        // Reordered and re-valued at the source: the linked rows follow.
        await source.apply({ fileText: "Parameter,Value\nheight,10\nwidth,41\ndepth,5" });
        expect(scope().get("width")?.value).toBe(41);
        expect(scope().get("height")?.value).toBe(10);

        const ids = studio.items.map((item) => item.id);
        const again = importVariablesFromTable(doc, source.tables[0], "Params", studio);
        expect(again.value).toMatchObject({ added: 1, updated: 2 });
        expect(studio.items.slice(0, 3).map((item) => item.id)).toEqual(ids);
        expect(studio.items.map((item) => item.name)).toEqual(["width", "angle", "height", "depth"]);
    });
});

// ------------------------------------------------------------------ Dependencies

describe("the dependency report", () => {
    test("names every expression that reads a source, and where it is", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        await csvSource(doc, "Other", "a\n1");
        const studio = new VariableStudioNode({
            document: doc,
            name: "Sizes",
            items: [{ id: "d", name: "depth", type: "length", expression: 'data("Dims", "B2")' }],
        });
        doc.modelManager.addNode(studio);
        doc.variables.setItems([
            {
                id: "w",
                name: "w",
                type: "length",
                expression: 'lookup("Dims", "Name", "Depth", "Value") + data("Other", "A2")',
            },
        ]);
        const all = collectDataDependencies(doc).map((x) => [x.nodeName, x.location, x.reference.label]);
        expect(all).toEqual([
            ["Parameters", "w", "Dims!Value[Name=Depth]"],
            ["Parameters", "w", "Other!A2"],
            ["Sizes", "depth", "Dims!B2"],
        ]);
        expect(dependenciesOn(doc, source).map((x) => x.reference.label)).toEqual([
            "Dims!Value[Name=Depth]",
            "Dims!B2",
        ]);
    });
});

// ------------------------------------------------------------------ Persistence

describe("persistence", () => {
    test("a .chili3d project keeps snapshots and attachments as files under data/, secrets out", async () => {
        const doc = newDoc();
        await csvSource(doc, "Dims", DIMS);
        const shop = await sourceOf(doc, "Shop", { kind: "sqlite" });
        const database = await sqliteFile("CREATE TABLE t (w REAL); INSERT INTO t VALUES (7.5);");
        await shop.attachFile("shop.db", database);
        await sourceOf(doc, "Api", {
            kind: "http",
            url: "https://api.example.com",
            headers: [{ name: "Authorization", value: "Bearer NOPE", secret: true }],
        });

        const document: Serialized = {
            [InternalClassName]: "Document",
            id: "doc",
            name: "Job",
            version: "0.7.1",
            models: doc.modelManager.serialize(),
        };
        const packed = packProject({
            document,
            app: { name: "Chili3D", version: "test" },
            createdAt: "2026-01-01T00:00:00.000Z",
            modifiedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(packed.isOk).toBe(true);
        const files = packed.value;
        expect([...files.keys()].filter((path) => path.startsWith("data/")).sort()).toEqual([
            "data/Api.snapshot.json",
            "data/Dims.csv",
            "data/Dims.snapshot.json",
            "data/Shop.db",
            "data/Shop.snapshot.json",
        ]);
        expect(new TextDecoder().decode(files.get("data/Dims.csv"))).toBe(DIMS);
        expect(files.get("data/Shop.db")).toEqual(database);
        const documentJson = new TextDecoder().decode(files.get("document.json"));
        expect(documentJson).toContain('"$file": "data/Shop.db"');
        expect(documentJson).toContain('"$encoding": "base64"');
        for (const bytes of files.values())
            expect(new TextDecoder().decode(bytes)).not.toContain("Bearer NOPE");
        // One row per line: a changed cell is a one-line diff.
        expect(new TextDecoder().decode(files.get("data/Dims.snapshot.json"))).toContain('\n["Depth",10],\n');

        const unpacked = unpackProject(files);
        expect(unpacked.isOk).toBe(true);
        expect(unpacked.value.document["models"]).toEqual(JSON.parse(JSON.stringify(document["models"])));

        // Opened elsewhere, offline: the cached tables answer without a refresh.
        const reopened = newDoc();
        await reopened.modelManager.deserialize(unpacked.value.document["models"]);
        expect(dataSourcesOf(reopened).map((x) => x.name)).toEqual(["Dims", "Shop", "Api"]);
        expect(evaluate(reopened, 'data("Dims", "B2")').value.value).toBe(10);
        expect(evaluate(reopened, 'data("Shop", "A2")').value.value).toBe(7.5);
    });

    test("the version history splits a source into a merged definition and row-per-line texts", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        const definition = findPropertySplitter("DataSourceNode", "definitionJson");
        const snapshot = findPropertySplitter("DataSourceNode", "snapshotJson");
        expect(definition).toBeDefined();
        expect(snapshot).toBeDefined();
        const part = definition?.split(source.definitionJson);
        expect(part).toMatchObject({
            kind: "json",
            role: "dataSourceDefinition",
            value: { kind: "file", fileName: "dims.csv" },
        });
        expect(definition?.join(part as never)).toBe(source.definitionJson);
        const text = snapshot?.split(source.snapshotJson);
        expect(text).toMatchObject({ kind: "text" });
        expect(snapshot?.join(text as never)).toBe(source.snapshotJson);
        expect(parseSnapshot(source.snapshotJson, "test").tables).toEqual(source.tables);
    });
});
