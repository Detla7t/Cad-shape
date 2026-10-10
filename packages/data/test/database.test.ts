// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentElements, FILE_FORMATS, sniffFileContent } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { DatabaseNode, isDatabaseNode } from "../src/database/databaseNode";
import {
    cellValue,
    createTable,
    deleteRow,
    insertRow,
    listTables,
    openDatabase,
    readRows,
    runSql,
    tableColumns,
    updateCell,
} from "../src/database/sqlite";
import "../src/database/databaseElement";
import { sqliteFile, useNodeSqlJs } from "./_helpers";

beforeAll(() => useNodeSqlJs());

describe("the database manager's SQLite operations", () => {
    test("tables, columns, paged rows with rowids, cell edits, rows added and deleted, export", async () => {
        const file = await sqliteFile(
            "CREATE TABLE parts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, od REAL); INSERT INTO parts (name, od) VALUES ('cap', 9.625), ('reducer', 6.625);",
        );
        const db = await openDatabase(file);
        try {
            expect(listTables(db)).toEqual(["parts"]);
            expect(tableColumns(db, "parts")).toEqual([
                { name: "id", type: "INTEGER", primaryKey: true, notNull: false },
                { name: "name", type: "TEXT", primaryKey: false, notNull: true },
                { name: "od", type: "REAL", primaryKey: false, notNull: false },
            ]);
            // A NOT NULL text column without a default gets an empty text on insert.
            const page = readRows(db, "parts", 1, 1);
            expect(page.total).toBe(2);
            expect(page.columns).toEqual(["id", "name", "od"]);
            expect(page.rows).toEqual([{ rowid: 2, cells: [2, "reducer", 6.625] }]);
            updateCell(db, "parts", 2, "od", cellValue("7"));
            expect(readRows(db, "parts").rows[1].cells[2]).toBe(7);
            const added = insertRow(db, "parts");
            expect(added).toBe(3);
            expect(readRows(db, "parts").rows[2].cells).toEqual([3, "", null]);
            updateCell(db, "parts", added, "name", cellValue("wall"));
            updateCell(db, "parts", added, "od", cellValue(""));
            expect(readRows(db, "parts").rows[2].cells).toEqual([3, "wall", null]);
            deleteRow(db, "parts", 1);
            expect(readRows(db, "parts").total).toBe(2);
            createTable(db, "sizes", "size TEXT, inches REAL");
            expect(listTables(db)).toEqual(["parts", "sizes"]);
            const changed = runSql(db, "INSERT INTO sizes VALUES ('4\"', 4), ('4 1/2\"', 4.5)");
            expect(changed.columns).toEqual([]);
            expect(changed.changes).toBe(2);
            const query = runSql(db, "SELECT size FROM sizes WHERE inches > 4");
            expect(query.rows).toEqual([['4 1/2"']]);
            // The exported file reopens with every change in it.
            const again = await openDatabase(db.export());
            try {
                expect(readRows(again, "sizes").total).toBe(2);
            } finally {
                again.close();
            }
        } finally {
            db.close();
        }
    });

    test("cell text becomes NULL, a number or text", () => {
        expect(cellValue("")).toBeNull();
        expect(cellValue(" null ")).toBeNull();
        expect(cellValue("12.5")).toBe(12.5);
        expect(cellValue("1e3")).toBe(1000);
        expect(cellValue("007")).toBe(7);
        expect(cellValue('4 1/2"')).toBe('4 1/2"');
    });
});

describe("database elements", () => {
    test("a database node keeps its file, is a document element, and SQLite files are recognized", async () => {
        const doc = new TestDocument();
        const bytes = await sqliteFile("CREATE TABLE t (x)");
        const node = new DatabaseNode({ document: doc, name: "Database 1", bytes });
        expect(isDatabaseNode(node)).toBe(true);
        expect(node.bytes).toEqual(bytes);
        expect(node.fileName).toBe("Database 1.sqlite");
        expect(DocumentElements.kindOf(node)?.kind).toBe("database");
        expect(DocumentElements.kindOf(node)?.newCommand).toBe("data.newDatabase");
        expect(sniffFileContent(bytes)?.id).toBe("sqlite");
        expect(FILE_FORMATS.find((format) => format.id === "sqlite")?.extensions).toContain(".db");
    });
});
