// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export interface IStorage {
    createDBIfNeeded(database: string, tables: string[]): Promise<void>;
    get(database: string, table: string, id: string): Promise<any>;
    put(database: string, table: string, id: string, value: any): Promise<boolean>;
    delete(database: string, table: string, id: string): Promise<boolean>;
    page(database: string, table: string, page: number): Promise<any[]>;
    /** All operations commit together, or none do. Resolves only after transaction completion. */
    writeBatch?(database: string, operations: readonly StorageOperation[]): Promise<boolean>;
}

export type StorageOperation =
    | { readonly type: "put"; readonly table: string; readonly id: string; readonly value: unknown }
    | { readonly type: "delete"; readonly table: string; readonly id: string };

/** Uses atomic writes when supported. Legacy adapters retain their sequential contract. */
export async function writeStorageBatch(
    storage: IStorage,
    database: string,
    operations: readonly StorageOperation[],
): Promise<void> {
    if (operations.length === 0) return;
    if (storage.writeBatch !== undefined) {
        if (!(await storage.writeBatch(database, operations))) throw new Error("Storage transaction failed");
        return;
    }
    for (const operation of operations) {
        const saved =
            operation.type === "put"
                ? await storage.put(database, operation.table, operation.id, operation.value)
                : await storage.delete(database, operation.table, operation.id);
        if (!saved) throw new Error(`Storage write failed: ${operation.table}/${operation.id}`);
    }
}
