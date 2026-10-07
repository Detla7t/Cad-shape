// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { type DataSourceDefinition, DataSourceNode } from "../src";
import { configureSqlJs, loadSqlJs } from "../src/readers/sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** sql.js under Node: its engine bytes from node_modules (the browser fetches the bundled asset). */
export function useNodeSqlJs(): void {
    configureSqlJs({
        wasmBinary: readFileSync(path.resolve(HERE, "../../../node_modules/sql.js/dist/sql-wasm.wasm")),
    });
}

/** A SQLite database file made with sql.js itself. */
export async function sqliteFile(sql: string): Promise<Uint8Array> {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    try {
        db.run(sql);
        return db.export();
    } finally {
        db.close();
    }
}

export function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    return doc;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** A CSV Data Source named `name`, attached and read, in `doc`. */
export async function csvSource(doc: TestDocument, name: string, csv: string): Promise<DataSourceNode> {
    const source = new DataSourceNode({ document: doc, name });
    doc.modelManager.addNode(source);
    const read = await source.attachFile(`${name.toLowerCase()}.csv`, utf8(csv));
    if (!read.isOk) throw new Error(read.error);
    return source;
}

export async function sourceOf(
    doc: TestDocument,
    name: string,
    definition: DataSourceDefinition,
): Promise<DataSourceNode> {
    const source = new DataSourceNode({ document: doc, name, definition });
    doc.modelManager.addNode(source);
    return source;
}

export { utf8 };
