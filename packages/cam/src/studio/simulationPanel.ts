// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type I18nKeys, type IDisposable, type INode, Logger } from "@chili3d/core";
import { div, input, span, svg } from "@chili3d/element";
import { findShapeNode } from "../context/setupGeometry";
import type { WcsData } from "../context/wcs";
import type { SetupData } from "../model/setup";
import type { ToolpathData } from "../model/toolpath";
import { simulateSetup } from "../sim/setupSimulation";
import type { SimulationWarning, SimulationWarningKind, StockSimulation } from "../sim/simulate";
import style from "./camStudio.module.css";
import { iconButton, t, textButton } from "./dom";
import {
    EXCESS_COLOR,
    GOUGE_COLOR,
    ON_PART_COLOR,
    SimulationPreview,
    STOCK_COLOR,
} from "./simulationPreview";
import type { StudioHost } from "./studioHost";

/** What the panel needs of the view: the studio host and its setups. */
export interface SimulationHost extends StudioHost {
    readonly setups: readonly SetupData[];
}

/**
 * The CAM Studio's stock simulation of one setup (the setup's Simulate action): progress
 * while the program is cut, then the stock shown in the model (`SimulationPreview`), a
 * playback slider over the program's straight moves with step and play buttons, a summary
 * (moves, time, cell size, removed volume, what is left and how deep it gouges) and the
 * warnings — rapids into the stock, shank and holder collisions, gouges — each of which
 * selects its operation and shows the stock right after the offending move, with the tool
 * there. The simulation is the view's own (rebuilt on demand, never stored); it says when
 * the toolpaths it was made from have changed.
 */

const WARNING_LABELS: Record<SimulationWarningKind, I18nKeys> = {
    rapidInStock: "cam.sim.warning.rapidInStock",
    shankCollision: "cam.sim.warning.shankCollision",
    holderCollision: "cam.sim.warning.holderCollision",
    gouge: "cam.sim.warning.gouge",
    unsupported: "cam.sim.warning.unsupported",
};

/** Above this many cells, steps while dragging or playing draw a coarser mesh. */
const INTERACTIVE_CELLS = 150_000;

const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

function swatch(color: number, text: string): HTMLElement {
    const box = span({ className: style.simSwatch });
    box.style.backgroundColor = hex(color);
    return span({ className: style.simLegendItem }, box, span({ textContent: text }));
}

function formatVolume(mm3: number): string {
    return mm3 < 1e6 ? `${Math.round(mm3).toLocaleString("en-US")} mm³` : `${(mm3 / 1e6).toFixed(3)} dm³`;
}

function stepButton(text: string, title: string, onclick: () => void, action: string): HTMLButtonElement {
    const button = textButton(text, onclick, false, action);
    button.title = title;
    button.className = style.iconButton;
    return button;
}

const mm = (value: number) => `${value.toFixed(value < 1 ? 3 : 2)} mm`;

export class SimulationPanel implements IDisposable {
    readonly element = div({ className: style.simulation });
    readonly preview: SimulationPreview;
    private simulation: StockSimulation | undefined;
    private setupId: string | undefined;
    private wcs: WcsData | undefined;
    /** The moves of each toolpath simulated, to tell when they are regenerated. */
    private sources: readonly ToolpathData["moves"][] = [];
    private running: AbortController | undefined;
    private progress = 0;
    private error: string | undefined;
    private position = 0;
    private selected: number | undefined;
    private shown = true;
    private playTimer: ReturnType<typeof setInterval> | undefined;
    private drawTimer: ReturnType<typeof setTimeout> | undefined;
    private drawFine = true;
    private progressText: HTMLElement | undefined;
    private slider: HTMLInputElement | undefined;
    private readout: HTMLElement | undefined;
    private disposed = false;

    /** `onChanged` runs when a simulation starts showing or goes. */
    constructor(
        private readonly host: SimulationHost,
        private readonly onChanged?: () => void,
    ) {
        this.preview = new SimulationPreview(host.document);
        this.render();
    }

    /** The simulation shown (after it finished), if any. */
    get current(): StockSimulation | undefined {
        return this.simulation;
    }

    /** The setup simulated (or being simulated). */
    get simulatedSetup(): string | undefined {
        return this.setupId;
    }

    get isRunning(): boolean {
        return this.running !== undefined;
    }

    /** The move the stock is shown after. */
    get shownMove(): number {
        return this.position;
    }

    /** Simulates a setup's program (generating what is missing first) and shows the result. */
    async simulate(setupId: string): Promise<void> {
        this.close();
        const setup = this.host.setups.find((x) => x.id === setupId);
        if (setup === undefined) return;
        const controller = new AbortController();
        this.running = controller;
        this.setupId = setupId;
        this.wcs = setup.wcs;
        this.progress = 0;
        this.render();
        const result = await simulateSetup(this.host.generator, setupId, {
            signal: controller.signal,
            onProgress: (cut, total) => {
                this.progress = total > 0 ? cut / total : 1;
                if (this.progressText !== undefined)
                    this.progressText.textContent = t("cam.sim.running{0}", Math.floor(this.progress * 100));
            },
        });
        if (this.running !== controller || this.disposed) {
            if (result.isOk) result.value.dispose();
            return;
        }
        this.running = undefined;
        if (!result.isOk) {
            this.error = result.error;
            this.host.toast(t("cam.sim.failed{0}", result.error));
            this.render();
            return;
        }
        const simulation = result.value;
        this.simulation = simulation;
        this.sources = simulation.input.toolpaths.map((entry) => entry.toolpath.moves);
        this.position = simulation.moveCount;
        this.render();
        this.draw(true);
        this.onChanged?.();
        Logger.info(
            `CAM: simulated ${simulation.moveCount} moves in ${simulation.elapsedMs.toFixed(0)} ms (${simulation.cellSize} mm cells)`,
        );
    }

    /** Shows or hides the stock with the studio's preview (the panel keeps its state). */
    setShown(shown: boolean): void {
        if (this.shown === shown) return;
        this.shown = shown;
        if (!shown) {
            this.stopPlayback();
            this.preview.clear();
        } else if (this.simulation !== undefined) {
            this.draw(true);
        }
    }

    /** Puts the stock after the first `position` moves. */
    seek(position: number, fine = true): void {
        const simulation = this.simulation;
        if (simulation === undefined) return;
        this.position = Math.max(0, Math.min(simulation.moveCount, Math.round(position)));
        if (this.slider !== undefined) this.slider.value = String(this.position);
        this.updateReadout();
        this.schedule(fine);
    }

    /** Selects a warning: its operation, and the stock right after its first move. */
    selectWarning(index: number): void {
        const simulation = this.simulation;
        const warning = simulation?.warnings[index];
        if (simulation === undefined || warning === undefined) return;
        this.selected = index;
        if (warning.id !== undefined && this.setupId !== undefined) {
            this.host.select({ setupId: this.setupId, operationId: warning.id, detail: "operation" });
        }
        for (const item of this.element.querySelectorAll<HTMLElement>("[data-warning]")) {
            if (item.dataset["warning"] === String(index)) item.dataset["selected"] = "";
            else delete item.dataset["selected"];
        }
        this.seek(Math.min(simulation.moveCount, warning.firstMove + 1));
    }

    /** Ends the simulation (cancels a running one) and removes the stock. */
    close(): void {
        const had = this.simulation !== undefined;
        this.running?.abort();
        this.running = undefined;
        this.stopPlayback();
        if (this.drawTimer !== undefined) clearTimeout(this.drawTimer);
        this.drawTimer = undefined;
        this.simulation?.dispose();
        this.simulation = undefined;
        this.setupId = undefined;
        this.error = undefined;
        this.selected = undefined;
        this.preview.clear();
        this.render();
        if (had) this.onChanged?.();
    }

    /** Re-renders (after the setups or their toolpaths changed). */
    refresh(): void {
        if (this.setupId !== undefined && !this.host.setups.some((x) => x.id === this.setupId)) {
            this.close();
            return;
        }
        this.render();
    }

    dispose(): void {
        if (this.disposed) return;
        this.close();
        this.disposed = true;
        this.preview.dispose();
    }

    // ------------------------------------------------------------------ Drawing

    private schedule(fine: boolean): void {
        this.drawFine = this.drawFine || fine;
        if (this.drawTimer !== undefined) return;
        this.drawTimer = setTimeout(() => {
            this.drawTimer = undefined;
            const fineNow = this.drawFine;
            this.drawFine = false;
            this.draw(fineNow);
        }, 0);
    }

    private draw(fine: boolean): void {
        const simulation = this.simulation;
        if (simulation === undefined || !this.shown || this.wcs === undefined || this.disposed) return;
        simulation.seek(this.position);
        const grid = simulation.grid();
        const cells = grid.nx * grid.ny;
        const step = fine ? 1 : Math.max(1, Math.round(Math.sqrt(cells / INTERACTIVE_CELLS)));
        try {
            this.preview.show(simulation.mesh(step), this.wcs, simulation.tolerance, this.partNodes());
            if (this.position > 0 && this.position < simulation.moveCount) {
                const move = simulation.move(this.position - 1);
                this.preview.showTool(move.to, this.wcs, move.tool);
            } else {
                this.preview.hideTool();
            }
        } catch (error) {
            Logger.warn("CAM: the simulated stock could not be shown", error);
        }
    }

    private partNodes(): INode[] {
        const setup = this.host.setups.find((x) => x.id === this.setupId);
        return (setup?.partIds ?? []).flatMap((id) => findShapeNode(this.host.document, id) ?? []);
    }

    // ------------------------------------------------------------------ Playback

    private togglePlayback(): void {
        const simulation = this.simulation;
        if (simulation === undefined) return;
        if (this.playTimer !== undefined) {
            this.stopPlayback();
            this.schedule(true);
            return;
        }
        if (this.position >= simulation.moveCount) this.seek(0, false);
        const stride = Math.max(1, Math.round(simulation.moveCount / 300));
        this.playTimer = setInterval(() => {
            const next = Math.min(simulation.moveCount, this.position + stride);
            const done = next >= simulation.moveCount;
            this.seek(next, done);
            if (done) this.stopPlayback();
        }, 50);
    }

    private stopPlayback(): void {
        if (this.playTimer === undefined) return;
        clearInterval(this.playTimer);
        this.playTimer = undefined;
    }

    // ------------------------------------------------------------------ Rendering

    private isOutdated(): boolean {
        const simulation = this.simulation;
        const setup = this.host.setups.find((x) => x.id === this.setupId);
        if (simulation === undefined || setup === undefined) return false;
        const live = setup.operations.filter((operation) => !operation.suppressed);
        if (live.length !== this.sources.length) return true;
        return live.some((operation, index) => {
            const status = this.host.generator.status(operation.id);
            return status.stale === true || status.toolpath?.moves !== this.sources[index];
        });
    }

    private render(): void {
        if (this.disposed) return;
        this.progressText = undefined;
        this.slider = undefined;
        this.readout = undefined;
        const setup = this.host.setups.find((x) => x.id === this.setupId);
        if (setup === undefined || (this.simulation === undefined && !this.running && !this.error)) {
            this.element.replaceChildren();
            this.element.hidden = true;
            return;
        }
        this.element.hidden = false;
        const children: HTMLElement[] = [
            div(
                { className: style.simHeader },
                svg({ className: style.headerIcon, icon: "icon-box" }),
                span({ className: style.itemName, textContent: `${t("cam.sim.title")} · ${setup.name}` }),
                this.running
                    ? iconButton("icon-times", t("cam.sim.cancel"), () => this.close(), "cancel-simulation")
                    : iconButton("icon-times", t("cam.sim.close"), () => this.close(), "close-simulation"),
            ),
        ];
        if (this.running) {
            this.progressText = div({
                className: style.note,
                textContent: t("cam.sim.running{0}", Math.floor(this.progress * 100)),
            });
            this.progressText.dataset["simProgress"] = "";
            children.push(this.progressText);
        }
        if (this.error !== undefined) children.push(div({ className: style.error, textContent: this.error }));
        const simulation = this.simulation;
        if (simulation !== undefined) children.push(...this.renderResult(simulation));
        this.element.replaceChildren(...children);
    }

    private renderResult(simulation: StockSimulation): HTMLElement[] {
        const out: HTMLElement[] = [];
        const summary = [
            t("cam.sim.summary{0}{1}", simulation.moveCount, (simulation.elapsedMs / 1000).toFixed(2)),
            t("cam.sim.cells{0}", simulation.cellSize),
            t("cam.sim.removed{0}", formatVolume(simulation.totalRemoved)),
        ];
        out.push(div({ className: style.note, textContent: summary.join(" · ") }));
        const comparison = simulation.comparison();
        if (comparison !== undefined) {
            const parts = [t("cam.sim.leftMax{0}", mm(comparison.maxExcess))];
            if (comparison.gougeCells > 0) parts.push(t("cam.sim.gougeMax{0}", mm(comparison.maxGouge)));
            const line = div({ className: style.note, textContent: parts.join(" · ") });
            line.dataset["simComparison"] = "";
            out.push(line);
        }
        if (this.isOutdated()) {
            const note = div({ className: style.simOutdated, textContent: t("cam.sim.outdated") });
            note.dataset["simOutdated"] = "";
            out.push(note);
        }
        out.push(
            div(
                { className: style.simLegend },
                ...(comparison === undefined
                    ? [swatch(STOCK_COLOR, t("cam.sim.legend.stock"))]
                    : [
                          swatch(ON_PART_COLOR, t("cam.sim.legend.onPart")),
                          swatch(EXCESS_COLOR, t("cam.sim.legend.excess")),
                          swatch(GOUGE_COLOR, t("cam.sim.legend.gouge")),
                      ]),
            ),
        );
        const slider = input({
            className: style.slider,
            type: "range",
            min: "0",
            max: String(simulation.moveCount),
            step: "1",
            value: String(this.position),
        });
        slider.dataset["field"] = "simulation.move";
        slider.addEventListener("input", () => {
            this.stopPlayback();
            this.seek(Number(slider.value), false);
        });
        slider.addEventListener("change", () => this.seek(Number(slider.value), true));
        this.slider = slider;
        this.readout = div({ className: style.simReadout });
        out.push(
            div(
                { className: style.simPlayback },
                stepButton(
                    "\u2039",
                    t("cam.sim.previous"),
                    () => this.seek(this.position - 1),
                    "sim-previous",
                ),
                iconButton("icon-angle-right", t("cam.sim.play"), () => this.togglePlayback(), "sim-play"),
                stepButton("\u203a", t("cam.sim.next"), () => this.seek(this.position + 1), "sim-next"),
                slider,
            ),
            this.readout,
        );
        this.updateReadout();
        out.push(this.renderWarnings(simulation));
        return out;
    }

    private renderWarnings(simulation: StockSimulation): HTMLElement {
        const warnings = simulation.warnings;
        const list = div({ className: style.simWarnings });
        list.append(
            div({
                className: style.sectionTitle,
                textContent: t("cam.sim.warnings{0}", warnings.length),
            }),
        );
        if (warnings.length === 0) {
            list.append(div({ className: style.note, textContent: t("cam.sim.noWarnings") }));
            return list;
        }
        list.append(...warnings.map((warning, index) => this.warningItem(simulation, warning, index)));
        return list;
    }

    private warningItem(simulation: StockSimulation, warning: SimulationWarning, index: number): HTMLElement {
        const setup = this.host.setups.find((x) => x.id === this.setupId);
        const operation = setup?.operations.find((x) => x.id === warning.id);
        const name = operation?.name ?? simulation.input.toolpaths[warning.toolpathIndex]?.label ?? "";
        const moves =
            warning.firstMove === warning.lastMove
                ? t("cam.sim.move{0}{1}", warning.firstMove + 1, simulation.moveCount)
                : t("cam.sim.moves{0}{1}", warning.firstMove + 1, warning.lastMove + 1);
        const detail = [name, moves];
        if (warning.depth > 0) detail.push(t("cam.sim.depth{0}", mm(warning.depth)));
        const dot = span({ className: style.simDot });
        dot.dataset["kind"] = warning.kind;
        const item = div(
            { className: style.simWarning },
            dot,
            span({ className: style.simWarningKind, textContent: t(WARNING_LABELS[warning.kind]) }),
            span({ className: style.itemMeta, textContent: detail.join(" · ") }),
        );
        item.dataset["warning"] = String(index);
        item.dataset["kind"] = warning.kind;
        if (this.selected === index) item.dataset["selected"] = "";
        item.addEventListener("click", () => this.selectWarning(index));
        return item;
    }

    private updateReadout(): void {
        const simulation = this.simulation;
        if (this.readout === undefined || simulation === undefined) return;
        const text = [t("cam.sim.move{0}{1}", this.position, simulation.moveCount)];
        if (this.position > 0) {
            const move = simulation.move(this.position - 1);
            const setup = this.host.setups.find((x) => x.id === this.setupId);
            const name =
                setup?.operations.find((x) => x.id === move.id)?.name ??
                simulation.input.toolpaths[move.toolpathIndex]?.label;
            if (name) text.push(name);
            text.push(`X${move.to[0].toFixed(3)} Y${move.to[1].toFixed(3)} Z${move.to[2].toFixed(3)}`);
        }
        this.readout.textContent = text.join(" · ");
    }
}
