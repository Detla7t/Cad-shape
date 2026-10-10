// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type INode,
    type IVariableFeatureNode,
    type IVariableSource,
    isVariableFeatureNode,
    Observable,
    type VariableData,
} from "@chili3d/core";

/** A source whose rows may belong to modeling features (Onshape's Variable features). */
export interface IFeatureVariableRows {
    /** The feature a row belongs to; undefined for a row of the document's own table. */
    featureRow(id: string): IVariableFeatureNode | undefined;
}

export function hasFeatureRows(source: IVariableSource): source is IVariableSource & IFeatureVariableRows {
    return typeof (source as Partial<IFeatureVariableRows>).featureRow === "function";
}

/**
 * The Part Studio's variables as one list — Onshape's "Part Studio 1" group of the variable
 * table: every variable feature of the model tree (assigned and measured, in tree order)
 * followed by the document's own parameter table. One `IVariableSource`, so the variables
 * editor shows and edits them as one table:
 *
 * - a feature row's name, description and (assigned) expression write into the feature
 *   through `updateVariable`; deleting the row removes the feature; rows cannot be moved
 *   (their order is the tree's);
 * - everything else is the table's, written through `document.variables` — the new row at
 *   the bottom adds a table variable.
 *
 * Notifies `"variablesJson"` whenever either side changes, as an editor expects of a source.
 */
export class PartStudioVariables extends Observable implements IVariableSource, IFeatureVariableRows {
    private readonly watched = new Set<IVariableFeatureNode>();
    private disposed = false;

    constructor(readonly document: IDocument) {
        super();
        document.variables.onPropertyChanged(this.tableChanged);
        document.modelManager.addNodeObserver(this.nodesChanged);
        this.watchFeatures();
    }

    private features(): IVariableFeatureNode[] {
        return this.document.modelManager.findNodes(isVariableFeatureNode).filter(isVariableFeatureNode);
    }

    get items(): readonly VariableData[] {
        return [...this.features().flatMap((node) => node.items), ...this.document.variables.items];
    }

    get variablesJson(): string {
        return JSON.stringify(this.items);
    }

    featureRow(id: string): IVariableFeatureNode | undefined {
        return this.owners().get(id);
    }

    private owners(): Map<string, IVariableFeatureNode> {
        const owners = new Map<string, IVariableFeatureNode>();
        for (const node of this.features()) for (const item of node.items) owners.set(item.id, node);
        return owners;
    }

    /**
     * One write: feature rows that went are removed from the tree, changed ones update their
     * feature, and the rest is the table's new list. The caller's transaction makes it one
     * undo step.
     */
    setItems(items: readonly VariableData[]): void {
        const owners = this.owners();
        const kept = new Set(items.map((item) => item.id));
        const removed = new Set<INode>();
        for (const [id, node] of owners) if (!kept.has(id)) removed.add(node);
        for (const node of removed) node.parent?.remove(node);
        const table: VariableData[] = [];
        for (const item of items) {
            const owner = owners.get(item.id);
            if (owner === undefined) {
                table.push(item);
                continue;
            }
            if (removed.has(owner)) continue;
            const current = owner.items.find((row) => row.id === item.id);
            if (
                current !== undefined &&
                (current.name !== item.name ||
                    current.expression !== item.expression ||
                    (current.description ?? "") !== (item.description ?? ""))
            )
                owner.updateVariable?.(item);
        }
        if (JSON.stringify(table) !== JSON.stringify(this.document.variables.items))
            this.document.variables.setItems(table);
        this.emitPropertyChanged("variablesJson", "");
    }

    protected override disposeInternal(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.document.variables.removePropertyChanged(this.tableChanged);
        this.document.modelManager.removeNodeObserver(this.nodesChanged);
        for (const node of this.watched) node.removePropertyChanged(this.featureChanged);
        this.watched.clear();
        super.disposeInternal();
    }

    private watchFeatures(): void {
        const next = new Set(this.features());
        for (const node of this.watched) {
            if (!next.has(node)) {
                node.removePropertyChanged(this.featureChanged);
                this.watched.delete(node);
            }
        }
        for (const node of next) {
            if (!this.watched.has(node)) {
                node.onPropertyChanged(this.featureChanged);
                this.watched.add(node);
            }
        }
    }

    private readonly tableChanged = (property: string) => {
        if (property === "variablesJson") this.emitPropertyChanged("variablesJson", "");
    };

    private readonly nodesChanged = () => {
        if (this.disposed) return;
        const before = this.watched.size;
        this.watchFeatures();
        if (this.watched.size !== before) this.emitPropertyChanged("variablesJson", "");
        else if ([...this.watched].some((node) => node.parent === undefined))
            this.emitPropertyChanged("variablesJson", "");
    };

    private readonly featureChanged = (property: string) => {
        if (property === "definitionJson" || property === "name" || property === "variablesJson")
            this.emitPropertyChanged("variablesJson", "");
    };
}
