// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode, INodeLinkedList } from "../model";
import type { IDisposable } from "./disposable";

export interface IHistoryRecord extends IDisposable {
    readonly name: string;
    undo(): void;
    redo(): void;
}

/** What happened to the history: a record was added (a completed edit), undone or redone. */
export type HistoryAction = "add" | "undo" | "redo";
export type HistoryListener = (action: HistoryAction, record: IHistoryRecord) => void;

export class History implements IDisposable {
    private readonly _undos: IHistoryRecord[] = [];
    private readonly _redos: IHistoryRecord[] = [];
    private readonly _listeners = new Set<HistoryListener>();

    disabled = false;
    undoLimits = 50;

    #isUndoing = false;
    get isUndoing() {
        return this.#isUndoing;
    }
    #isRedoing = false;
    get isRedoing() {
        return this.#isRedoing;
    }

    dispose(): void {
        this.reset();
        this._listeners.clear();
    }

    /**
     * Drops every undo and redo step (disposing their records) — for when the document is
     * replaced underneath them (e.g. switching to another branch), where they no longer apply.
     */
    reset(): void {
        // Only the undo steps are disposed. Redo steps are dropped as `add()` drops them: a
        // node a redo step would remove again is live in the tree after its undo, and
        // disposing the step would dispose that live node.
        this._undos.forEach((record) => record.dispose());
        this.clear();
    }

    /**
     * Observes every completed, undoable change: a record added (a committed transaction or a
     * lone recorded edit), undone or redone. The version history captures microversions here.
     */
    onChanged(listener: HistoryListener): void {
        this._listeners.add(listener);
    }

    removeChanged(listener: HistoryListener): void {
        this._listeners.delete(listener);
    }

    private emit(action: HistoryAction, record: IHistoryRecord): void {
        for (const listener of [...this._listeners]) {
            try {
                listener(action, record);
            } catch (error) {
                console.error(`history: a ${action} listener threw`, error);
            }
        }
    }

    private clear(): void {
        this._undos.length = 0;
        this._redos.length = 0;
    }

    add(record: IHistoryRecord) {
        if (this.disabled) return;

        this._redos.length = 0;
        this._undos.push(record);

        if (this._undos.length > this.undoLimits) {
            const removed = this._undos.shift();
            removed?.dispose();
        }
        this.emit("add", record);
    }

    undoCount() {
        return this._undos.length;
    }

    redoCount() {
        return this._redos.length;
    }

    /** The names of the undo steps, oldest first (the last one is what Undo reverts). */
    undoNames(): string[] {
        return this._undos.map((record) => record.name);
    }

    /** The names of the redo steps, the next one to redo last. */
    redoNames(): string[] {
        return this._redos.map((record) => record.name);
    }

    undo() {
        this.#isUndoing = true;
        let undone: IHistoryRecord | undefined;
        this.tryOperate(
            () => {
                const record = this._undos.pop();
                if (!record) return;

                record.undo();
                this._redos.push(record);
                undone = record;
            },
            () => {
                this.#isUndoing = false;
            },
        );
        if (undone) this.emit("undo", undone);
    }

    redo() {
        this.#isRedoing = true;
        let redone: IHistoryRecord | undefined;
        this.tryOperate(
            () => {
                const record = this._redos.pop();
                if (!record) return;

                record.redo();
                this._undos.push(record);
                redone = record;
            },
            () => {
                this.#isRedoing = false;
            },
        );
        if (redone) this.emit("redo", redone);
    }

    private tryOperate(action: () => void, onFinally: () => void) {
        const previousState = this.disabled;
        this.disabled = true;
        try {
            action();
        } finally {
            this.disabled = previousState;
            onFinally();
        }
    }
}

export class PropertyHistoryRecord implements IHistoryRecord {
    readonly name: string;
    constructor(
        readonly object: any,
        readonly property: string | symbol | number,
        readonly oldValue: any,
        readonly newValue: any,
    ) {
        this.name = `change ${String(property)} property`;
    }

    dispose(): void {}

    undo(): void {
        this.object[this.property] = this.oldValue;
    }

    redo(): void {
        this.object[this.property] = this.newValue;
    }
}

export type NodeAction = "add" | "remove" | "move" | "transfer" | "insertAfter" | "insertBefore";

export interface NodeRecord {
    node: INode;
    action: NodeAction;
    oldParent?: INodeLinkedList;
    oldPrevious?: INode;
    newParent?: INodeLinkedList;
    newPrevious?: INode;
}

export class NodeLinkedListHistoryRecord implements IHistoryRecord {
    readonly name: string;

    constructor(readonly records: NodeRecord[]) {
        this.name = "change node";
    }

    dispose(): void {
        this.records.forEach((record) => {
            // A removed node is owned by its record — unless an undo put it back in a tree.
            if (record.action === "remove" && record.node.parent === undefined) {
                record.node.dispose();
            }
        });
        this.records.length = 0;
    }

    // A recorded anchor can go stale over time (e.g. the node was removed outside of the
    // history); fall back to undefined so the node at least returns to the target parent
    // instead of the move being silently skipped.
    private static normalizePrevious(
        previous: INode | undefined,
        parent: INodeLinkedList | undefined,
    ): INode | undefined {
        return previous?.parent === parent ? previous : undefined;
    }

    private handleUndo(record: NodeRecord): void {
        switch (record.action) {
            case "add":
                record.newParent?.remove(record.node);
                break;
            case "remove":
            case "transfer": {
                // Back where it was: after the sibling it followed, or first when it led the
                // list (order matters — it decides which Variable Studio wins a name). A stale
                // anchor (that sibling moved away since) appends instead.
                const previous = NodeLinkedListHistoryRecord.normalizePrevious(
                    record.oldPrevious,
                    record.oldParent,
                );
                if (record.oldPrevious !== undefined && previous === undefined)
                    record.oldParent?.add(record.node);
                else record.oldParent?.insertAfter(previous, record.node);
                break;
            }
            case "move":
                record.newParent?.move(
                    record.node,
                    record.oldParent!,
                    NodeLinkedListHistoryRecord.normalizePrevious(record.oldPrevious, record.oldParent),
                );
                break;
            case "insertAfter":
                record.newParent?.remove(record.node);
                break;
            case "insertBefore":
                record.newParent?.remove(record.node);
                break;
        }
    }

    private handleRedo(record: NodeRecord): void {
        switch (record.action) {
            case "add":
                record.newParent?.add(record.node);
                break;
            case "remove":
                record.oldParent?.remove(record.node);
                break;
            case "transfer":
                record.oldParent?.transfer(record.node);
                break;
            case "move":
                record.oldParent?.move(
                    record.node,
                    record.newParent!,
                    NodeLinkedListHistoryRecord.normalizePrevious(record.newPrevious, record.newParent),
                );
                break;
            case "insertAfter":
                record.newParent?.insertAfter(record.newPrevious, record.node);
                break;
            case "insertBefore":
                record.newParent?.insertBefore(record.newPrevious?.nextSibling, record.node);
                break;
        }
    }

    undo(): void {
        for (let i = this.records.length - 1; i >= 0; i--) {
            this.handleUndo(this.records[i]);
        }
    }

    redo(): void {
        this.records.forEach((record) => this.handleRedo(record));
    }
}

export class ArrayRecord implements IHistoryRecord {
    readonly records: Array<IHistoryRecord> = [];

    constructor(readonly name: string) {}

    dispose(): void {
        this.records.forEach((r) => r.dispose());
    }

    undo() {
        for (let index = this.records.length - 1; index >= 0; index--) {
            this.records[index].undo();
        }
    }

    redo() {
        for (const record of this.records) {
            record.redo();
        }
    }
}
