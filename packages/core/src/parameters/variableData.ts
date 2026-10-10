// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Logger } from "../foundation/logger";
import type { IPropertyChanged } from "../foundation/observer";
import type { INode } from "../model/node";
import type { ExpressionFunction } from "./expression";
import type { VariableType } from "./unitSpec";

/** One document-level parameter: a named, typed value usable across the whole document. */
export interface VariableData {
    readonly id: string;
    readonly name: string;
    /** The unit the user declares; an expression must resolve to it (or be unitless). */
    readonly type: VariableType;
    readonly expression: string;
    readonly description?: string;
    /** Derived variables may report a lost measurement without exposing a stale value. */
    readonly evaluationError?: string;
    /** The value is measured from geometry: the expression is the measurement, not editable text. */
    readonly measured?: boolean;
}

/**
 * The value of a `function` row — set by a feature (`setVariable` in FeatureScript), called
 * as `#name(args)` from expressions. Never stored: a feature rebuilds it, and hands it over
 * beside its rows (`IVariableFeatureNode.functionValues`).
 */
export interface FunctionVariable {
    readonly call: ExpressionFunction;
    /** The runtime object behind `call` (the FeatureScript closure), for FeatureScript runs. */
    readonly native?: unknown;
}

/** A modeling feature which contributes variables without becoming a Variable Studio tab. */
export interface IVariableFeatureNode extends INode {
    readonly variableSource: true;
    readonly items: readonly VariableData[];
    readonly variablesJson: string;
    /**
     * Edits one of the feature's variables in place — name, expression, description — the
     * variable table's write path into a feature (one call, one undo step when wrapped in a
     * transaction). A feature without it shows read-only rows.
     */
    updateVariable?(item: VariableData): void;
    /** The values of the feature's `function` rows, by variable name. */
    functionValues?(): ReadonlyMap<string, FunctionVariable>;
}
export function isVariableFeatureNode(node: INode): node is IVariableFeatureNode {
    return (node as Partial<IVariableFeatureNode>).variableSource === true;
}

/**
 * An editable, ordered list of variables — the document table or a Variable Studio. The
 * variables editor works against this, so the same panel edits either.
 */
export interface IVariableSource extends IPropertyChanged {
    readonly document: IDocument;
    /** Ordered: a variable may reference the ones declared above it. */
    readonly items: readonly VariableData[];
    /** The stored list; its change notification is how an editor sees undo and redo. */
    readonly variablesJson: string;
    /** One write, one notification, one undo step. */
    setItems(items: readonly VariableData[]): void;
}

/**
 * A stored variable list as rows. Loaded documents, undo records and setters all reach
 * this string; a corrupt one must read as empty, not throw out of every reader — the
 * panel's `evaluate`, and the scope every command resolves its parameters against.
 */
export function parseVariableItems(json: string, owner: string): readonly VariableData[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        Logger.error(`${owner}: the stored table is not readable`, error);
        return [];
    }
    if (Array.isArray(parsed)) return parsed as VariableData[];
    Logger.error(`${owner}: the stored table is a ${typeof parsed}, not a list`);
    return [];
}
