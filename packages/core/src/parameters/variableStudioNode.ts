// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Id } from "../foundation/id";
import { Node } from "../model/node";
import type { INodeIcon } from "../model/nodeIcon";
import type { INodeSceneless } from "../model/nodeSceneless";
import { serializable, serialize } from "../serialize";
import { type IVariableSource, parseVariableItems, type VariableData } from "./variableData";

export interface VariableStudioNodeOptions {
    document: IDocument;
    name?: string;
    id?: string;
    /** The stored list, as a loaded document hands it back. */
    variablesJson?: string;
    /** Or the rows themselves, for a studio made in code. */
    items?: readonly VariableData[];
}

/**
 * A Variable Studio: a list of variables kept in the document as its own element (Onshape's
 * Variable Studio tab), in the same `VariableData` shape as the document's parameter table.
 * It has no geometry. Being in the document is being imported: its variables are a layer of
 * the document scope (see `IVariableTable` for the precedence), so every expression in the
 * Part Studio can use them.
 *
 * `variablesJson` is a recorded property — an edit is one undo step — and a change of it
 * re-scopes the document, which re-derives every body and sketch the same way a table edit does.
 */
@serializable()
export class VariableStudioNode extends Node implements INodeIcon, INodeSceneless, IVariableSource {
    get icon(): string {
        return "icon-tag";
    }

    readonly sceneless = true as const;

    constructor(options: VariableStudioNodeOptions) {
        super(options.document, options.name ?? "Variable Studio", options.id ?? Id.generate());
        this.setPrivateValue("variablesJson", options.variablesJson ?? JSON.stringify(options.items ?? []));
    }

    @serialize()
    get variablesJson(): string {
        return this.getPrivateValue("variablesJson");
    }
    set variablesJson(value: string) {
        // After the write, not inside it: the studio's own listeners (its editor) see the new
        // rows before the scope listeners re-derive from them.
        if (this.setProperty("variablesJson", value)) this.document.variables.notifyScopeChanged();
    }

    get items(): readonly VariableData[] {
        return parseVariableItems(this.variablesJson, `variable studio "${this.name}"`);
    }

    setItems(items: readonly VariableData[]): void {
        this.variablesJson = JSON.stringify(items);
    }

    /**
     * A copy with fresh row ids: rows of every layer report their errors and values by id
     * in one map (`EvaluatedVariables`), so two studios must not share them.
     */
    override clone(): this {
        const copy = super.clone();
        const rows = this.items.map((item) =>
            item !== null && typeof item === "object" ? { ...item, id: Id.generate() } : item,
        );
        copy.setPrivateValue("variablesJson", JSON.stringify(rows));
        return copy;
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}

export function isVariableStudioNode(node: unknown): node is VariableStudioNode {
    return node instanceof VariableStudioNode;
}
