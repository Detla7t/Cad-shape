// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IStorage, Logger, type StorageOperation } from "@chili3d/core";

export class IndexedDBStorage implements IStorage {
    async createDBIfNeeded(database: string, tables: string[]): Promise<void> {
        let db = await this.open(database, tables);
        try {
            if (tables.some((table) => !db.objectStoreNames.contains(table))) {
                const version = db.version + 1;
                db.close();
                db = await this.open(database, tables, version);
            }
        } finally {
            db.close();
        }
    }

    async get(database: string, table: string, id: string): Promise<any> {
        const db = await this.open(database);
        try {
            const transaction = db.transaction(table, "readonly");
            const completed = transactionCompletion(transaction);
            let request: IDBRequest;
            try {
                request = transaction.objectStore(table).get(id);
            } catch (error) {
                transaction.abort();
                await completed.catch(() => {});
                throw error;
            }
            await completed;
            return request.result;
        } finally {
            db.close();
        }
    }

    put(database: string, table: string, id: string, value: unknown): Promise<boolean> {
        return this.writeBatch(database, [{ type: "put", table, id, value }]);
    }

    delete(database: string, table: string, id: string): Promise<boolean> {
        return this.writeBatch(database, [{ type: "delete", table, id }]);
    }

    async writeBatch(database: string, operations: readonly StorageOperation[]): Promise<boolean> {
        if (operations.length === 0) return true;
        const db = await this.open(database);
        try {
            const transaction = db.transaction([...new Set(operations.map((op) => op.table))], "readwrite");
            const completed = transactionCompletion(transaction);
            try {
                // Queue every request synchronously: an IndexedDB transaction may close
                // as soon as control yields with no outstanding request.
                for (const operation of operations) {
                    const store = transaction.objectStore(operation.table);
                    if (operation.type === "put") store.put(operation.value, operation.id);
                    else store.delete(operation.id);
                }
            } catch (error) {
                // Clone or key errors can throw before a request exists. Abort the
                // earlier queued writes too, and observe the abort rejection.
                transaction.abort();
                await completed.catch(() => {});
                throw error;
            }
            await completed;
            return true;
        } finally {
            db.close();
        }
    }

    async page(database: string, table: string, page: number): Promise<any[]> {
        const count = 20;
        if (!Number.isSafeInteger(page) || page < 0 || page * count > 0xffffffff)
            throw new Error("Page must be a non-negative integer within the cursor range");
        const db = await this.open(database);
        try {
            const transaction = db.transaction(table, "readonly");
            const completed = transactionCompletion(transaction);
            const request = transaction.objectStore(table).openCursor();
            const result: unknown[] = [];
            let advanced = false;
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor === null || result.length === count) return;
                if (!advanced && page > 0) {
                    advanced = true;
                    cursor.advance(page * count);
                } else {
                    result.push(cursor.value);
                    cursor.continue();
                }
            };
            await completed;
            return result;
        } finally {
            db.close();
        }
    }

    private open(database: string, tables: readonly string[] = [], version?: number): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = window.indexedDB.open(database, version);
            let blocked = false;
            request.onsuccess = () => {
                const db = request.result;
                if (blocked) {
                    // A rejected blocked request may still finish after another tab closes.
                    // Do not leak the connection or resume an abandoned save.
                    db.close();
                    return;
                }
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error ?? new Error(`Could not open ${database}`));
            request.onblocked = () => {
                blocked = true;
                reject(new Error(`Storage upgrade for ${database} is blocked by another open tab`));
            };
            request.onupgradeneeded = () => {
                const db = request.result;
                for (const table of tables) {
                    if (!db.objectStoreNames.contains(table)) db.createObjectStore(table);
                }
            };
        });
    }
}

/** Request success precedes commit; only complete means a write actually succeeded. */
function transactionCompletion(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => {
            const error = transaction.error ?? new DOMException("Storage transaction aborted", "AbortError");
            Logger.error("Storage transaction aborted", error);
            reject(error);
        };
        // Request errors bubble before their default action aborts the transaction.
        // Wait for abort before releasing the connection.
        transaction.onerror = () => {};
    });
}
