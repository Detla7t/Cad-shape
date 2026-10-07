// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    debounce,
    download,
    type IApplication,
    type IDocument,
    type IElementView,
    type INode,
    Logger,
    type NodeRecord,
    Transaction,
    XYZ,
} from "@chili3d/core";
import { button, div, option, select, span, svg } from "@chili3d/element";
import { linkService } from "../link/linkRegistry";
import { describeLinkVersion } from "../link/linkTypes";
import type { PartLinkService } from "../link/partLinkService";
import { applyRigid, arrayToRigid, invert, rigidToArray, toMatrix4, type Vec3 } from "../math/rigid";
import type { AssemblyNode } from "../model/assemblyNode";
import type { MateConnectorData } from "../model/assemblyTypes";
import { connectorFrame, connectorFromSubShape } from "../model/connectors";
import { type AssemblyEvaluation, evaluateAssembly, type InstanceEvaluation } from "../model/evaluate";
import { reanchorMates, solveAssembly, solverInstances, solverMates } from "../model/solve";
import { MATE_TYPES, type MateType, type SolveResult, solveMates } from "../solver/mateSolver";
import style from "./assembly.module.css";
import { AssemblyScene, type SubShapePick } from "./assemblyScene";
import { showBomPanel } from "./bomPanel";
import { showInsertDialog } from "./insertDialog";
import { showVersionPicker, statusClass, statusKey, t, toast } from "./linkUi";
import { createMateEditor } from "./mateEditor";

type Mode =
    | { readonly kind: "idle" }
    | {
          readonly kind: "mate";
          readonly type: MateType;
          readonly first?: { connector: MateConnectorData; pick: SubShapePick };
      };

interface DragState {
    readonly instanceId: string;
    readonly localPoint: Vec3;
    readonly worldPoint: Vec3;
    readonly startX: number;
    readonly startY: number;
    moved: boolean;
    transforms?: ReadonlyMap<string, readonly number[]>;
}

const EXPORT_FORMATS = [".step", ".iges", ".brep", ".stl", ".glb", ".gltf", ".3mf", ".obj"] as const;
const MOUSE_LEFT = 0;

/**
 * The assembly tab: a toolbar, the instance and mate lists, and the assembly's own 3D scene
 * (`AssemblyScene`). Picking two faces/edges/vertices in mate mode infers two mate connectors
 * and adds a mate (solved in the same undo step); dragging an instance runs the solver with a
 * soft drag target, so it moves only within its remaining degrees of freedom, and the drop is
 * one undo step.
 */
export class AssemblyView implements IElementView {
    readonly element: HTMLElement;
    private readonly scene: AssemblyScene;
    private readonly viewport: HTMLElement;
    private readonly instanceList = div({ className: style.list });
    private readonly mateList = div({ className: style.list });
    private readonly status = div({ className: style.status });
    private readonly prompt = span({ className: style.prompt });
    private readonly mateType = select({ className: style.select });
    private readonly mateButton: HTMLButtonElement;
    private readonly fixButton: HTMLButtonElement;
    private evaluation: AssemblyEvaluation = { instances: [], parts: [] };
    private result: SolveResult | undefined;
    private readonly selectedInstances = new Set<string>();
    private readonly selectedMates = new Set<string>();
    private mode: Mode = { kind: "idle" };
    private drag: DragState | undefined;
    private watchedParts = new Set<INode>();
    private disposed = false;
    private readonly unsubscribe: (() => void) | undefined;

    constructor(
        readonly node: AssemblyNode,
        readonly document: IDocument,
    ) {
        this.viewport = div({ className: style.viewport, tabIndex: 0 });
        this.mateButton = button({
            className: style.button,
            title: t("assembly.mate"),
            onclick: () => this.toggleMateMode(),
        });
        this.mateButton.append(svg({ icon: "icon-cCoincident" }), t("assembly.mate"));
        this.fixButton = button({ className: style.button, onclick: () => this.toggleFixed() });
        for (const type of MATE_TYPES) {
            this.mateType.append(option({ value: type, textContent: t(`assembly.mateType.${type}`) }));
        }
        this.mateType.onchange = () => {
            if (this.mode.kind === "mate")
                this.setMode({ kind: "mate", type: this.mateType.value as MateType });
        };
        this.element = div(
            { className: style.root },
            this.createToolbar(),
            div(
                { className: style.body },
                div(
                    { className: style.side },
                    div({ className: style.section, textContent: t("assembly.instances") }),
                    this.instanceList,
                    div({ className: style.section, textContent: t("assembly.mates") }),
                    this.mateList,
                    this.status,
                ),
                this.viewport,
            ),
        );
        this.scene = new AssemblyScene(document.application, this.viewport);
        // Reachable from the DOM (scripts, plugins, end-to-end tests): `element.assemblyView`.
        (this.element as HTMLElement & { assemblyView?: AssemblyView }).assemblyView = this;
        this.bindViewport();
        node.onPropertyChanged(this.handleNodeChanged);
        node.geometryChanged.sub(this.scheduleRefresh);
        document.modelManager.addNodeObserver(this.handleNodes);
        const service = linkService() as PartLinkService | undefined;
        this.unsubscribe = service?.onChanged?.(this.scheduleRefresh);
        this.refresh();
        if (service !== undefined) void service.refresh(node);
    }

    activated(): void {
        this.refresh();
        // Parts may have changed while another tab was open: carry the connectors along and
        // re-solve, as one step (nothing is recorded when no connector moved).
        if (this.node.mates.length > 0) {
            Transaction.execute(this.document, "update mates", () => {
                if (reanchorMates(this.node, this.evaluation) > 0) this.result = solveAssembly(this.node);
            });
        }
        this.viewport.focus({ preventScroll: true });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.node.removePropertyChanged(this.handleNodeChanged);
        this.node.geometryChanged.remove(this.scheduleRefresh);
        this.document.modelManager.removeNodeObserver(this.handleNodes);
        this.unsubscribe?.();
        this.watch([]);
        this.scene.dispose();
    }

    private get application(): IApplication {
        return this.document.application;
    }

    /** Where a world point shows in the viewport (pixels from its top-left), when there is a 3D view. */
    screenPoint(point: Vec3): { x: number; y: number } | undefined {
        const view = this.scene.view;
        if (view === undefined) return undefined;
        const xy = view.worldToScreen(new XYZ(point[0], point[1], point[2]));
        return { x: xy.x, y: xy.y };
    }

    /** The last solve's diagnostics. */
    get solveResult(): SolveResult | undefined {
        return this.result;
    }

    // ------------------------------------------------------------------ Layout

    private createToolbar(): HTMLElement {
        const tool = (icon: string, key: Parameters<typeof t>[0], onclick: () => void) => {
            const element = button({ className: style.button, title: t(key), onclick });
            element.append(svg({ icon }), t(key));
            return element;
        };
        const exportSelect = select(
            { className: style.select, title: t("assembly.export") },
            option({ value: "", textContent: t("assembly.export") }),
            ...EXPORT_FORMATS.map((format) => option({ value: format, textContent: format })),
        );
        exportSelect.onchange = () => {
            const format = exportSelect.value;
            exportSelect.value = "";
            if (format !== "") void this.export(format);
        };
        return div(
            { className: style.toolbar },
            tool("icon-import", "assembly.insert", () => showInsertDialog(this.node, this.document)),
            div({ className: style.separator }),
            this.mateType,
            this.mateButton,
            this.fixButton,
            tool("icon-delete", "assembly.delete", () => this.deleteSelection()),
            div({ className: style.separator }),
            tool("icon-sync-alt", "assembly.solve", () => this.solve(true)),
            tool("icon-all", "assembly.bom", () => showBomPanel(this.node, this.document)),
            exportSelect,
            tool("icon-fitcontent", "assembly.fit", () => this.scene.fit()),
            this.prompt,
        );
    }

    // ------------------------------------------------------------------ Evaluation and lists

    private readonly scheduleRefresh = debounce(() => {
        if (!this.disposed) this.refresh();
    }, 30);

    private readonly handleNodeChanged = (property: keyof AssemblyNode) => {
        if (property === "instancesJson" || property === "matesJson") this.scheduleRefresh();
        if (property === "name") this.renderLists();
    };

    private readonly handleNodes = (_records: NodeRecord[]) => {
        this.scheduleRefresh();
    };

    private readonly handlePartChanged = (property: string) => {
        if (property === "shape" || property === "transform" || property === "name") this.scheduleRefresh();
    };

    private watch(nodes: readonly INode[]): void {
        const next = new Set(nodes);
        for (const node of this.watchedParts)
            if (!next.has(node)) node.removePropertyChanged(this.handlePartChanged);
        for (const node of next)
            if (!this.watchedParts.has(node)) node.onPropertyChanged(this.handlePartChanged);
        this.watchedParts = next;
    }

    /** Re-evaluates the assembly and brings the scene, lists and diagnostics up to date. */
    refresh(): void {
        try {
            this.evaluation = evaluateAssembly(this.document, this.node);
        } catch (error) {
            Logger.error(`assembly "${this.node.name}" failed to evaluate`, error);
            return;
        }
        this.watch(this.evaluation.parts.flatMap((part) => (part.node === undefined ? [] : [part.node])));
        // Diagnostics of the solved state (nothing is written: placements change on Solve and edits).
        this.result = solveAssembly(this.node, { apply: false });
        this.scene.update(this.evaluation);
        this.scene.highlightInstances(this.selectedInstances);
        this.showMateConnectors();
        this.renderLists();
    }

    private renderLists(): void {
        this.renderInstances();
        this.renderMates();
        this.renderStatus();
        const selected = [...this.selectedInstances]
            .map((id) => this.node.instance(id))
            .filter((x) => x !== undefined);
        const allFixed = selected.length > 0 && selected.every((x) => x?.grounded);
        this.fixButton.replaceChildren(
            svg({ icon: allFixed ? "icon-unlock" : "icon-lock" }),
            t(allFixed ? "assembly.unfix" : "assembly.fix"),
        );
        this.fixButton.disabled = selected.length === 0;
        this.mateButton.classList.toggle(style.active, this.mode.kind === "mate");
    }

    private instanceBadges(entry: InstanceEvaluation): (HTMLElement | string)[] {
        const badges: (HTMLElement | string)[] = [];
        const instance = entry.instance;
        if (instance.grounded)
            badges.push(span({ className: style.badge, textContent: t("assembly.fixed") }));
        if (entry.status !== "ok" && entry.status !== "suppressed") {
            badges.push(
                span({
                    className: `${style.badge} ${entry.status === "pending" ? "" : style.error}`,
                    textContent: t(`assembly.status.${entry.status}`),
                    title: entry.message ?? "",
                }),
            );
        }
        if (instance.source.kind === "link") {
            const state = entry.link;
            if (state?.status === "updateAvailable") {
                badges.push(
                    button({
                        className: style.mini,
                        textContent: t("assembly.update"),
                        title: state.update?.label ?? "",
                        onclick: (e) => {
                            e.stopPropagation();
                            void linkService()?.updateToLatest(this.node, instance.id);
                        },
                    }),
                );
            } else if (state !== undefined && entry.status === "ok") {
                badges.push(
                    span({
                        className: `${style.badge} ${statusClass(state)}`,
                        textContent: t(statusKey(state)),
                    }),
                );
            }
            badges.push(
                button({
                    className: style.mini,
                    textContent: t("assembly.versionButton"),
                    onclick: (e) => {
                        e.stopPropagation();
                        const service = linkService() as PartLinkService | undefined;
                        if (service !== undefined) void showVersionPicker(service, this.node, instance.id);
                    },
                }),
            );
        }
        const dof = this.result?.instanceDof.get(instance.id);
        if (dof !== undefined && !instance.grounded) {
            badges.push(
                span({ className: style.badge, title: t("assembly.dof{0}", dof), textContent: `${dof} DOF` }),
            );
        }
        return badges;
    }

    private renderInstances(): void {
        const entries = this.evaluation.instances;
        if (entries.length === 0) {
            this.instanceList.replaceChildren(
                div({ className: style.empty, textContent: t("assembly.noInstances") }),
            );
            return;
        }
        this.instanceList.replaceChildren(
            ...entries.map((entry) => {
                const instance = entry.instance;
                const source = instance.source;
                const sub =
                    source.kind === "link"
                        ? `${source.link.documentName ?? source.link.documentId} · ${describeLinkVersion(source.link)}`
                        : source.kind === "assembly"
                          ? t("assembly.element")
                          : t("assembly.thisDocument");
                return div(
                    {
                        className: `${style.row} ${this.selectedInstances.has(instance.id) ? style.selected : ""}`,
                        onclick: (e) => this.selectInstance(instance.id, e.shiftKey || e.ctrlKey),
                    },
                    span(
                        { className: style.rowName },
                        instance.name,
                        span({ className: style.rowSub, textContent: sub }),
                    ),
                    ...this.instanceBadges(entry),
                );
            }),
        );
    }

    private renderMates(): void {
        const mates = this.node.mates;
        if (mates.length === 0) {
            this.mateList.replaceChildren(
                div({ className: style.empty, textContent: t("assembly.noMates") }),
            );
            return;
        }
        const names = new Map(this.node.instances.map((x) => [x.id, x.name]));
        this.mateList.replaceChildren(
            ...mates.map((mate) => {
                const report = this.result?.mates.find((r) => r.id === mate.id);
                const failing = report !== undefined && !report.satisfied;
                return div(
                    {
                        className: `${style.row} ${this.selectedMates.has(mate.id) ? style.selected : ""}`,
                        onclick: (e) => this.selectMate(mate.id, e.shiftKey || e.ctrlKey),
                    },
                    span(
                        { className: style.rowName },
                        `${t(`assembly.mateType.${mate.type}`)} · ${mate.name}`,
                        span({
                            className: style.rowSub,
                            textContent: `${names.get(mate.a.instanceId) ?? "?"} ↔ ${names.get(mate.b.instanceId) ?? "?"}`,
                        }),
                    ),
                    button({
                        className: style.mini,
                        textContent: t("assembly.flip"),
                        onclick: (e) => {
                            e.stopPropagation();
                            Transaction.execute(this.document, "flip mate", () => {
                                this.node.updateMate(mate.id, { flipped: !mate.flipped });
                                solveAssembly(this.node);
                            });
                        },
                    }),
                    span({
                        className: `${style.badge} ${mate.suppressed ? "" : failing ? style.error : style.ok}`,
                        textContent: mate.suppressed ? "—" : failing ? "✕" : "✓",
                        title: report === undefined ? "" : `${report.residual.toExponential(2)}`,
                    }),
                );
            }),
        );
        const selected = mates.filter((m) => this.selectedMates.has(m.id));
        if (selected.length === 1) this.mateList.append(createMateEditor(this.node, selected[0]));
    }

    private renderStatus(): void {
        const result = this.result;
        if (result === undefined) {
            this.status.textContent = "";
            return;
        }
        const lines = [t("assembly.dof{0}", result.dof)];
        lines.push(
            result.failingMates.length > 0
                ? t("assembly.conflicting{0}", result.failingMates.length)
                : t("assembly.solved"),
        );
        if (result.redundant > 0) lines.push(t("assembly.redundant{0}", result.redundant));
        if (result.floating.length > 0) lines.push(t("assembly.floating{0}", result.floating.length));
        this.status.replaceChildren(...lines.map((line) => div({ textContent: line })));
    }

    private showMateConnectors(): void {
        const placements = new Map(
            this.evaluation.instances.map((x) => [x.instance.id, x.instance.transform]),
        );
        const connectors: {
            frame: ReturnType<typeof connectorFrame>;
            placement: ReturnType<typeof toMatrix4>;
            color?: number;
        }[] = [];
        const add = (connector: MateConnectorData, color?: number) => {
            const transform = placements.get(connector.instanceId);
            if (transform !== undefined)
                connectors.push({
                    frame: connectorFrame(connector),
                    placement: toMatrix4(arrayToRigid(transform)),
                    color,
                });
        };
        for (const mate of this.node.mates) {
            if (!this.selectedMates.has(mate.id)) continue;
            add(mate.a, 0x2b7de9);
            add(mate.b, 0xe9832b);
        }
        if (this.mode.kind === "mate" && this.mode.first !== undefined)
            add(this.mode.first.connector, 0x2b7de9);
        this.scene.showConnectors(connectors, this.connectorSize());
    }

    private connectorSize(): number {
        let size = 10;
        for (const part of this.evaluation.parts) {
            const box = part.shape.boundingBox();
            size = Math.max(
                size,
                Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 6,
            );
        }
        return size;
    }

    // ------------------------------------------------------------------ Selection and commands

    private selectInstance(id: string | undefined, toggle: boolean): void {
        if (!toggle) {
            this.selectedInstances.clear();
            this.selectedMates.clear();
        }
        if (id !== undefined) {
            if (toggle && this.selectedInstances.has(id)) this.selectedInstances.delete(id);
            else this.selectedInstances.add(id);
        }
        this.scene.highlightInstances(this.selectedInstances);
        this.showMateConnectors();
        this.renderLists();
    }

    private selectMate(id: string, toggle: boolean): void {
        if (!toggle) {
            this.selectedMates.clear();
            this.selectedInstances.clear();
        }
        if (toggle && this.selectedMates.has(id)) this.selectedMates.delete(id);
        else this.selectedMates.add(id);
        const mates = this.node.mates.filter((m) => this.selectedMates.has(m.id));
        const instances = new Set(mates.flatMap((m) => [m.a.instanceId, m.b.instanceId]));
        this.scene.highlightInstances(instances);
        this.showMateConnectors();
        this.renderLists();
    }

    private toggleFixed(): void {
        const ids = [...this.selectedInstances];
        if (ids.length === 0) return;
        const fix = !ids.every((id) => this.node.instance(id)?.grounded);
        this.node.setInstances(
            this.node.instances.map((x) => (ids.includes(x.id) ? { ...x, grounded: fix } : x)),
            fix ? "fix instance" : "unfix instance",
        );
    }

    private deleteSelection(): void {
        if (this.selectedMates.size > 0) {
            this.node.removeMates([...this.selectedMates]);
            this.selectedMates.clear();
        } else if (this.selectedInstances.size > 0) {
            this.node.removeInstances([...this.selectedInstances]);
            this.selectedInstances.clear();
        }
    }

    private solve(reanchor = false): void {
        Transaction.execute(this.document, "solve mates", () => {
            if (reanchor) reanchorMates(this.node, this.evaluation);
            this.result = solveAssembly(this.node);
        });
        this.renderLists();
    }

    private async export(format: string): Promise<void> {
        const nodes = this.scene.partNodes;
        if (nodes.length === 0) {
            toast("assembly.noParts");
            return;
        }
        const data = await this.application.dataExchange.export(format, nodes);
        if (data === undefined) return;
        const extension = format.split(" ")[0];
        download(data, `${this.node.name}${extension}`);
        toast("assembly.exported{0}", `${this.node.name}${extension}`);
    }

    // ------------------------------------------------------------------ Mate mode

    private toggleMateMode(): void {
        this.setMode(
            this.mode.kind === "mate"
                ? { kind: "idle" }
                : { kind: "mate", type: this.mateType.value as MateType },
        );
    }

    private setMode(mode: Mode): void {
        this.mode = mode;
        if (mode.kind === "idle") {
            this.prompt.textContent = "";
            this.scene.highlightSubShapes([]);
        } else {
            this.prompt.textContent = t(
                mode.first === undefined ? "assembly.pickFirst" : "assembly.pickSecond",
            );
            this.scene.highlightSubShapes(mode.first === undefined ? [] : [mode.first.pick.data]);
        }
        this.showMateConnectors();
        this.renderLists();
    }

    private pickConnector(x: number, y: number, preferEdges = false): void {
        if (this.mode.kind !== "mate") return;
        const pick = this.scene.pickSubShape(x, y, preferEdges);
        if (pick === undefined) return;
        const connector = connectorFromSubShape(pick.part, pick.shape, pick.index, pick.point);
        if (connector === undefined) {
            toast("assembly.noConnector");
            return;
        }
        const first = this.mode.first;
        if (first === undefined) {
            this.setMode({ ...this.mode, first: { connector, pick } });
            return;
        }
        if (first.connector.instanceId === connector.instanceId) {
            toast("assembly.sameInstance");
            return;
        }
        const type = this.mode.type;
        const index = this.node.mates.filter((m) => m.type === type).length + 1;
        Transaction.execute(this.document, "add mate", () => {
            this.node.addMate({
                id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
                name: `${t(`assembly.mateType.${type}`)} ${index}`,
                type,
                a: first.connector,
                b: connector,
            });
            this.result = solveAssembly(this.node);
        });
        this.setMode({ kind: "idle" });
    }

    // ------------------------------------------------------------------ Viewport events

    private bindViewport(): void {
        const view = this.scene.view;
        const viewHandler = this.scene.document.visual.viewHandler;
        const forward = (
            name: "pointerDown" | "pointerMove" | "pointerUp" | "mouseWheel",
            event: PointerEvent | WheelEvent,
        ) => {
            if (view !== undefined && viewHandler.isEnabled)
                (viewHandler[name] as ((v: typeof view, e: Event) => void) | undefined)?.call(
                    viewHandler,
                    view,
                    event,
                );
        };
        this.viewport.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            this.viewport.focus({ preventScroll: true });
            forward("pointerDown", event);
            if (event.button === MOUSE_LEFT) this.pointerDown(event);
        });
        this.viewport.addEventListener("pointermove", (event) => {
            event.preventDefault();
            forward("pointerMove", event);
            this.pointerMove(event);
        });
        this.viewport.addEventListener("pointerup", (event) => {
            event.preventDefault();
            forward("pointerUp", event);
            if (event.button === MOUSE_LEFT) this.pointerUp(event);
        });
        this.viewport.addEventListener("wheel", (event) => {
            event.preventDefault();
            forward("mouseWheel", event);
        });
        this.viewport.addEventListener("keydown", (event) => {
            if (event.key === "Escape") this.setMode({ kind: "idle" });
            if (event.key === "Delete") this.deleteSelection();
            event.stopPropagation();
        });
    }

    private pointerDown(event: PointerEvent): void {
        if (this.mode.kind === "mate") {
            this.pickConnector(event.offsetX, event.offsetY, event.altKey);
            return;
        }
        const pick = this.scene.pickPart(event.offsetX, event.offsetY);
        if (pick === undefined) {
            this.selectInstance(undefined, false);
            return;
        }
        const instanceId = pick.part.instanceId;
        if (!this.selectedInstances.has(instanceId) || event.shiftKey || event.ctrlKey) {
            this.selectInstance(instanceId, event.shiftKey || event.ctrlKey);
        }
        const instance = this.node.instance(instanceId);
        if (instance === undefined || instance.grounded) return;
        const placement = arrayToRigid(instance.transform);
        this.drag = {
            instanceId,
            localPoint: applyRigid(invert(placement), pick.point),
            worldPoint: pick.point,
            startX: event.offsetX,
            startY: event.offsetY,
            moved: false,
        };
        this.viewport.setPointerCapture?.(event.pointerId);
    }

    private pointerMove(event: PointerEvent): void {
        const drag = this.drag;
        if (drag === undefined || (event.buttons & 1) === 0) return;
        if (!drag.moved && Math.hypot(event.offsetX - drag.startX, event.offsetY - drag.startY) < 3) return;
        drag.moved = true;
        const target = this.scene.pointOnViewPlane(event.offsetX, event.offsetY, drag.worldPoint);
        if (target === undefined) return;
        const result = solveMates(solverInstances(this.node), solverMates(this.node.mates), {
            drag: { instanceId: drag.instanceId, localPoint: drag.localPoint, target },
            noSnap: true,
        });
        const transforms = new Map<string, readonly number[]>();
        for (const [id, transform] of result.transforms) {
            transforms.set(id, rigidToArray(transform));
            const matrix = toMatrix4(transform);
            this.scene.preview(id, (part) => part.inner.multiply(matrix));
        }
        drag.transforms = transforms;
        this.result = result;
    }

    private pointerUp(_event: PointerEvent): void {
        const drag = this.drag;
        this.drag = undefined;
        if (drag?.moved && drag.transforms !== undefined) {
            this.node.setTransforms(drag.transforms, "drag instance");
            this.renderLists();
        }
    }
}
