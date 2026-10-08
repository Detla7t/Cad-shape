// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { ArrayRecord, type IHistoryRecord } from "./history";
import { OperationLog } from "./operationLog";

export class Transaction {
    private static readonly _transactionMap: WeakMap<IDocument, ArrayRecord> = new WeakMap();

    private operation?: ReturnType<typeof OperationLog.begin>;

    constructor(
        readonly document: IDocument,
        readonly name: string,
    ) {}

    /** True while a transaction is open on `document` — its edits are not complete yet. */
    static isActive(document: IDocument): boolean {
        return Transaction._transactionMap.has(document);
    }

    static add(document: IDocument, record: IHistoryRecord) {
        if (document.history.disabled) return;
        const arrayRecord = Transaction._transactionMap.get(document);
        if (arrayRecord !== undefined) {
            arrayRecord.records.push(record);
        } else {
            Transaction.addToHistory(document, record);
        }
    }

    static addToHistory(document: IDocument, record: IHistoryRecord) {
        document.history.add(record);
    }

    /**
     * Opens a transaction, runs `action` and commits it — or, when the document already has
     * one open, joins that one: the records merge, so undoing reverts both halves together.
     *
     * The join is what makes a listener that edits a second time work. Editing the parameter
     * table re-solves the live sketch, which commits its own data — one user action, one undo
     * step. Opening a second transaction used to throw inside the notification, where the
     * observer swallowed it: the inner edit was lost with no error anywhere.
     */
    static execute(document: IDocument, name: string, action: () => void) {
        if (Transaction._transactionMap.has(document)) {
            action();
            return;
        }
        const trans = new Transaction(document, name);
        trans.start();
        try {
            action();
            trans.commit();
        } catch (e) {
            trans.rollback();
            throw e;
        }
    }

    static async executeAsync(document: IDocument, name: string, action: () => Promise<void>) {
        if (Transaction._transactionMap.has(document)) {
            await action();
            return;
        }
        const trans = new Transaction(document, name);
        trans.start();

        await Promise.try(async () => {
            await action();
            trans.commit();
        }).catch((e) => {
            trans.rollback();
            throw e;
        });
    }

    start(name?: string) {
        const transactionName = name ?? this.name;
        if (Transaction._transactionMap.has(this.document)) {
            throw new Error(`The document has started a transaction ${this.name}`);
        }
        Transaction._transactionMap.set(this.document, new ArrayRecord(transactionName));
        this.operation = OperationLog.begin("model.transaction", {
            documentId: this.document.id,
            action: transactionName,
        });
    }

    commit() {
        const arrayRecord = Transaction._transactionMap.get(this.document);
        if (!arrayRecord) {
            throw new Error("Transaction has not started");
        }
        if (arrayRecord.records.length > 0) Transaction.addToHistory(this.document, arrayRecord);
        Transaction._transactionMap.delete(this.document);
        this.operation?.add({
            recordCount: arrayRecord.records.length,
            undoCount: this.document.history.undoCount(),
        });
        this.operation?.finish("success");
    }

    rollback() {
        const transaction = Transaction._transactionMap.get(this.document);
        Transaction._transactionMap.delete(this.document);

        transaction?.undo();
        this.operation?.add({ recordCount: transaction?.records.length ?? 0 });
        this.operation?.finish("rolled_back");
    }
}
