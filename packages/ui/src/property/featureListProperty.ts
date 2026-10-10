// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assignActiveArm,
    Binding,
    configuredArmSource,
    documentParameterInput,
    documentUnit,
    type FeatureItem,
    type FeatureParameter,
    type FeatureReference,
    formatDocumentValue,
    I18n,
    type I18nKeys,
    type IDocument,
    type IFeatureEditSession,
    type IFeatureListNode,
    type INode,
    isConfiguredValue,
    isFeatureListNode,
    Localize,
    NodeEvaluation,
    PartStudioTimeline,
    PubSub,
    ShapeTypes,
    selectConfiguredArm,
    Transaction,
    type UnitSpec,
} from "@chili3d/core";
import { button, div, input, option, select, span, svg } from "@chili3d/element";
import { type EvaluationAction, EvaluationIndicators } from "@chili3d/react";
import { HistoryBar } from "../project/historyBar";
import commonStyle from "./common.module.css";
import { type ConfigureGridKind, showConfigureGrid } from "./configuration/configureGrid";
import { closeFeatureContextMenu, showFeatureContextMenu } from "./featureContextMenu";
import style from "./featureListProperty.module.css";
import { featureDisplayName } from "./featureName";
import inputStyle from "./input.module.css";

interface DropTarget {
    readonly id: string;
    readonly before: boolean;
}

/** The i18n label of a unit the panel can name; undefined for derived ones (area, ...). */
function unitSpecLabelKey(unit: UnitSpec | undefined): I18nKeys | undefined {
    if (unit === undefined) return undefined;
    if (unit.length === 1 && unit.angle === 0) return "variable.type.length";
    if (unit.length === 0 && unit.angle === 1) return "variable.type.angle";
    if (unit.length === 0 && unit.angle === 0) return "variable.type.unitless";
    return undefined;
}

/**
 * Renders the ordered feature list of an `IFeatureListNode` (e.g. a parametric
 * body): one collapsible row per feature — the header expands the inline parameter
 * editor, rows are drag-reordered, and a hover "⋯" button opens a floating menu
 * (rename / reselect / suppress / delete). Edits go through the node's methods
 * inside a transaction, so every change is one undo step.
 */
export class FeatureListProperty extends HTMLElement {
    private readonly expanded = new Set<string>();
    private draggingId: string | undefined;
    private dropTarget: DropTarget | undefined;
    private historyBar?: HistoryBar;
    /** The Part Studio timeline the rollback bar reads and drives (set once the bar exists). */
    private timelineModel?: PartStudioTimeline;
    private picking = false;
    /** Live evaluation states of the node and its features (one listener for the whole list). */
    private readonly evaluation: NodeEvaluation;
    /** The shared evaluation indicator of each row, kept across re-renders. */
    private readonly indicators = new EvaluationIndicators(style.status);
    /** The banner over the list while the node's last rebuild failed. */
    private readonly banner = new EvaluationIndicators(style.statusBanner);
    private indicatorsDisposed = false;

    /**
     * `session` is the feature dialog's edit session: pick parameters become Onshape-style
     * query boxes — click one to make it take selections, the active one is outlined, and
     * the other inputs stay editable while it picks.
     */
    constructor(
        readonly document: IDocument,
        readonly node: INode & IFeatureListNode,
        private readonly featureId?: string,
        private readonly timeline = false,
        private readonly session?: IFeatureEditSession,
    ) {
        super();
        if (featureId) this.expanded.add(featureId);
        this.evaluation = new NodeEvaluation(node, (item) => this.featureName(item));
        this.renderItems();
    }

    connectedCallback(): void {
        // Indicators unmount on disconnect (their subscriptions hold the node); a re-attached
        // list renders them again.
        if (this.indicatorsDisposed) {
            this.indicatorsDisposed = false;
            this.renderItems();
        }
        this.node.onPropertyChanged(this.handleNodeChanged);
        this.timelineModel?.onPropertyChanged(this.handleTimelineChanged);
        PubSub.default.sub("documentUnitsChanged", this.handleUnitsChanged);
        if (this.session) {
            this.session.onPickChanged = () => this.renderItems();
            this.document.selection.onShapeChanged.sub(this.handleSelectionChanged);
        }
    }

    disconnectedCallback(): void {
        if (this.session) {
            this.session.onPickChanged = undefined;
            this.document.selection.onShapeChanged.remove(this.handleSelectionChanged);
        }
        this.node.removePropertyChanged(this.handleNodeChanged);
        this.timelineModel?.removePropertyChanged(this.handleTimelineChanged);
        PubSub.default.remove("documentUnitsChanged", this.handleUnitsChanged);
        this.closeMenu();
        this.historyBar?.dispose();
        this.indicators.dispose();
        this.banner.dispose();
        this.indicatorsDisposed = true;
    }

    /** The active query box shows what is selected right now, as Onshape's does. */
    private readonly handleSelectionChanged = () => {
        if (this.session?.activePick !== undefined) this.renderItems();
    };

    private readonly handleNodeChanged = (property: string) => {
        if (property === "featuresJson") this.renderItems();
    };
    private readonly handleUnitsChanged = (model: IDocument) => {
        if (model === this.document) this.renderItems();
    };
    /** The marker moved elsewhere (the timeline, the tree's bar): follow it. */
    private readonly handleTimelineChanged = (property: string) => {
        if (property !== "position") return;
        // In the tree the list's own bar appears only while the marker splits the body.
        if (this.timeline && this.showsOwnBar() !== (this.historyBar !== undefined)) this.renderItems();
        else this.historyBar?.refresh();
    };

    /**
     * Whether the list draws its own rollback bar. The feature dialog's single row never does;
     * the properties panel always does; inside the tree the document's bar is the one bar, and
     * the body's own appears only while the marker stands inside its features.
     */
    private showsOwnBar(): boolean {
        if (this.featureId || !this.node.setRollbackIndex) return false;
        if (!this.timeline) return true;
        return (
            (this.timelineModel ?? PartStudioTimeline.of(this.document)).nodeState(this.node) === "partial"
        );
    }

    private renderItems() {
        this.closeMenu();
        this.historyBar?.dispose();
        const rows = this.node
            .featureItems()
            .filter((item) => !this.featureId || item.id === this.featureId)
            .map((item) => this.featureRow(item));
        // The whole list (not a single feature's dialog) says when the model shows the last
        // successful result, names the failing feature and opens it.
        const banner = this.featureId
            ? []
            : [
                  this.banner.element("node", this.evaluation.node, {
                      variant: "banner",
                      onlyFailed: true,
                      action: this.editFailingFeature,
                  }),
              ];
        this.replaceChildren(...banner, ...rows);
        this.indicators.sweep();
        this.banner.sweep();
        if (this.picking) this.setInputsDisabled(true);
        this.historyBar = undefined;
        // The body's bar is a view of the Part Studio timeline: one marker for every view. A
        // list inside the tree follows the timeline even without a bar, to grow one when the
        // marker enters the body.
        if (!this.featureId && this.node.setRollbackIndex && this.timelineModel === undefined) {
            this.timelineModel = PartStudioTimeline.of(this.document);
            if (this.isConnected) this.timelineModel.onPropertyChanged(this.handleTimelineChanged);
        }
        if (this.showsOwnBar() && this.timelineModel !== undefined) {
            const timeline = this.timelineModel;
            const bar = new HistoryBar(
                () => rows,
                () => timeline.appliedFeatureCount(this.node),
                (position) => timeline.rollToFeature(this.node, position),
            );
            this.historyBar = bar;
            this.append(bar.element);
            bar.refresh();
        }
    }

    /** "Edit feature" on the banner: opens whichever feature fails now. */
    private readonly editFailingFeature: EvaluationAction = {
        label: I18n.translate("evaluation.editFeature"),
        run: () => {
            const state = this.evaluation.node.state();
            if (state?.kind === "failed" && state.at !== undefined)
                PubSub.default.pub("editFeature", this.node, state.at);
        },
    };

    /** The row's shared evaluation indicator; failed rows offer "Edit feature" outside its dialog. */
    private featureIndicator(item: FeatureItem): HTMLElement {
        return this.indicators.element(item.id, this.evaluation.feature(item.id), {
            hideReady: true,
            action: this.featureId
                ? undefined
                : {
                      label: I18n.translate("evaluation.editFeature"),
                      run: () => PubSub.default.pub("editFeature", this.node, item.id),
                  },
        });
    }

    private isExpanded(item: FeatureItem) {
        // Errored rows stay expanded so the message and repair path remain visible;
        // warnings don't force expansion — the row tint and title carry the hint.
        return this.expanded.has(item.id) || item.error !== undefined;
    }

    private toggleExpand(item: FeatureItem) {
        if (this.expanded.has(item.id)) this.expanded.delete(item.id);
        else this.expanded.add(item.id);
        this.renderItems();
    }

    private featureRow(item: FeatureItem) {
        const expanded = this.isExpanded(item);
        const row = div(
            {
                className: `${style.item} ${item.error === undefined ? "" : style.error} ${
                    item.warning === undefined ? "" : style.warning
                } ${item.suppressed ? style.suppressed : ""}`,
                title: item.error ?? item.warning ?? "",
            },
            this.featureHeader(item, expanded),
            ...(!this.timeline && expanded ? [this.featureBody(item)] : []),
        );
        row.dataset["featureId"] = item.id;
        row.dataset["rolledBack"] = String(
            this.node.rollbackIndex !== undefined &&
                this.node.featureItems().findIndex((f) => f.id === item.id) >= this.node.rollbackIndex,
        );
        if (this.timeline) {
            row.classList.add(style.timelineRow);
            row.setAttribute("role", "treeitem");
            row.addEventListener("dblclick", (event) => {
                event.stopPropagation();
                PubSub.default.pub("editFeature", this.node, item.id);
            });
            row.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.openMenu(row, item);
            });
        }
        this.addDropHandlers(row, item);
        return row;
    }

    private featureHeader(item: FeatureItem, expanded: boolean) {
        const more = svg({
            className: style.more,
            icon: "icon-ellipsis-vertical",
            onclick: (e: MouseEvent) => {
                e.stopPropagation();
                this.openMenu(more, item);
            },
        });
        const header = div(
            {
                className: style.header,
                onclick: (event: MouseEvent) => {
                    event.stopPropagation();
                    if (this.timeline) {
                        this.document.selection.setSelectedNodes([this.node], false);
                        this.querySelectorAll('[aria-selected="true"]').forEach((row) =>
                            row.removeAttribute("aria-selected"),
                        );
                        (event.currentTarget as HTMLElement).parentElement?.setAttribute(
                            "aria-selected",
                            "true",
                        );
                    } else this.toggleExpand(item);
                },
            },
            ...(item.icon === undefined ? [] : [svg({ className: style.icon, icon: item.icon })]),
            span({
                className: style.name,
                textContent: this.featureName(item),
            }),
            this.featureIndicator(item),
            more,
            ...(!this.timeline
                ? [
                      svg({
                          className: style.expander,
                          icon: expanded ? "icon-angle-down" : "icon-angle-right",
                      }),
                  ]
                : []),
        );
        header.draggable = true;
        header.addEventListener("dragstart", this.handleDragStart(item));
        header.addEventListener("dragend", () => this.clearDrag());
        return header;
    }

    private featureName(item: FeatureItem): string {
        return featureDisplayName(this.document, this.node, item);
    }

    private featureBody(item: FeatureItem) {
        // An error outranks a warning for the message slot (they never co-occur:
        // warnings are computed only after a fully successful chain).
        const message =
            item.error !== undefined
                ? div({ className: style.errorText, textContent: item.error })
                : item.warning !== undefined
                  ? div({ className: style.warningText, textContent: item.warning })
                  : undefined;
        return div(
            { className: style.body },
            ...(message === undefined ? [] : [message]),
            ...(this.featureId && item.reselectable && !item.parameters.some((p) => p.pick)
                ? [
                      button({
                          textContent: "Edit selections…",
                          ariaLabel: "Edit feature selections",
                          onclick: () => this.pick(item),
                      }),
                  ]
                : []),
            // A reference the feature also exposes as a parameter (an extrude's sketch) shows once.
            ...(item.references ?? [])
                .filter((ref) => !item.parameters.some((param) => param.key === ref.key))
                .map((ref) => this.referenceRow(item, ref)),
            ...item.parameters.map((param) => this.parameterRow(item, param)),
        );
    }

    /**
     * A node this feature holds (e.g. its sketch). The name is the door: click
     * selects the node, double-click opens it (the node decides what opening means —
     * for a sketch, entering its editing session).
     */
    private referenceRow(item: FeatureItem, ref: FeatureReference) {
        return div(
            { className: style.param },
            span({ className: commonStyle.propertyName, textContent: new Localize(ref.display) }),
            span({
                className: style.reference,
                textContent: new Binding(ref.node, "name"),
                onclick: () => this.document.selection.setSelectedNodes([ref.node], false),
                ondblclick: () => this.node.activateReference?.(item.id, ref.key),
            }),
        );
    }

    private parameterRow(item: FeatureItem, param: FeatureParameter) {
        if (param.pick !== undefined && this.session) return this.queryBox(item, param);
        if (param.optionStyle === "tabs" && param.options !== undefined) return this.optionTabs(item, param);
        return div(
            { className: style.param },
            // A script-defined parameter names itself; built-in ones translate their key.
            span({
                className: commonStyle.propertyName,
                textContent: param.label ?? new Localize(param.display),
            }),
            this.parameterEditor(item, param),
            ...(this.isConfigurable(param) ? [this.configureButton(item, param)] : []),
        );
    }

    private parameterEditor(item: FeatureItem, param: FeatureParameter) {
        if (typeof param.value === "boolean" && param.flip) return this.flipToggle(item, param);
        if (typeof param.value === "boolean") {
            const configured = this.configuredOf(param);
            return input({
                type: "checkbox",
                checked: param.value,
                className: configured === undefined ? "" : style.configuredValue,
                title: configured === undefined ? "" : this.configuredTitle(configured),
                onclick: (e) => this.applyChecked(item, param, (e.target as HTMLInputElement).checked),
            });
        }
        if (param.pick !== undefined) return this.pickParam(item, param);
        if (param.options !== undefined) return this.optionParam(item, param);
        return this.textParamInput(item, param);
    }

    // --- configured parameters ---

    /**
     * Whether the row offers Configure: a numeric slot always (it resolves through
     * `resolveUnitSpec`, which selects the arm) unless the feature says otherwise; a checkbox,
     * dropdown or free-text slot only when the feature says it selects arms itself.
     */
    private isConfigurable(param: FeatureParameter): boolean {
        if (param.pick !== undefined) return false;
        if (param.configurable !== undefined) return param.configurable;
        return typeof param.value !== "boolean" && param.options === undefined && param.text !== true;
    }

    /** The stored `configure(…)` of a configured slot. */
    private configuredOf(param: FeatureParameter): string | undefined {
        if (param.configured !== undefined) return param.configured;
        return isConfiguredValue(param.value) ? param.value : undefined;
    }

    private configuredTitle(configured: string): string {
        return I18n.translate("configuration.configured{0}", configured) ?? configured;
    }

    private gridKind(param: FeatureParameter): ConfigureGridKind {
        if (typeof param.value === "boolean") return "boolean";
        if (param.options !== undefined) return "options";
        return param.text === true ? "text" : "expression";
    }

    private configureButton(item: FeatureItem, param: FeatureParameter) {
        const configured = this.configuredOf(param);
        return button(
            {
                className:
                    configured === undefined ? style.configure : `${style.configure} ${style.configureOn}`,
                title: new Localize("configuration.configure"),
                onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    showConfigureGrid(
                        this.document,
                        {
                            kind: this.gridKind(param),
                            stored: configured ?? param.value,
                            options: param.options,
                        },
                        (value) => this.applyValue(item, param.key, value),
                    );
                },
            },
            svg({ icon: "icon-layer-group" }),
        );
    }

    /**
     * What an edit of the slot stores: a typed `configure(…)` as is; otherwise, on a configured
     * slot, the configured value with the ACTIVE configuration's arm replaced (Onshape edits a
     * configured parameter for the configuration on screen); else the plain value.
     */
    private editedValue(
        param: FeatureParameter,
        value: number | string | boolean,
    ): number | string | boolean {
        const configured = this.configuredOf(param);
        if (configured === undefined || isConfiguredValue(value)) return value;
        const source =
            param.options !== undefined
                ? configuredArmSource(String(value), { text: true })
                : configuredArmSource(value, { text: param.text === true });
        const assigned = assignActiveArm(configured, this.document.variables.evaluate().scope, source);
        return assigned.isOk ? assigned.value : value;
    }

    /** A closed set of choices (e.g. a FeatureScript enum): a dropdown, applied on change. */
    private optionParam(item: FeatureItem, param: FeatureParameter) {
        const configured = this.configuredOf(param);
        return select(
            {
                className:
                    configured === undefined
                        ? `${inputStyle.box} ${style.select}`
                        : `${inputStyle.box} ${style.select} ${style.configuredValue}`,
                title: configured === undefined ? "" : this.configuredTitle(configured),
                onchange: (e) =>
                    this.applyValue(
                        item,
                        param.key,
                        this.editedValue(param, (e.target as HTMLSelectElement).value),
                    ),
            },
            ...(param.options ?? []).map((choice) =>
                option({
                    value: choice.value,
                    textContent: choice.label,
                    selected: choice.value === param.value,
                }),
            ),
        );
    }

    /**
     * Onshape's query box: the parameter's name while empty, what is picked otherwise. A
     * click makes it the box taking selections (the session keeps what the previous box
     * picked).
     */
    private queryBox(item: FeatureItem, param: FeatureParameter) {
        const active = this.session?.activePick === param.key;
        const live = active ? selectionSummary(this.document) : undefined;
        const value = live ?? String(param.value);
        const empty = value === "—" || value === "";
        const label = param.label ?? I18n.translate(param.display) ?? param.key;
        return div(
            {
                className: `${style.queryBox} ${active ? style.queryActive : ""}`,
                role: "button",
                tabIndex: 0,
                ariaLabel: label,
                ariaPressed: String(active),
                title: label,
                onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    void this.node.reselectShapes?.(item.id, param.key);
                },
                onkeydown: (e: KeyboardEvent) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    void this.node.reselectShapes?.(item.id, param.key);
                },
            },
            span({
                className: empty ? style.queryPlaceholder : style.queryValue,
                textContent: empty ? label : value,
            }),
        );
    }

    /** Onshape's horizontal enum: one toggle button per option (New / Add / Remove / Intersect). */
    private optionTabs(item: FeatureItem, param: FeatureParameter) {
        const label = param.label ?? I18n.translate(param.display) ?? param.key;
        return div(
            { className: style.tabs, role: "radiogroup", ariaLabel: label, title: label },
            ...(param.options ?? []).map((choice) =>
                button({
                    className: `${style.tab} ${choice.value === param.value ? style.tabOn : ""}`,
                    role: "radio",
                    ariaChecked: String(choice.value === param.value),
                    textContent: tabLabel(choice.label),
                    onclick: (e: MouseEvent) => {
                        e.stopPropagation();
                        if (choice.value !== param.value)
                            this.applyValue(item, param.key, this.editedValue(param, choice.value));
                    },
                }),
            ),
        );
    }

    /** Onshape's opposite-direction arrow: a toggle button instead of a checkbox. */
    private flipToggle(item: FeatureItem, param: FeatureParameter) {
        const on = param.value === true;
        return button(
            {
                className: `${style.flip} ${on ? style.flipOn : ""}`,
                ariaPressed: String(on),
                title: param.label ?? I18n.translate(param.display) ?? param.key,
                onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    this.applyChecked(item, param, !on);
                },
            },
            span({ textContent: "⇄", ariaHidden: "true" }),
        );
    }

    /** A pick of the body's own entities: the summary, and a button that re-picks. */
    private pickParam(item: FeatureItem, param: FeatureParameter) {
        return div(
            { className: style.pick },
            span({ className: style.pickSummary, textContent: String(param.value) }),
            button({
                className: style.pickButton,
                textContent: new Localize("featurescript.pick"),
                onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    void this.pick(item, param.key);
                },
            }),
        );
    }

    private setInputsDisabled(value: boolean): void {
        this.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
            "input, select, button",
        ).forEach((input) => {
            input.disabled = value;
        });
    }

    private async pick(item: FeatureItem, key?: string): Promise<void> {
        // In a feature dialog the session owns picking: inputs stay live, boxes switch.
        if (this.session) {
            await this.node.reselectShapes?.(item.id, key);
            return;
        }
        this.picking = true;
        this.setInputsDisabled(true);
        try {
            await this.node.reselectShapes?.(item.id, key);
        } catch (error) {
            PubSub.default.pub("displayError", String(error));
        } finally {
            this.picking = false;
            this.setInputsDisabled(false);
        }
    }

    private textParamInput(item: FeatureItem, param: FeatureParameter) {
        const { key, unit } = param;
        const configured = this.configuredOf(param);
        // The stored text — what focusing reveals for editing; a configured slot's is its
        // `configure(…)`, while the box at rest shows what the active configuration selects.
        const raw = configured ?? this.formatFeatureValue(param.value as number | string, param);
        const display = this.displayValue(param, configured);
        const expected = unitSpecLabelKey(unit);
        const unitTitle =
            expected === undefined
                ? ""
                : `${I18n.translate(expected) ?? ""}${unit ? ` (${documentUnit(this.document, unit).suffix})` : ""}`;
        return input({
            className:
                configured === undefined ? inputStyle.box : `${inputStyle.box} ${style.configuredValue}`,
            value: display,
            ariaLabel: param.label ?? I18n.translate(param.display),
            dataset: { initialValue: raw },
            // What the slot measures — the value may be an expression, and the rebuild
            // rejects one of the wrong unit, so say up front what fits.
            title: configured === undefined ? unitTitle : this.configuredTitle(configured),
            // Reveal the raw value for editing; blur without a change
            // restores the trimmed display.
            onfocus: (e) => {
                const box = e.target as HTMLInputElement;
                box.value = raw;
                box.select();
            },
            onkeydown: (e) => this.handleKeyDown(e, item, key),
            onblur: (e) => {
                const box = e.target as HTMLInputElement;
                this.applyParameter(box, item, key);
                // A applied change re-renders the list, detaching this box.
                if (box.isConnected) box.value = display;
            },
        });
    }

    /** The box at rest: the value trimmed, or for a configured slot the active configuration's value. */
    private displayValue(param: FeatureParameter, configured: string | undefined): string {
        if (configured === undefined || param.configured !== undefined) {
            // A feature that reports `configured` already hands the selected value in `value`.
            return this.formatFeatureValue(param.value as number | string, param);
        }
        const selected = selectConfiguredArm(configured, this.document.variables.evaluate().scope);
        return selected.isOk ? this.formatFeatureValue(selected.value, param) : configured;
    }

    private formatFeatureValue(value: number | string, param: FeatureParameter): string {
        return typeof value === "number" && param.unit && this.document.userData?.["displayUnits"]
            ? formatDocumentValue(value, this.document, param.unit, false)
            : this.formatParameterValue(value);
    }

    private readonly handleKeyDown = (e: KeyboardEvent, item: FeatureItem, key: string) => {
        if (e.key !== "Escape" || !this.featureId) e.stopPropagation();
        if (e.key === "Enter") this.applyParameter(e.target as HTMLInputElement, item, key);
    };

    /** Numbers display trimmed to 4 fraction digits; expression strings stay as-is. */
    private formatParameterValue(value: number | string): string {
        return typeof value === "number" ? String(Number(value.toFixed(4))) : value;
    }

    // --- floating menu ---

    private openMenu(anchor: Element, item: FeatureItem) {
        showFeatureContextMenu(this.document, this.node, item, anchor, this);
    }

    private closeMenu() {
        closeFeatureContextMenu(this);
    }

    // --- drag reorder ---

    private readonly handleDragStart = (item: FeatureItem) => (e: DragEvent) => {
        e.stopPropagation();
        this.draggingId = item.id;
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    };

    private addDropHandlers(row: HTMLElement, item: FeatureItem) {
        row.addEventListener("dragover", (e) => this.handleDragOver(e, row, item));
        row.addEventListener("dragleave", () => row.classList.remove(style.dropBefore, style.dropAfter));
        row.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.applyDrop();
        });
    }

    private handleDragOver(e: DragEvent, row: HTMLElement, item: FeatureItem) {
        if (this.draggingId === undefined || this.draggingId === item.id) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        this.dropTarget = { id: item.id, before };
        this.clearDropIndicators();
        row.classList.add(before ? style.dropBefore : style.dropAfter);
    }

    private applyDrop() {
        const target = this.dropTarget;
        const draggingId = this.draggingId;
        this.clearDrag();
        if (target === undefined || draggingId === undefined) return;
        const items = this.node.featureItems();
        const from = items.findIndex((x) => x.id === draggingId);
        let index = items.findIndex((x) => x.id === target.id) + (target.before ? 0 : 1);
        if (from < 0 || index < 0 || from === index || from === index - 1) return;
        if (from < index) index -= 1;
        Transaction.execute(this.document, "reorder features", () => {
            this.moveFeatureTo(draggingId, index);
            this.document.visual.update();
        });
    }

    private moveFeatureTo(featureId: string, index: number) {
        if (this.node.moveFeatureTo !== undefined) {
            this.node.moveFeatureTo(featureId, index);
            return;
        }
        // Fallback for nodes without absolute moves: step towards the target index.
        let current = this.node.featureItems().findIndex((x) => x.id === featureId);
        while (current !== -1 && current < index) {
            this.node.moveFeature(featureId, 1);
            current++;
        }
        while (current !== -1 && current > index) {
            this.node.moveFeature(featureId, -1);
            current--;
        }
    }

    private clearDrag() {
        this.clearDropIndicators();
        this.draggingId = undefined;
        this.dropTarget = undefined;
    }

    private clearDropIndicators() {
        this.querySelectorAll(`.${style.item}`).forEach((row) =>
            row.classList.remove(style.dropBefore, style.dropAfter),
        );
    }

    // --- feature actions ---

    private applyChecked(item: FeatureItem, param: FeatureParameter, checked: boolean) {
        const value = this.editedValue(param, checked);
        Transaction.execute(this.document, "edit feature", () => {
            this.node.setFeatureParameter(item.id, param.key, value);
            this.document.visual.update();
        });
    }

    private applyParameter(box: HTMLInputElement, item: FeatureItem, key: string) {
        const parameter = item.parameters.find((x) => x.key === key);
        const current =
            parameter === undefined ? undefined : (this.configuredOf(parameter) ?? parameter.value);
        // Free text is taken as typed (an empty string included); everything else is a
        // number or an expression and cannot be empty.
        const text = parameter?.text === true ? box.value : box.value.trim();
        if (text === "" && parameter?.text !== true) {
            PubSub.default.pub("showToast", "error.default:{0}", "invalid input");
            box.value = String(current ?? "");
            return;
        }
        if (
            text === box.dataset["initialValue"] ||
            (!this.document.userData?.["displayUnits"] && text === String(current))
        )
            return;
        // A non-numeric value is kept as an expression string; a failure to resolve
        // it surfaces as a feature error on the row.
        const asNumber = Number(text);
        let value: number | string = parameter?.text !== true && Number.isFinite(asNumber) ? asNumber : text;
        if (
            parameter?.unit &&
            !parameter.text &&
            !isConfiguredValue(text) &&
            this.document.userData?.["displayUnits"]
        ) {
            const parsed = documentParameterInput(
                text,
                this.document,
                parameter.unit,
                this.document.variables.scope,
            );
            if (!parsed.isOk) {
                PubSub.default.pub("displayError", parsed.error);
                return;
            }
            value = parsed.value;
        }
        this.applyValue(item, key, parameter === undefined ? value : this.editedValue(parameter, value));
    }

    private applyValue(item: FeatureItem, key: string, value: number | string | boolean) {
        Transaction.execute(this.document, "edit feature", () => {
            this.node.setFeatureParameter(item.id, key, value);
            this.document.visual.update();
        });
    }
}

customElements.define("chili-feature-list", FeatureListProperty);

/** An option label as a tab caption: std enum display names are already words (New, Add…). */
function tabLabel(label: string): string {
    if (label !== label.toUpperCase()) return label;
    const lower = label.toLowerCase().replace(/_/g, " ");
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "2 edges, 1 face" for the current shape selection; undefined when nothing is selected. */
function selectionSummary(document: IDocument): string | undefined {
    const counts = new Map<string, number>();
    for (const shape of document.selection.getSelectedShapes()) {
        const type = shape.shape.shapeType;
        const kind =
            type === ShapeTypes.edge
                ? "edge"
                : type === ShapeTypes.face
                  ? "face"
                  : type === ShapeTypes.vertex
                    ? "vertex"
                    : "part";
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    if (counts.size === 0) return undefined;
    const plural: Record<string, string> = {
        edge: "edges",
        face: "faces",
        vertex: "vertices",
        part: "parts",
    };
    return ["part", "face", "edge", "vertex"]
        .filter((kind) => counts.has(kind))
        .map((kind) => `${counts.get(kind)} ${counts.get(kind) === 1 ? kind : plural[kind]}`)
        .join(", ");
}
