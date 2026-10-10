// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    expressionIdentifiers,
    type IDocument,
    Id,
    type INode,
    type INodeIcon,
    type INodeSceneless,
    type IVariableFeatureNode,
    Node,
    type NodeDependencies,
    Result,
    resolveUnitSpec,
    selectConfiguredBoolean,
    serializable,
    serialize,
    UNITLESS,
    type VariableData,
} from "@chili3d/core";
import { syncNodeWatches } from "../nodeWatch";
import { ensureVariableSync } from "../variableSync";
import {
    type MeasuredVariableData,
    measuredExpression,
    measuredVariableType,
    measureReferences,
} from "./measurement";

@serializable({ id: "MeasuredVariableNode" })
export class MeasuredVariableNode extends Node implements INodeIcon, INodeSceneless, IVariableFeatureNode {
    readonly sceneless = true as const;
    readonly variableSource = true as const;
    readonly variableSyncOrder = 2;
    readonly icon = "icon-tag";
    private measured: Result<number> = Result.err("Measurement has not resolved yet.");
    private suppressed = false;
    private refreshing = false;
    private readonly watched = new Map<string, INode>();

    constructor(options: {
        document: IDocument;
        id?: string;
        definition?: MeasuredVariableData;
        definitionJson?: string;
    }) {
        super(options.document, "Variable", options.id ?? Id.generate());
        this.setPrivateValue(
            "definitionJson",
            options.definitionJson ??
                JSON.stringify(
                    options.definition ?? {
                        name: "Length",
                        source: "measured",
                        mode: "length",
                        entities: [],
                    },
                ),
        );
        options.document.modelManager.addNodeObserver(this.nodesChanged);
        ensureVariableSync(options.document);
    }
    @serialize()
    get definitionJson(): string {
        return this.getPrivateValue("definitionJson");
    }
    set definitionJson(value: string) {
        if (this.setProperty("definitionJson", value)) this.refresh();
    }
    get definition(): MeasuredVariableData {
        return JSON.parse(this.definitionJson);
    }
    set definition(value: MeasuredVariableData) {
        this.definitionJson = JSON.stringify(value);
    }
    get result(): Result<number> {
        return this.measured;
    }
    get isSuppressed(): boolean {
        return this.suppressed;
    }
    get items(): readonly VariableData[] {
        const data = this.definition;
        if (this.suppressed) return [];
        return [
            {
                id: this.id,
                name: data.name,
                type: data.source === "assigned" ? "length" : measuredVariableType(data.mode),
                description: data.description,
                expression:
                    data.source === "assigned"
                        ? (data.expression ?? "0")
                        : this.measured.isOk
                          ? measuredExpression(data.mode, this.measured.value)
                          : "0",
                evaluationError:
                    data.source === "measured" && !this.measured.isOk ? this.measured.error : undefined,
                ...(data.source === "measured" ? { measured: true } : {}),
            },
        ];
    }
    get variablesJson(): string {
        return JSON.stringify(this.items);
    }
    /** The geometry it measures, and the variables its expression and suppression read. */
    dependencies(): NodeDependencies {
        const data = this.definition;
        const variables = new Set<string>();
        if (typeof data.expression === "string")
            for (const name of expressionIdentifiers(data.expression)) variables.add(name);
        if (typeof data.suppression === "string")
            for (const name of expressionIdentifiers(data.suppression)) variables.add(name);
        return { nodeIds: [...new Set(data.entities.map((ref) => ref.nodeId))], variables: [...variables] };
    }
    /**
     * The variable table's write path: the row's name, description and — for an assigned
     * variable — its expression land in the definition (one recorded property, so one undo
     * step inside the table's transaction). A measurement keeps its sources.
     */
    updateVariable(item: VariableData): void {
        const data = this.definition;
        const next: MeasuredVariableData = {
            ...data,
            name: item.name.trim().replace(/^#/, "") || data.name,
            ...(data.source === "assigned" ? { expression: item.expression } : {}),
        };
        if (item.description === undefined || item.description === "") delete next.description;
        else next.description = item.description;
        if (JSON.stringify(next) !== JSON.stringify(data)) this.definition = next;
    }
    private readonly nodesChanged = () => this.refresh();
    private readonly sourceChanged = (property: string) => {
        if (!["visible", "parentVisible", "name"].includes(property)) this.refresh();
    };
    applyVariables() {
        this.refresh();
    }

    refresh(): void {
        if (this.refreshing || !this.parent || this._isDisposed) return;
        this.refreshing = true;
        try {
            const data = this.definition;
            syncNodeWatches(
                this.document,
                this.watched,
                new Set(data.entities.map((ref) => ref.nodeId)),
                this.sourceChanged,
            );
            const scope = this.document.variables.scope;
            let suppression = selectConfiguredBoolean(data.suppression ?? false, scope);
            if (!suppression.isOk && typeof data.suppression === "string") {
                const value = resolveUnitSpec(data.suppression, scope, UNITLESS);
                if (value.isOk) suppression = Result.ok(value.value !== 0);
            }
            this.suppressed = suppression.isOk && suppression.value;
            this.measured = !suppression.isOk
                ? Result.err(suppression.error)
                : this.hasDependencyCycle()
                  ? Result.err(`Circular dependency: source geometry depends on #${data.name}.`)
                  : data.source === "measured"
                    ? measureReferences(this.document, data.mode, data.entities, data.frame)
                    : Result.ok(0);
            const oldName = this.name;
            const value = this.suppressed
                ? "suppressed"
                : data.source === "assigned"
                  ? (data.expression ?? "0")
                  : this.measured.isOk
                    ? measuredExpression(data.mode, Number(this.measured.value.toPrecision(8)))
                    : "unresolved";
            // A long expression (a configured list's every arm) is cut short in the label.
            const label = value.length > 48 ? `${value.slice(0, 47).trimEnd()}…` : value;
            this.setPrivateValue("name", `#${data.name} = ${label}`);
            if (oldName !== this.name) this.emitPropertyChanged("name", oldName);
            this.document.variables.notifyScopeChanged();
        } finally {
            this.refreshing = false;
        }
    }

    /** Walk geometry references and variable aliases before reading a geometry-dependent value. */
    private hasDependencyCycle(): boolean {
        const data = this.definition;
        if (data.source !== "measured") return false;
        const nodes = this.document.modelManager.findNodes();
        const dependentNames = new Set([data.name]);
        const variables = [
            ...this.document.variables.items,
            ...nodes.flatMap((node) =>
                "items" in node && node !== this
                    ? (node as unknown as { items: readonly VariableData[] }).items
                    : [],
            ),
        ];
        const contains = (text: string, name: string) =>
            new RegExp(
                `(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`,
            ).test(text);
        for (let i = 0; i <= variables.length; i++)
            for (const variable of variables)
                if ([...dependentNames].some((name) => contains(variable.expression, name)))
                    dependentNames.add(variable.name);
        const seen = new Set<string>();
        const visit = (id: string): boolean => {
            if (seen.has(id)) return false;
            seen.add(id);
            const node = nodes.find((node) => node.id === id);
            if (!node) return false;
            const candidate = node as INode & {
                dataJson?: string;
                featuresJson?: string;
                definitionJson?: string;
            };
            const text = [candidate.dataJson, candidate.featuresJson, candidate.definitionJson]
                .filter(Boolean)
                .join(" ");
            if ([...dependentNames].some((name) => contains(text, name))) return true;
            return nodes.some((other) => other !== node && text.includes(other.id) && visit(other.id));
        };
        return data.entities.some((ref) => visit(ref.nodeId));
    }
    protected onVisibleChanged() {}
    protected onParentVisibleChanged() {}
    override disposeInternal() {
        this.document.modelManager.removeNodeObserver(this.nodesChanged);
        for (const node of this.watched.values()) node.removePropertyChanged(this.sourceChanged);
        this.watched.clear();
        super.disposeInternal();
    }
}
