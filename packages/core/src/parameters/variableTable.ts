// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { NodeRecord } from "../foundation/history";
import { HistoryObservable } from "../foundation/observer";
import { type INode, NodeUtils } from "../model/node";
import {
    type ActiveConfigurationData,
    type ConfigurationData,
    type ConfigurationInputData,
    configurationInputValue,
    parseActiveConfiguration,
    parseConfigurationInputs,
} from "./configuration";
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
import {
    type IVariableFeatureNode,
    type IVariableSource,
    isVariableFeatureNode,
    parseVariableItems,
    type VariableData,
} from "./variableData";
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
    return evaluateDocumentScope(undefined, layers, base, context);
}

/** Names the configuration layer in the shadowing warnings of the layers above it. */
export const CONFIGURATION_LAYER = "the configuration";

/**
 * The whole document scope: the configuration's inputs in the active configuration first
 * (the lowest layer), then `layers` lowest first, as `evaluateVariableLayers` resolves them.
 * Input rows report by input id, like variable rows. `context` (the document and its data
 * tables' token) rides along the scope, so `data(...)` resolves in every layer.
 */
export function evaluateDocumentScope(
    configuration: ConfigurationData | undefined,
    layers: readonly VariableLayer[],
    base: Scope = EMPTY_SCOPE,
    context?: ScopeContext,
): EvaluatedVariables {
    const result = accumulator(base, context ?? scopeContext(base));
    if (configuration !== undefined) evaluateConfigurationLayer(configuration, result);
    for (const layer of layers) evaluateLayer(layer.items, layer.name, result);
    return result;
}

function evaluateConfigurationLayer(configuration: ConfigurationData, result: Accumulator): void {
    const defined = new Set<string>();
    for (const input of configuration.inputs) {
        if (input === null || typeof input !== "object") continue;
        const error = evaluateConfigurationInput(input, configuration.active, result, defined);
        if (error !== undefined) result.errors.set(String(input.id), error);
    }
}

/** Resolves one configuration input into `result`; returns the error message when it cannot. */
function evaluateConfigurationInput(
    input: ConfigurationInputData,
    active: ActiveConfigurationData,
    result: Accumulator,
    defined: Set<string>,
): string | undefined {
    if (typeof input.name !== "string" || !NAME_PATTERN.test(input.name)) {
        return `Invalid configuration input name: ${String(input.name)}`;
    }
    if (isConstantName(input.name)) return `Configuration input name shadows a constant: ${input.name}`;
    if (defined.has(input.name)) return `Duplicate configuration input name: ${input.name}`;
    defined.add(input.name);
    const value = configurationInputValue(input, active, result.scope);
    if (!value.isOk) return value.error;
    const id = String(input.id);
    if (result.scope.has(input.name)) {
        const origin = result.origins.get(input.name) ?? "a lower layer";
        result.warnings.set(id, `Shadows ${input.name} from ${origin}`);
    }
    result.scope.set(input.name, value.value);
    result.values.set(id, value.value);
    result.origins.set(input.name, CONFIGURATION_LAYER);
    return undefined;
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
    if (item.evaluationError) return item.evaluationError;

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
 * Precedence, lowest to highest (see `evaluateDocumentScope`):
 *   0. The configuration: its inputs in the active configuration (`configuration.ts`) — a
 *      list input as its option index carrying the option name, a checkbox as 1 / 0, a
 *      configuration variable as its value.
 *   1. Variable Studios, in model-tree order (the order of their element tabs). Each sees
 *      the configuration and the studios before it, and may shadow their names.
 *   2. This table. It sees every studio, and shadows any studio name it redefines.
 * A name repeated within one layer is an error on the later row; shadowing across layers
 * is allowed and reported as a warning on the shadowing row.
 *
 * The scope also carries the document (`scopeContext`), so registered expression functions —
 * `data("Prices", "B3")` — read its data tables, and a `token` fingerprinting those tables:
 * a data source that changes re-scopes the document like a studio edit does.
 *
 * Everything that resolves an expression reads `evaluate().scope`, so a studio — or the
 * active configuration — reaches feature parameters, sketch dimensions and FeatureScript's
 * `getVariable` with no change at the call sites; listeners re-derive on the `"scope"`
 * notification, which fires when any layer changes — a table write, a studio edit, a studio
 * added, removed or moved, a configuration input edited, another configuration activated,
 * a data source refreshed.
 */
export interface IVariableTable extends IVariableSource {
    get variablesJson(): string;
    set variablesJson(value: string);
    /**
     * The configuration inputs, as JSON (a `ConfigurationInputData[]`). A recorded property:
     * an input edit is one undo step, captured by version control.
     */
    get configurationJson(): string;
    set configurationJson(value: string);
    readonly configurationInputs: readonly ConfigurationInputData[];
    /**
     * One write, one notification, one undo step. `active`, when given, is switched to in the
     * same notification and stays unrecorded — what keeps the active choice on an input or
     * option that was just renamed, with one rebuild rather than two.
     */
    setConfigurationInputs(inputs: readonly ConfigurationInputData[], active?: ActiveConfigurationData): void;
    /**
     * The active configuration, as JSON (an `ActiveConfigurationData`). NOT recorded:
     * switching configurations is a view of the document, not an edit — it never enters the
     * undo stack or the version history — but it is saved with the document. A switch bumps
     * the revision and notifies `"scope"` like any layer change, so everything rebuilds.
     */
    get activeConfigurationJson(): string;
    set activeConfigurationJson(value: string);
    readonly activeConfiguration: ActiveConfigurationData;
    setActiveConfiguration(active: ActiveConfigurationData): void;
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

/**
 * The configuration as a document saves it (`configuration: {inputs, active}`), or undefined
 * for a document without one — which then serializes exactly as it did before configurations.
 */
export function documentConfiguration(table: IVariableTable): ConfigurationData | undefined {
    const inputs = table.configurationInputs;
    const active = table.activeConfiguration;
    if (inputs.length === 0 && Object.keys(active).length === 0) return undefined;
    return { inputs, active };
}

/** Restores a saved `configuration` key onto `table` (inputs first, then the active choice). */
export function restoreConfiguration(table: IVariableTable, data: unknown): void {
    if (data === null || typeof data !== "object") return;
    const { inputs, active } = data as Partial<ConfigurationData>;
    table.setConfigurationInputs(Array.isArray(inputs) ? inputs : []);
    table.setActiveConfiguration(active !== null && typeof active === "object" ? active : {});
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
        this.setPrivateValue("configurationJson", "[]");
        this.setPrivateValue("activeConfigurationJson", "{}");
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

    get configurationJson(): string {
        return this.getPrivateValue("configurationJson");
    }

    set configurationJson(value: string) {
        if (this.setProperty("configurationJson", value, () => this._revision++)) this.emitScopeChanged();
    }

    get configurationInputs(): readonly ConfigurationInputData[] {
        return parseConfigurationInputs(this.configurationJson);
    }

    setConfigurationInputs(
        inputs: readonly ConfigurationInputData[],
        active?: ActiveConfigurationData,
    ): void {
        const oldActive = this.activeConfigurationJson;
        const nextActive = active === undefined ? oldActive : JSON.stringify(active);
        // The active choice lands first and silently, so the input write's one revision bump
        // and one "scope" notification cover both.
        if (nextActive !== oldActive) this.setPrivateValue("activeConfigurationJson", nextActive);
        const written = this.setProperty("configurationJson", JSON.stringify(inputs), () => this._revision++);
        if (nextActive === oldActive) {
            if (written) this.emitScopeChanged();
            return;
        }
        if (!written) this._revision++;
        this.emitPropertyChanged("activeConfigurationJson", oldActive);
        this.emitScopeChanged();
    }

    get activeConfigurationJson(): string {
        return this.getPrivateValue("activeConfigurationJson");
    }

    set activeConfigurationJson(value: string) {
        // Deliberately not `setProperty`: that would record the switch as an undo step and a
        // microversion. The revision still moves before the notifications go out.
        const old = this.activeConfigurationJson;
        if (old === value) return;
        this.setPrivateValue("activeConfigurationJson", value);
        this._revision++;
        this.emitPropertyChanged("activeConfigurationJson", old);
        this.emitScopeChanged();
    }

    get activeConfiguration(): ActiveConfigurationData {
        return parseActiveConfiguration(this.activeConfigurationJson);
    }

    setActiveConfiguration(active: ActiveConfigurationData): void {
        this.activeConfigurationJson = JSON.stringify(active);
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
            const configuration = { inputs: this.configurationInputs, active: this.activeConfiguration };
            const tables = dataTablesKey(this.document);
            const context: ScopeContext = {
                document: this.document,
                ...(tables === "" ? {} : { token: tables }),
            };
            this._evaluated = {
                revision: this._revision,
                result: evaluateDocumentScope(configuration, layers, EMPTY_SCOPE, context),
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
    private studios(): (VariableStudioNode | IVariableFeatureNode)[] {
        const isSource = (node: INode): node is VariableStudioNode | IVariableFeatureNode =>
            isVariableStudioNode(node) || isVariableFeatureNode(node);
        return this.document.modelManager.findNodes(isSource).filter(isSource);
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
            isVariableStudioNode(node) ||
            isVariableFeatureNode(node) ||
            NodeUtils.isLinkedListNode(node) ||
            isDataTableNode(node);
        if (records.some((record) => touched(record.node))) this.notifyScopeChanged();
    };

    override disposeInternal(): void {
        this.document?.modelManager?.removeNodeObserver(this.handleNodesChanged);
        this._evaluated = undefined;
        super.disposeInternal();
    }
}
