// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type IApplication,
    type ICommand,
    type IDocument,
    type INode,
    nextElementName,
    openElement,
    Result,
    registerElementKind,
    registerElementView,
    registerFileImporter,
    Transaction,
} from "@chili3d/core";
import { DatabaseNode, isDatabaseNode } from "./databaseNode";
import { DatabaseView } from "./databaseView";
import { openDatabase } from "./sqlite";

/** Databases as document elements: a bottom tab per SQLite file, showing the manager. */
export const DATABASE_ELEMENT_KIND = "database";

registerElementKind({
    kind: DATABASE_ELEMENT_KIND,
    icon: "icon-layer-group",
    display: "data.database",
    isElement: isDatabaseNode,
    newCommand: "data.newDatabase",
});

registerElementView(
    DATABASE_ELEMENT_KIND,
    (node: INode, document: IDocument) => new DatabaseView(node as DatabaseNode, document),
);

/** Adds an empty SQLite database to the active document (one undo step) and opens its tab. */
@command({ key: "data.newDatabase", icon: "icon-layer-group" })
export class NewDatabaseCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document ?? (await application.newDocument("Untitled"));
        const db = await openDatabase(undefined);
        let bytes: Uint8Array;
        try {
            bytes = db.export();
        } finally {
            db.close();
        }
        const name = nextElementName(document, "Database");
        const node = new DatabaseNode({ document, name, fileName: `${name}.sqlite`, bytes });
        Transaction.execute(document, "new database", () => document.modelManager.addNode(node));
        openElement(document, node);
    }
}

const SQLITE_EXTENSIONS = [".sqlite", ".sqlite3", ".db", ".db3"];
const SQLITE_MAGIC = "SQLite format 3\u0000";

function isSqlite(bytes: Uint8Array): boolean {
    if (bytes.length < SQLITE_MAGIC.length) return false;
    for (let i = 0; i < SQLITE_MAGIC.length; i++) if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
    return true;
}

/** Imported SQLite files become database elements. */
registerFileImporter({
    id: "data.database",
    extensions: SQLITE_EXTENSIONS,
    accepts: (file) =>
        file.format.id === "sqlite" ||
        SQLITE_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension)) ||
        isSqlite(file.bytes),
    import: async (document, file) => {
        if (!isSqlite(file.bytes)) return Result.err(`${file.name} is not a SQLite database`);
        const base = file.name.replace(/\.[^.]+$/, "");
        const node = new DatabaseNode({
            document,
            name: nextElementName(document, base),
            fileName: file.name,
            bytes: file.bytes,
        });
        Transaction.execute(document, "import database", () => document.modelManager.addNode(node));
        openElement(document, node);
        return Result.ok<INode[]>([node]);
    },
});
