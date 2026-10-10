// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { download, type I18nKeys, type IDocument, type IElementView, Logger, PubSub } from "@chili3d/core";
import { div, input, label, option, select, span, svg } from "@chili3d/element";
import { EvaluationIndicators } from "@chili3d/react";
import type { CamStudioNode } from "../camStudioNode";
import { type CamGenerator, generatorOf, type OperationStatus } from "../context/generator";
import { formatLength } from "../context/stats";
import { operationTool } from "../context/tools";
import { availableMachines, resolveMachine } from "../machines";
import { type CamCategory, camOperations } from "../model/operation";
import type { CamOperationData, SetupData } from "../model/setup";
import type { ToolpathData } from "../model/toolpath";
import style from "./camStudio.module.css";
import { iconButton, keepFocus, t, textButton } from "./dom";
import { renderMachinePanel } from "./machinePanel";
import { renderOperationPanel, renderOperationStatus, statusDetail } from "./operationPanel";
import { postSetup, renderPostPanel, renderPostReadiness } from "./postPanel";
import { renderSetupPanel } from "./setupPanel";
import { SimulationPanel } from "./simulationPanel";
import {
    commitSetups,
    documentBodies,
    duplicateOperation,
    duplicateSetup,
    handlerOf,
    moveItem,
    newOperation,
    newSetup,
    removeOperation,
    removeSetup,
    replaceSetup,
    updateOperation,
} from "./studioEdits";
import type { DetailMode, StudioHost, StudioViewState } from "./studioHost";
import { CUT_COLOR, PLUNGE_COLOR, type PreviewPath, RAPID_COLOR, ToolpathPreview } from "./toolpathPreview";
import { renderToolsPanel } from "./toolsPanel";

/**
 * The CAM Studio's tab: a panel beside the Part Studio's viewport (the element kind asks
 * for it), so toolpaths preview in the model while the studio is open. Top to bottom: the
 * setups with their operations (status, visibility, generate, suppress, reorder), the
 * editor of the selection (setup, tools, operation, post, machine profile) and the
 * playback bar moving the tool along the shown toolpaths.
 *
 * Document data lives in the studio node and every edit is one transaction on it (undo
 * re-renders through the node's change event); selection, drafts and preview visibility
 * are the view's own.
 */

export interface CamStudioViewOptions {
    readonly download?: (text: string, fileName: string) => void;
    readonly chooseFile?: (accept: string) => Promise<string | undefined>;
    readonly generator?: CamGenerator;
}

const CATEGORY_LABELS: Record<CamCategory, I18nKeys> = {
    "2d": "cam.category.2d",
    "3d": "cam.category.3d",
    "5axis": "cam.category.5axis",
    cutting: "cam.category.cutting",
    wire: "cam.category.wire",
    additive: "cam.category.additive",
};

const pathTokens = new WeakMap<ToolpathData, number>();
let nextPathToken = 1;
function pathToken(path: ToolpathData): number {
    let token = pathTokens.get(path);
    if (token === undefined) {
        token = nextPathToken++;
        pathTokens.set(path, token);
    }
    return token;
}

export class CamStudioView implements IElementView, StudioHost {
    readonly element: HTMLElement;
    readonly generator: CamGenerator;
    readonly preview: ToolpathPreview;
    /** The stock simulation of a setup (its Simulate action). */
    readonly simulation: SimulationPanel;
    readonly state: StudioViewState = { detail: "setup", hidden: new Set(), collapsed: new Set() };
    /** The operation tree's evaluation indicators (one React island per operation, kept across renders). */
    private readonly treeIndicators = new EvaluationIndicators(style.statusHost);
    readonly detailIndicators = new EvaluationIndicators();
    private readonly title = span({ className: style.title });
    private readonly tree = div({ className: style.tree });
    private readonly detail = div({ className: style.detail });
    private readonly slider = input({
        className: style.slider,
        type: "range",
        min: "0",
        max: "1000",
        value: "0",
    });
    private readonly readout = span({ className: style.readout });
    private readonly playButton: HTMLButtonElement;
    private readonly pinnedBox = input({ type: "checkbox", className: style.check });
    private readonly unsubscribe: () => void;
    private active = false;
    private playTimer: ReturnType<typeof setInterval> | undefined;
    private previewKey = "";
    private disposed = false;

    constructor(
        readonly studio: CamStudioNode,
        readonly document: IDocument,
        private readonly options: CamStudioViewOptions = {},
    ) {
        this.generator = options.generator ?? generatorOf(studio);
        this.preview = new ToolpathPreview(document);
        this.simulation = new SimulationPanel(this, () => this.updatePreview());
        this.playButton = iconButton("icon-angle-right", t("cam.play"), () => this.togglePlayback(), "play");
        this.slider.addEventListener("input", () => this.showPlayback(Number(this.slider.value) / 1000));
        this.pinnedBox.addEventListener("change", () => this.updatePreview());
        this.pinnedBox.dataset["field"] = "pinned";
        this.element = div(
            { className: style.root },
            div(
                { className: style.header },
                svg({ className: style.headerIcon, icon: "icon-cog" }),
                this.title,
                textButton(
                    t("cam.generateAll"),
                    () => void this.generator.generateAll(),
                    true,
                    "generate-all",
                ),
            ),
            this.tree,
            this.simulation.element,
            this.detail,
            div(
                { className: style.legend },
                legend(RAPID_COLOR, t("cam.legend.rapid")),
                legend(CUT_COLOR, t("cam.legend.cut")),
                legend(PLUNGE_COLOR, t("cam.legend.plunge")),
                label(
                    { className: style.toggle, title: t("cam.showToolpaths") },
                    this.pinnedBox,
                    span({ textContent: t("cam.pin") }),
                ),
            ),
            div({ className: style.playback }, this.playButton, this.slider, this.readout),
        );
        this.element.dataset["camStudio"] = studio.id;
        studio.onPropertyChanged(this.onStudioChanged);
        this.unsubscribe = this.generator.onChanged(this.onGeneratorChanged);
        this.state.setupId = studio.setups[0]?.id;
        this.render();
    }

    // ------------------------------------------------------------------ IElementView

    activated(): void {
        this.active = true;
        this.render();
        this.updatePreview();
    }

    deactivated(): void {
        this.active = false;
        this.stopPlayback();
        this.updatePreview();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.stopPlayback();
        this.studio.removePropertyChanged(this.onStudioChanged);
        this.unsubscribe();
        this.simulation.dispose();
        this.preview.dispose();
        this.treeIndicators.dispose();
        this.detailIndicators.dispose();
    }

    // ------------------------------------------------------------------ StudioHost

    get setups(): readonly SetupData[] {
        return this.studio.setups;
    }

    commit(name: string, setups: readonly SetupData[]): void {
        commitSetups(this.studio, name, setups);
    }

    commitSetup(name: string, setup: SetupData): void {
        this.commit(name, replaceSetup(this.studio.setups, setup));
    }

    select(change: Partial<Pick<StudioViewState, "setupId" | "operationId" | "detail" | "toolId">>): void {
        Object.assign(this.state, change);
        this.refresh();
        this.updatePreview();
    }

    refresh(): void {
        if (this.disposed) return;
        this.title.textContent = this.studio.name;
        this.renderTree();
        keepFocus(this.detail, () => this.renderDetail());
        this.simulation.refresh();
    }

    toast(message: string): void {
        PubSub.default.pub("showToast", "cam.toast{0}", message);
    }

    download(text: string, fileName: string): void {
        if (this.options.download) this.options.download(text, fileName);
        else download([text], fileName);
    }

    chooseFile(accept: string): Promise<string | undefined> {
        if (this.options.chooseFile) return this.options.chooseFile(accept);
        return new Promise((resolve) => {
            const picker = input({ type: "file", accept });
            picker.addEventListener("change", () => {
                const file = picker.files?.[0];
                if (file === undefined) resolve(undefined);
                else file.text().then(resolve, () => resolve(undefined));
            });
            picker.addEventListener("cancel", () => resolve(undefined));
            picker.click();
        });
    }

    // ------------------------------------------------------------------ Rendering

    private render(): void {
        this.refresh();
    }

    private currentSetup(): SetupData | undefined {
        const setups = this.studio.setups;
        const setup = setups.find((x) => x.id === this.state.setupId) ?? setups[0];
        this.state.setupId = setup?.id;
        return setup;
    }

    private currentOperation(setup: SetupData | undefined): CamOperationData | undefined {
        const operation = setup?.operations.find((x) => x.id === this.state.operationId);
        if (operation === undefined) this.state.operationId = undefined;
        return operation;
    }

    private renderTree(): void {
        const setups = this.studio.setups;
        const current = this.currentSetup();
        const operation = this.currentOperation(current);
        const children: HTMLElement[] = [
            div(
                { className: style.treeHeader },
                span({ textContent: t("cam.setups") }),
                textButton(`+ ${t("cam.newSetup")}`, () => this.addSetup(), false, "add-setup"),
            ),
        ];
        if (setups.length === 0)
            children.push(div({ className: style.empty, textContent: t("cam.noSetups") }));
        setups.forEach((setup, index) => {
            const machine = resolveMachine(this.studio, setup.machineId)?.profile;
            const collapsed = this.state.collapsed.has(setup.id);
            const selected = setup.id === current?.id && operation === undefined;
            const item = div(
                { className: `${style.item} ${style.setupItem}${selected ? ` ${style.selected}` : ""}` },
                iconButton(collapsed ? "icon-angle-right" : "icon-angle-down", "", () => {
                    if (collapsed) this.state.collapsed.delete(setup.id);
                    else this.state.collapsed.add(setup.id);
                    this.renderTree();
                }),
                span({ className: style.itemName, textContent: setup.name }),
                span({ className: style.itemMeta, textContent: machine?.name ?? setup.machineId }),
                div(
                    { className: style.actions },
                    iconButton(
                        "icon-sync-alt",
                        t("cam.generate"),
                        () => void this.generator.generateSetup(setup.id),
                        "generate-setup",
                    ),
                    iconButton(
                        "icon-box",
                        t("cam.simulate"),
                        () => void this.simulateSetup(setup.id),
                        "simulate-setup",
                    ),
                    iconButton("icon-layer-group", t("cam.tools"), () =>
                        this.select({ setupId: setup.id, operationId: undefined, detail: "tools" }),
                    ),
                    iconButton(
                        "icon-download",
                        t("cam.post"),
                        () => this.select({ setupId: setup.id, operationId: undefined, detail: "post" }),
                        "post-setup",
                    ),
                    iconButton("icon-copy", t("cam.duplicate"), () =>
                        this.commit("duplicate setup", [
                            ...setups.slice(0, index + 1),
                            duplicateSetup(setups, setup),
                            ...setups.slice(index + 1),
                        ]),
                    ),
                    iconButton("icon-up", t("cam.moveUp"), () =>
                        this.commit("move setup", moveItem(setups, setup.id, -1)),
                    ),
                    iconButton("icon-down", t("cam.moveDown"), () =>
                        this.commit("move setup", moveItem(setups, setup.id, 1)),
                    ),
                    iconButton(
                        "icon-trash",
                        t("cam.delete"),
                        () => this.commit("delete setup", removeSetup(setups, setup.id)),
                        "delete-setup",
                    ),
                ),
            );
            item.dataset["setup"] = setup.id;
            item.addEventListener("click", () =>
                this.select({
                    setupId: setup.id,
                    operationId: undefined,
                    detail:
                        this.state.detail === "operation" || this.state.detail === "machine"
                            ? "setup"
                            : this.state.detail,
                }),
            );
            children.push(item);
            if (collapsed) return;
            setup.operations.forEach((op) =>
                children.push(this.operationItem(setup, op, op.id === operation?.id)),
            );
            children.push(this.addOperationRow(setup));
        });
        this.tree.replaceChildren(...children);
        this.treeIndicators.sweep();
    }

    private operationItem(setup: SetupData, operation: CamOperationData, selected: boolean): HTMLElement {
        const status = this.generator.status(operation.id);
        const hidden = this.state.hidden.has(operation.id);
        // The shared evaluation indicator (icon + label, reason in its tooltip); the host keeps
        // the generator's raw state as data for tests and styling.
        const indicator = this.treeIndicators.element(
            operation.id,
            this.generator.evaluationSource(operation.id),
        );
        indicator.dataset["state"] = status.state;
        if (status.stale) indicator.dataset["stale"] = "";
        else delete indicator.dataset["stale"];
        const meta =
            status.state === "error" && !status.stale
                ? (status.error ?? "")
                : status.state === "ok" && status.stats
                  ? formatLength(status.stats.cutting)
                  : "";
        const write = (name: string, next: SetupData) => this.commitSetup(name, next);
        const item = div(
            {
                className: `${style.item} ${style.operationItem}${selected ? ` ${style.selected}` : ""}${operation.suppressed ? ` ${style.suppressed}` : ""}`,
                title: statusDetail(status) ?? status.error ?? "",
            },
            indicator,
            iconButton(
                hidden ? "icon-eye-slash" : "icon-eye",
                t("cam.visibility"),
                () => {
                    if (hidden) this.state.hidden.delete(operation.id);
                    else this.state.hidden.add(operation.id);
                    this.renderTree();
                    this.updatePreview();
                },
                "toggle-visibility",
            ),
            span({ className: style.itemName, textContent: operation.name }),
            span({ className: style.itemMeta, textContent: meta }),
            div(
                { className: style.actions },
                iconButton(
                    "icon-sync-alt",
                    t("cam.generate"),
                    () => void this.generator.generateOperation(setup.id, operation.id),
                    "generate-operation",
                ),
                iconButton(
                    "icon-ban",
                    operation.suppressed ? t("cam.unsuppress") : t("cam.suppress"),
                    () =>
                        write(
                            "suppress operation",
                            updateOperation(setup, operation.id, (op) => ({
                                ...op,
                                suppressed: !op.suppressed,
                            })),
                        ),
                    "suppress-operation",
                ),
                iconButton("icon-copy", t("cam.duplicate"), () =>
                    write("duplicate operation", duplicateOperation(setup, operation)),
                ),
                iconButton(
                    "icon-up",
                    t("cam.moveUp"),
                    () =>
                        write("move operation", {
                            ...setup,
                            operations: moveItem(setup.operations, operation.id, -1),
                        }),
                    "move-up",
                ),
                iconButton(
                    "icon-down",
                    t("cam.moveDown"),
                    () =>
                        write("move operation", {
                            ...setup,
                            operations: moveItem(setup.operations, operation.id, 1),
                        }),
                    "move-down",
                ),
                iconButton(
                    "icon-trash",
                    t("cam.delete"),
                    () => write("delete operation", removeOperation(setup, operation.id)),
                    "delete-operation",
                ),
            ),
        );
        item.dataset["operation"] = operation.id;
        item.addEventListener("click", () =>
            this.select({ setupId: setup.id, operationId: operation.id, detail: "operation" }),
        );
        item.addEventListener("dblclick", () => {
            const name = window.prompt?.(t("cam.name"), operation.name);
            if (name && name.trim() !== "")
                write(
                    "rename operation",
                    updateOperation(setup, operation.id, (op) => ({ ...op, name: name.trim() })),
                );
        });
        return item;
    }

    private addOperationRow(setup: SetupData): HTMLElement {
        const machine = resolveMachine(this.studio, setup.machineId)?.profile;
        const handlers = machine === undefined ? [] : camOperations(machine.kind);
        const picker = select({ className: style.select });
        picker.dataset["action"] = "add-operation";
        picker.append(
            option({
                value: "",
                textContent: handlers.length === 0 ? t("cam.noOperationTypes") : t("cam.addOperation"),
            }),
        );
        const groups = new Map<CamCategory, HTMLOptGroupElement>();
        for (const handler of handlers) {
            let group = groups.get(handler.category);
            if (group === undefined) {
                group = document.createElement("optgroup");
                group.label = t(CATEGORY_LABELS[handler.category]);
                groups.set(handler.category, group);
                picker.append(group);
            }
            group.append(option({ value: handler.type, textContent: handler.label }));
        }
        picker.disabled = handlers.length === 0;
        picker.addEventListener("click", (event) => event.stopPropagation());
        picker.addEventListener("change", () => {
            const handler = handlers.find((x) => x.type === picker.value);
            if (handler === undefined || machine === undefined) return;
            const operation = newOperation(setup, machine, handler);
            this.state.setupId = setup.id;
            this.state.operationId = operation.id;
            this.state.detail = "operation";
            this.commitSetup("add operation", { ...setup, operations: [...setup.operations, operation] });
        });
        return div({ className: style.addRow }, picker);
    }

    private renderDetail(): void {
        const setup = this.currentSetup();
        if (setup === undefined && this.state.detail !== "machine") {
            this.detail.replaceChildren(div({ className: style.empty, textContent: t("cam.noSetups") }));
            return;
        }
        const operation = this.currentOperation(setup);
        let mode: DetailMode = this.state.detail;
        if (mode === "operation" && operation === undefined) mode = "setup";
        if (mode === "machine" && this.state.machineDraft === undefined) mode = "setup";
        this.state.detail = mode;
        const tabs: [DetailMode, I18nKeys][] = [
            ["setup", "cam.setup"],
            ["tools", "cam.tools"],
            ...(operation !== undefined
                ? ([["operation", "cam.operation"]] as [DetailMode, I18nKeys][])
                : []),
            ["post", "cam.post"],
            ...(this.state.machineDraft !== undefined
                ? ([["machine", "cam.machine"]] as [DetailMode, I18nKeys][])
                : []),
        ];
        const tabBar = div(
            { className: style.tabs },
            ...tabs.map(([tab, key]) => {
                const button = textButton(t(key), () => this.select({ detail: tab }), false, `tab-${tab}`);
                button.className = `${style.tab}${tab === mode ? ` ${style.activeTab}` : ""}`;
                return button;
            }),
        );
        const heading = div(
            { className: style.detailTitle },
            span({
                textContent:
                    mode === "operation" && operation !== undefined
                        ? operation.name
                        : mode === "machine"
                          ? (this.state.machineDraft?.name ?? "")
                          : (setup?.name ?? ""),
            }),
        );
        let body: HTMLElement;
        try {
            body =
                mode === "operation" && operation !== undefined && setup !== undefined
                    ? renderOperationPanel(this, setup, operation)
                    : mode === "tools" && setup !== undefined
                      ? renderToolsPanel(this, setup)
                      : mode === "post" && setup !== undefined
                        ? renderPostPanel(this, setup)
                        : mode === "machine"
                          ? renderMachinePanel(this, setup)
                          : renderSetupPanel(this, setup!);
        } catch (error) {
            Logger.error("CAM Studio: a panel failed to render", error);
            body = div({ className: style.error, textContent: String(error) });
        }
        this.detail.replaceChildren(tabBar, heading, body);
        this.detailIndicators.sweep();
    }

    private addSetup(): void {
        const setups = this.studio.setups;
        const previous = setups.at(-1);
        const machine =
            (previous === undefined ? undefined : resolveMachine(this.studio, previous.machineId)?.profile) ??
            resolveMachine(this.studio, "generic-3-axis")?.profile ??
            availableMachines(this.studio)[0]?.profile;
        const bodies = documentBodies(this.document.modelManager.findNodes()).filter(
            (node) => node.visible && node.shape.isOk,
        );
        const setup = newSetup(
            setups,
            machine,
            bodies.map((node) => node.id),
        );
        this.state.setupId = setup.id;
        this.state.operationId = undefined;
        this.state.detail = "setup";
        this.commit("new setup", [...setups, setup]);
    }

    // ------------------------------------------------------------------ Change handling

    private readonly onStudioChanged = (property: string) => {
        if (property !== "setupsJson" && property !== "machinesJson" && property !== "name") return;
        this.refresh();
        this.updatePreview();
    };

    private readonly onGeneratorChanged = (operationId?: string) => {
        if (this.disposed) return;
        this.renderTree();
        if (this.simulation.current !== undefined) this.simulation.refresh();
        const setup = this.currentSetup();
        const operation = this.currentOperation(setup);
        if (
            setup !== undefined &&
            operation !== undefined &&
            (operationId === undefined || operationId === operation.id)
        ) {
            const block = this.detail.querySelector<HTMLElement>(`[data-op-status="${operation.id}"]`);
            block?.replaceWith(renderOperationStatus(this, setup, operation));
        }
        // The post action's reasons follow every result (and part rebuild) too.
        if (setup !== undefined) {
            const readiness = this.detail.querySelector<HTMLElement>("[data-post-readiness]");
            readiness?.replaceWith(renderPostReadiness(this, setup.id));
        }
        this.updatePreview();
    };

    // ------------------------------------------------------------------ Preview and playback

    /** The toolpaths the preview shows: the selected setup's visible, generated operations. */
    previewPaths(): PreviewPath[] {
        const setup = this.currentSetup();
        if (setup === undefined) return [];
        const machine = resolveMachine(this.studio, setup.machineId)?.profile;
        return setup.operations.flatMap((operation) => {
            if (operation.suppressed || this.state.hidden.has(operation.id)) return [];
            const toolpath = this.generator.lastToolpath(operation.id);
            if (toolpath === undefined) return [];
            const tool =
                machine === undefined
                    ? undefined
                    : operationTool(setup, machine, { toolId: toolpath.toolId });
            return [{ id: operation.id, toolpath, wcs: setup.wcs, tool }];
        });
    }

    get showsPreview(): boolean {
        return !this.disposed && (this.active || this.pinnedBox.checked);
    }

    updatePreview(): void {
        this.simulation.setShown(this.showsPreview);
        // The simulated stock replaces the toolpaths while it shows (its tool follows the moves).
        if (!this.showsPreview || this.simulation.current !== undefined) {
            if (this.previewKey !== "") {
                this.preview.clear();
                this.previewKey = "";
            }
            return;
        }
        const paths = this.previewPaths();
        const setup = this.currentSetup();
        const key = `${JSON.stringify(setup?.wcs)}|${paths.map((path) => `${path.id}:${pathToken(path.toolpath)}`).join(",")}`;
        if (key === this.previewKey) return;
        this.previewKey = key;
        this.preview.show(paths);
        const position = Number(this.slider.value) / 1000;
        if (position > 0) this.showPlayback(position);
    }

    private showPlayback(position: number): void {
        if (!this.showsPreview) return;
        const point = this.preview.setPlayback(position);
        if (point === undefined) {
            this.readout.textContent = "";
            return;
        }
        const operation = this.currentSetup()?.operations.find((x) => x.id === point.pathId);
        const [x, y, z] = point.wcs.map((v) => v.toFixed(3));
        this.readout.textContent = `${operation?.name ?? ""}  X${x} Y${y} Z${z}`;
    }

    private togglePlayback(): void {
        if (this.playTimer !== undefined) {
            this.stopPlayback();
            return;
        }
        if (Number(this.slider.value) >= 1000) this.slider.value = "0";
        this.playTimer = setInterval(() => {
            const next = Math.min(1000, Number(this.slider.value) + 2);
            this.slider.value = String(next);
            this.showPlayback(next / 1000);
            if (next >= 1000) this.stopPlayback();
        }, 40);
    }

    private stopPlayback(): void {
        if (this.playTimer === undefined) return;
        clearInterval(this.playTimer);
        this.playTimer = undefined;
    }

    /**
     * Simulates a setup's program against its stock (what the setup's Simulate action does):
     * generates what is missing, then shows the stock, its playback and its warnings.
     */
    simulateSetup(setupId: string): Promise<void> {
        return this.simulation.simulate(setupId);
    }

    /** Posts a setup (what the Post tab's button does). */
    postSetup(setupId: string): Promise<boolean> {
        return postSetup(this, setupId);
    }

    /** The status the tree shows for an operation. */
    operationStatus(operationId: string): OperationStatus {
        return this.generator.status(operationId);
    }

    /** True when the operation's handler module is loaded. */
    hasHandler(operation: CamOperationData): boolean {
        return handlerOf(operation) !== undefined;
    }
}

function legend(color: number, text: string): HTMLElement {
    const swatch = span({ className: style.swatch });
    swatch.style.backgroundColor = `#${color.toString(16).padStart(6, "0")}`;
    return span({}, swatch, span({ textContent: text }));
}
