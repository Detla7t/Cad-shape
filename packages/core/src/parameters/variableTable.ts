// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { NodeRecord } from "../foundation/history";
import { HistoryObservable } from "../foundation/observer";
import { type INode, NodeUtils } from "../model/node";
import { dataTablesKey, isDataTableNode } from "./dataTable";
import {
    EMPTY_SCOPE,
    type EvaluatedValue,
    isConstantName,
    resolveUnitSpec,
    type Scope,
    type ScopeContext,
    scopeContext,
    withScopeContext,
} from "./expression";
import { isVariableType, unitSpecOfType } from "./unitSpec";
import { type IVariableSource, parseVariableItems, type VariableData } from "./variableData";
import { isVariableStudioNode, type VariableStudioNode } from "./variableStudioNode";

const NAME_PATTERN = /^[A-Za-z_]\w*$/;

/** One pass over the variables: what resolved, and what did not. */
export interface EvaluatedVariables {
    /** Every name that resolved; where two layers define a name, the higher layer's value. */
    readonly scope: Scope;
    /** Variable id → the message shown on its row. The row is left out of the scope. */
    readonly errors: ReadonlyMap<string, string>;
    /** Variable id → a note that does not stop the row resolving (it shadows a lower layer). */
    readonly warnings: ReadonlyMap<string, string>;
    /** Variable id → what that row itself resolved to — a shadowed row keeps its own value. */
    readonly values: ReadonlyMap<string, EvaluatedValue>;
}

/** One ordered list of variables in the document scope: a Variable Studio, or the table. */
export interface VariableLayer {
    /** Names the layer in the shadowing warnings of the layers above it. */
    readonly name: string;
    readonly items: readonly VariableData[];
}

interface Accumulator {
    readonly scope: Map<string, EvaluatedValue>;
    readonly errors: Map<string, string>;
    readonly warnings: Map<string, string>;
    readonly values: Map<string, EvaluatedValue>;
    /** Name → the layer that defined it, for the shadowing warning. */
    readonly origins: Map<string, string>;
}

function accumulator(base: Scope, context = scopeContext(base)): Accumulator {
    return {
        // The scope being built carries the base's context (or the one given): a row's
        // `data(...)` call finds the document's tables through it.
        scope: withScopeContext(new Map(base), context),
        errors: new Map(),
        warnings: new Map(),
        values: new Map(),
        origins: new Map(),
    };
}

/**
 * Resolves one list in order — a variable may reference the ones above it, never below
 * (that is what keeps a cycle impossible without a graph walk) — on top of `base`, the
 * scope of the layers below. A variable that fails to resolve is left out of the scope
 * and reported in `errors`, so one bad row does not take the rest of the list down.
 *
 * Duplicate names are checked within the list only. Redefining a name `base` already has
 * is allowed — the new value wins from here on — and reported in `warnings`.
 *
 * Pure: the parameters dialog previews a draft table by calling this directly.
 */
export function evaluateVariables(
    items: readonly VariableData[],
    base: Scope = EMPTY_SCOPE,
): EvaluatedVariables {
    const result = accumulator(base);
    evaluateLayer(items, undefined, result);
    return result;
}

/**
 * Resolves the document scope from its layers, LOWEST FIRST: each layer sees the scope
 * of every layer below it, and a name redefined higher up shadows the lower one (with a
 * warning on the shadowing row). Within a layer, a repeated name is an error.
 */
export function evaluateVariableLayers(
    layers: readonly VariableLayer[],
    base: Scope = EMPTY_SCOPE,
    context?: ScopeContext,
): EvaluatedVariables {
    const result = accumulator(base, context ?? scopeContext(base));
    for (const layer of layers) evaluateLayer(layer.items, layer.name, result);
    return result;
}

function evaluateLayer(items: readonly VariableData[], layer: string | undefined, result: Accumulator): void {
    const defined = new Set<string>();
    for (const item of items) {
        // A row that is not an object at all has no id to report against — skip it rather
        // than let it take down the pass every other row depends on.
        if (item === null || typeof item !== "object") continue;
        const error = evaluateVariable(item, layer, result, defined);
        if (error !== undefined) result.errors.set(String(item.id), error);
    }
}

/** Resolves one variable into `result`; returns the error message when it cannot. */
function evaluateVariable(
    item: VariableData,
    layer: string | undefined,
    result: Accumulator,
    defined: Set<string>,
): string | undefined {
    // The fields are typed by the interface but arrive from JSON — a hand-edited or
    // truncated table entry must report on its own row, not throw on `name.length`.
    if (typeof item.name !== "string" || !NAME_PATTERN.test(item.name)) {
        return `Invalid variable name: ${String(item.name)}`;
    }
    if (isConstantName(item.name)) return `Variable name shadows a constant: ${item.name}`;
    if (defined.has(item.name)) return `Duplicate variable name: ${item.name}`;
    // Claimed before the row resolves: a second `w` below a broken first one is still a
    // duplicate, not a silent stand-in that changes meaning once the first is fixed.
    defined.add(item.name);
    if (!isVariableType(item.type)) return `Unknown variable type: ${String(item.type)}`;
    if (typeof item.expression !== "string") return `Missing expression: ${item.name}`;

    // The declared unit, not the expression's — `w = 5` is a length because the
    // user said so, which is what makes `sin(a)` work when `a` is declared an angle.
    const declared = unitSpecOfType(item.type);
    const resolved = resolveUnitSpec(item.expression, result.scope, declared);
    if (!resolved.isOk) return resolved.error;
    const value = { value: resolved.value, unit: declared };
    const id = String(item.id);
    if (result.scope.has(item.name)) {
        const origin = result.origins.get(item.name) ?? "a lower layer";
        result.warnings.set(id, `Shadows ${item.name} from ${origin}`);
    }
    result.scope.set(item.name, value);
    result.values.set(id, value);
    if (layer !== undefined) result.origins.set(item.name, layer);
    return undefined;
}

/**
 * The document's shared parameter table — and the owner of the document's variable
 * SCOPE, which is more than the table: every Variable Studio in the document adds a layer
 * beneath it.
 *
 * Precedence, lowest to highest (see `evaluateVariableLayers`):
 *   1. Variable Studios, in model-tree order (the order of their element tabs). Each sees
 *      the studios before it, and may shadow their names.
 *   2. This table. It sees every studio, and shadows any studio name it redefines.
 * A name repeated within one layer is an error on the later row; shadowing across layers
 * is allowed and reported as a warning on the shadowing row. (Configurations, when they
 * come, slot in as a layer below the studios.)
 *
 * The scope also carries the document (`scopeContext`), so registered expression functions —
 * `data("Prices", "B3")` — read its data tables, and a `token` fingerprinting those tables:
 * a data source that changes re-scopes the document like a studio edit does.
 *
 * Everything that resolves an expression reads `evaluate().scope`, so a studio reaches
 * feature parameters, sketch dimensions and FeatureScript's `getVariable` with no change
 * at the call sites; listeners re-derive on the `"scope"` notification, which fires when
 * any layer changes — a table write, a studio edit, a studio added, removed or moved.
 */
export interface IVariableTable extends IVariableSource {
    get variablesJson(): string;
    set variablesJson(value: string);
    /**
     * Bumped by every change of the scope — any layer, undo and redo included — BEFORE
     * the notifications go out. Consumers de-duplicate on it.
     */
    readonly revision: number;
    /** `evaluate().scope`. Its change notification (`"scope"`) is the one to re-derive on. */
    readonly scope: Scope;
    /** The whole layered scope, memoized per revision; rows of every layer report by id. */
    evaluate(): EvaluatedVariables;
    /**
     * Called by a layer outside the table (a Variable Studio) after its variables changed;
     * re-scopes and notifies when the layers actually differ.
     */
    notifyScopeChanged(): void;
}

/** The table's own name in shadowing warnings — never shown, as nothing sits above it. */
const TABLE_LAYER = "the parameter table";

/**
 * `HistoryObservable` rather than plain `Observable`: its `setProperty` records a
 * `PropertyHistoryRecord`, so a write here is a single undo step for free. The value
 * travels as a JSON string (like a node's `featuresJson`) so undo can assign it back
 * through the setter without knowing the shape.
 */
export class VariableTable extends HistoryObservable implements IVariableTable {
    private _revision = 0;
    private _evaluated: { readonly revision: number; readonly result: EvaluatedVariables } | undefined;
    /** The studio layers as of the last notification, to tell a real change from a no-op. */
    private _layersKey = "";

    constructor(document: IDocument) {
        super(document);
        this.setPrivateValue("variablesJson", "[]");
        // Adding, removing or moving a studio changes the scope — undo of a studio's
        // creation included, which arrives here as a plain node removal.
        document.modelManager.addNodeObserver(this.handleNodesChanged);
    }

    get variablesJson(): string {
        return this.getPrivateValue("variablesJson");
    }

    set variablesJson(value: string) {
        // The revision moves inside the write, before either notification goes out, so a
        // listener reading it sees the revision of the scope it is being told about.
        if (this.setProperty("variablesJson", value, () => this._revision++)) this.emitScopeChanged();
    }

    get items(): readonly VariableData[] {
        return parseVariableItems(this.variablesJson, "variable table");
    }

    get revision(): number {
        return this._revision;
    }

    get scope(): Scope {
        return this.evaluate().scope;
    }

    setItems(items: readonly VariableData[]): void {
        this.variablesJson = JSON.stringify(items);
    }

    evaluate(): EvaluatedVariables {
        if (this._evaluated?.revision !== this._revision) {
            const layers: VariableLayer[] = this.studios().map((studio) => ({
                name: studio.name,
                items: studio.items,
            }));
            layers.push({ name: TABLE_LAYER, items: this.items });
            const tables = dataTablesKey(this.document);
            const context: ScopeContext = {
                document: this.document,
                ...(tables === "" ? {} : { token: tables }),
            };
            this._evaluated = {
                revision: this._revision,
                result: evaluateVariableLayers(layers, EMPTY_SCOPE, context),
            };
        }
        return this._evaluated.result;
    }

    notifyScopeChanged(): void {
        const key = this.layersKey();
        if (key === this._layersKey) return;
        this._layersKey = key;
        this._revision++;
        this.emitScopeChanged();
    }

    private emitScopeChanged(): void {
        // The memo still holds the previous pass here — it is keyed by the old revision.
        this.emitPropertyChanged("scope", this._evaluated?.result.scope ?? EMPTY_SCOPE);
    }

    /** The Variable Studios in the document, in model-tree order — their layer order. */
    private studios(): VariableStudioNode[] {
        return this.document.modelManager.findNodes(isVariableStudioNode).filter(isVariableStudioNode);
    }

    /**
     * What the layers outside the table hold: which studios, in which order, with which
     * variables — and which data tables, at which revisions (`dataTablesKey`).
     */
    private layersKey(): string {
        const studios = this.studios()
            .map((studio) => `${studio.id}\u0000${studio.variablesJson}`)
            .join("\u0001");
        const tables = dataTablesKey(this.document);
        return tables === "" ? studios : `${studios}\u0003${tables}`;
    }

    private readonly handleNodesChanged = (records: NodeRecord[]) => {
        // A folder may carry studios in or out with it (and a loaded document arrives as
        // one record for its root), so any list node is worth a look.
        const touched = (node: INode) =>
            isVariableStudioNode(node) || NodeUtils.isLinkedListNode(node) || isDataTableNode(node);
        if (records.some((record) => touched(record.node))) this.notifyScopeChanged();
    };

    override disposeInternal(): void {
        this.document?.modelManager?.removeNodeObserver(this.handleNodesChanged);
        this._evaluated = undefined;
        super.disposeInternal();
    }
}
