// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    download,
    type I18nKeys,
    type IDocument,
    type IElementView,
    type IView,
    Logger,
    openElement,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { div, input, label, option, select, span, svg } from "@chili3d/element";
import { type MachineProfileData, machineProfile, machineProfiles } from "../../model/machine";
import { postProcessors } from "../../model/post";
import { iconButton, t, textButton } from "../../studio/dom";
import { CUT_COLOR, PLUNGE_COLOR, RAPID_COLOR } from "../../studio/toolpathPreview";
import { dialectOfPost, ncDialect, ncDialects } from "../dialects";
import { NC_PROGRAM_ICON, NcProgramNode } from "../ncProgramNode";
import type { NcDialectId, NcProgram } from "../program";
import { readNcProgram } from "../reader";
import { repostNcProgram } from "../repost";
import { formatNcDuration } from "../stats";
import { ncProgramActions } from "./actions";
import { EXTRUDE_COLOR, type MoveRef, NcBackplot } from "./backplot";
import type { GcodeEditor, GcodeEditorCallbacks } from "./gcodeEditor";
import style from "./ncProgram.module.css";

/**
 * The NC Program's tab: a panel beside the Part Studio's viewport, the program's backplot
 * drawn in the model while it is open (the CAM Studio's way). Top to bottom: the header
 * (save, re-post as any post into a new element or a download), the dialect and the
 * machine the program is read for, the G-code editor, the playback bar moving a tool
 * marker along the backplot, the legend with the viewer actions, and the statistics and
 * problems of the program.
 *
 * The text is edited as a draft, re-read (debounced) as it changes so the backplot follows,
 * and written to the node by Save (Ctrl+S) — one undo step. A line under the cursor
 * highlights its moves; a click on the backplot puts the cursor on the move's line.
 */

export interface NcProgramViewOptions {
    readonly download?: (text: string, fileName: string) => void;
    /** Milliseconds between the last edit and re-reading the program (default 300). */
    readonly parseDelay?: number;
    /** Creates the editor (default: the CodeMirror editor, loaded on first use). */
    readonly createEditor?: (
        parent: HTMLElement,
        text: string,
        callbacks: GcodeEditorCallbacks,
    ) => Promise<GcodeEditor>;
}

type PanelTab = "stats" | "problems";

const MAX_SLIDER = 1000;

async function loadEditor(parent: HTMLElement, text: string, callbacks: GcodeEditorCallbacks) {
    const { createGcodeEditor } = await import("./gcodeEditor");
    return createGcodeEditor(parent, text, callbacks);
}

function swatch(color: number, text: string, dashed = false): HTMLElement {
    const mark = span({ className: style.swatch });
    mark.style.backgroundColor = `#${color.toString(16).padStart(6, "0")}`;
    if (dashed)
        mark.style.backgroundImage =
            "linear-gradient(90deg, transparent 50%, var(--panel-background-color) 50%)";
    if (dashed) mark.style.backgroundSize = "4px 3px";
    return span({}, mark, span({ textContent: text }));
}

const mm = (value: number) => `${Number(value.toFixed(3))} mm`;

export class NcProgramView implements IElementView {
    readonly element: HTMLElement;
    readonly backplot: NcBackplot;
    /** The program as last read from the draft. */
    program: NcProgram | undefined;
    private editor: GcodeEditor | undefined;
    private editorReady: Promise<void>;
    private draft: string;
    private saved: string;
    private parseTimer: ReturnType<typeof setTimeout> | undefined;
    private playTimer: ReturnType<typeof setInterval> | undefined;
    private active = false;
    private disposed = false;
    private tab: PanelTab = "stats";
    private lineMoves = new Map<number, MoveRef[]>();
    private highlighted: MoveRef[] = [];
    private readonly detach: (() => void)[] = [];

    private readonly title = span({ className: style.title });
    private readonly dirtyMark = span({ className: style.dirty, textContent: "", title: t("nc.unsaved") });
    private readonly saveButton: HTMLButtonElement;
    private readonly dialectSelect = select({ className: style.select });
    private readonly machineSelect = select({ className: style.select });
    private readonly postSelect = select({ className: style.select });
    private readonly editorHost = div({ className: style.editor });
    private readonly slider = input({
        className: style.slider,
        type: "range",
        min: "0",
        max: String(MAX_SLIDER),
        value: "0",
    });
    private readonly readout = span({ className: style.readout });
    private readonly playButton: HTMLButtonElement;
    private readonly rapidsBox = input({ type: "checkbox" });
    private readonly tabs = div({ className: style.tabs });
    private readonly panel = div({ className: style.panel });
    private readonly actionBar = div({ className: style.actions });

    constructor(
        readonly node: NcProgramNode,
        readonly document: IDocument,
        private readonly options: NcProgramViewOptions = {},
    ) {
        this.backplot = new NcBackplot(document);
        this.draft = node.source;
        this.saved = node.source;
        this.saveButton = textButton(t("nc.save"), () => this.save(), true, "save");
        this.playButton = iconButton("icon-angle-right", t("cam.play"), () => this.togglePlayback(), "play");
        this.slider.dataset["field"] = "playback";
        this.slider.addEventListener("input", () =>
            this.showPlayback(Number(this.slider.value) / MAX_SLIDER),
        );
        this.rapidsBox.checked = true;
        this.rapidsBox.dataset["field"] = "rapids";
        this.rapidsBox.addEventListener("change", () => this.backplot.setShowRapids(this.rapidsBox.checked));
        this.dialectSelect.dataset["field"] = "dialect";
        this.dialectSelect.addEventListener("change", () => this.setDialect(this.dialectSelect.value));
        this.machineSelect.dataset["field"] = "machine";
        this.machineSelect.addEventListener("change", () => this.setMachine(this.machineSelect.value));
        this.postSelect.dataset["field"] = "post";
        this.element = div(
            { className: style.root },
            div(
                { className: style.header },
                svg({ className: style.headerIcon, icon: NC_PROGRAM_ICON }),
                this.title,
                this.dirtyMark,
                this.saveButton,
                iconButton("icon-download", t("nc.download"), () => this.downloadProgram(), "download"),
            ),
            div(
                { className: style.settings },
                span({ className: style.label, textContent: t("nc.dialect") }),
                this.dialectSelect,
                span({ className: style.label, textContent: t("cam.machine") }),
                this.machineSelect,
                span({ className: style.label, textContent: t("nc.repost") }),
                div(
                    { className: style.repost },
                    this.postSelect,
                    textButton(t("nc.repostElement"), () => this.repost("element"), false, "repost-element"),
                    iconButton(
                        "icon-download",
                        t("nc.repostDownload"),
                        () => this.repost("download"),
                        "repost-download",
                    ),
                ),
            ),
            this.editorHost,
            div({ className: style.playback }, this.playButton, this.slider, this.readout),
            div(
                { className: style.legend },
                swatch(RAPID_COLOR, t("cam.legend.rapid"), true),
                swatch(CUT_COLOR, t("cam.legend.cut")),
                swatch(PLUNGE_COLOR, t("cam.legend.plunge")),
                swatch(EXTRUDE_COLOR, t("nc.legend.extrude")),
                label({ className: style.toggle }, this.rapidsBox, span({ textContent: t("nc.showRapids") })),
                this.actionBar,
            ),
            this.tabs,
            this.panel,
        );
        this.element.dataset["ncProgram"] = node.id;
        this.editorHost.append(div({ className: style.loading, textContent: t("nc.loadingEditor") }));
        this.editorReady = this.mountEditor();
        node.onPropertyChanged(this.onNodeChanged);
        this.renderSettings();
        this.renderActions();
        this.reparse();
        this.updateHeader();
    }

    // ------------------------------------------------------------------ IElementView

    activated(): void {
        this.active = true;
        this.drawBackplot();
        this.attachPicking();
        this.editor?.focus();
    }

    deactivated(): void {
        this.active = false;
        this.stopPlayback();
        this.backplot.clear();
        this.detachPicking();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.stopPlayback();
        if (this.parseTimer !== undefined) clearTimeout(this.parseTimer);
        this.node.removePropertyChanged(this.onNodeChanged);
        this.detachPicking();
        this.backplot.dispose();
        this.editor?.dispose();
    }

    /** Resolves once the editor is up (tests and the element host wait for it). */
    get ready(): Promise<void> {
        return this.editorReady;
    }

    get dirty(): boolean {
        return this.draft !== this.saved;
    }

    get text(): string {
        return this.draft;
    }

    // ------------------------------------------------------------------ Editor

    private async mountEditor(): Promise<void> {
        const create = this.options.createEditor ?? loadEditor;
        try {
            const host = div({});
            host.style.cssText = "position:absolute;inset:0;";
            const editor = await create(host, this.draft, {
                changed: () => this.onEditorChanged(),
                cursorLine: (line) => this.selectLine(line, false),
                save: () => this.save(),
            });
            if (this.disposed) {
                editor.dispose();
                return;
            }
            this.editor = editor;
            this.editorHost.replaceChildren(host);
            if (this.program !== undefined) editor.setDiagnostics(this.program.diagnostics);
        } catch (error) {
            Logger.error("NC Program: the editor failed to load", error);
            this.editorHost.replaceChildren(div({ className: style.loading, textContent: String(error) }));
        }
    }

    private onEditorChanged(): void {
        if (this.editor === undefined) return;
        this.draft = this.editor.text();
        this.updateHeader();
        this.scheduleReparse();
    }

    /** Replaces the draft (as typing would): the program is re-read after the parse delay. */
    setDraft(text: string): void {
        this.draft = text;
        this.editor?.setText(text);
        this.updateHeader();
        this.scheduleReparse();
    }

    /** Writes the draft into the node: one undo step. */
    save(): void {
        if (!this.dirty) return;
        const text = this.draft;
        Transaction.execute(this.document, "edit NC program", () => {
            this.node.source = text;
        });
        this.saved = text;
        this.updateHeader();
    }

    private readonly onNodeChanged = (property: string) => {
        if (this.disposed) return;
        if (property === "source") {
            const source = this.node.source;
            if (source === this.saved) return;
            // Undo, redo, a restored version: show it — unless there are edits of our own.
            const hadEdits = this.dirty;
            this.saved = source;
            if (!hadEdits) {
                this.draft = source;
                this.editor?.setText(source);
                this.reparse();
            }
            this.updateHeader();
            return;
        }
        if (property === "dialect" || property === "machineId") {
            this.renderSettings();
            this.reparse();
            return;
        }
        if (property === "name") this.updateHeader();
    };

    private updateHeader(): void {
        this.title.textContent = this.node.name;
        this.dirtyMark.textContent = this.dirty ? "●" : "";
        this.saveButton.disabled = !this.dirty;
    }

    // ------------------------------------------------------------------ Reading

    private scheduleReparse(): void {
        if (this.parseTimer !== undefined) clearTimeout(this.parseTimer);
        const delay = this.options.parseDelay ?? 300;
        this.parseTimer = setTimeout(() => {
            this.parseTimer = undefined;
            this.reparse();
        }, delay);
    }

    /** Runs a pending re-read now. */
    flush(): void {
        if (this.parseTimer === undefined) return;
        clearTimeout(this.parseTimer);
        this.parseTimer = undefined;
        this.reparse();
    }

    machine(): MachineProfileData | undefined {
        return this.node.machineId === "" ? undefined : machineProfile(this.node.machineId);
    }

    private reparse(): void {
        if (this.disposed) return;
        try {
            const machine = this.machine();
            this.program = readNcProgram(this.draft, {
                dialect: this.node.dialect,
                ...(machine === undefined ? {} : { machine }),
            });
        } catch (error) {
            Logger.error("NC Program: reading failed", error);
            this.program = undefined;
        }
        this.lineMoves = new Map();
        this.program?.toolpaths.forEach((path, pathIndex) => {
            path.lines.forEach((line, index) => {
                const list = this.lineMoves.get(line);
                if (list === undefined) this.lineMoves.set(line, [{ path: pathIndex, index }]);
                else list.push({ path: pathIndex, index });
            });
        });
        this.highlighted = [];
        this.renderDialectLabel();
        this.renderPanel();
        if (this.program !== undefined) this.editor?.setDiagnostics(this.program.diagnostics);
        this.drawBackplot();
    }

    private drawBackplot(): void {
        if (!this.active || this.disposed) return;
        if (this.program === undefined) {
            this.backplot.clear();
            return;
        }
        this.backplot.show(this.program, this.rapidsBox.checked);
        const position = Number(this.slider.value) / MAX_SLIDER;
        if (position > 0) this.showPlayback(position);
    }

    /** The moves a line produced (empty for comments, modes, …). */
    movesAt(line: number): readonly MoveRef[] {
        return this.lineMoves.get(line) ?? [];
    }

    /**
     * Shows a line's moves: highlighted in the backplot, the tool marker at the end of the
     * last one, the slider there; `fromBackplot` also puts the editor's cursor on the line.
     */
    selectLine(line: number, fromBackplot: boolean): void {
        const moves = this.movesAt(line);
        this.highlighted = [...moves];
        if (this.active) this.backplot.highlight(moves);
        if (fromBackplot) this.editor?.goToLine(line);
        const last = moves.at(-1);
        if (last === undefined) return;
        const position = this.active ? this.backplot.positionOf(last) : undefined;
        if (position === undefined) return;
        this.slider.value = String(Math.round(position * MAX_SLIDER));
        this.showPlayback(position, false);
    }

    get highlightedMoves(): readonly MoveRef[] {
        return this.highlighted;
    }

    // ------------------------------------------------------------------ Playback

    private showPlayback(position: number, followEditor = true): void {
        if (!this.active || this.program === undefined) return;
        const point = this.backplot.setPlayback(position);
        if (point === undefined) {
            this.readout.textContent = "";
            return;
        }
        const path = this.program.toolpaths[point.path];
        const line = path?.lines[point.index];
        const [x, y, z] = point.wcs.map((v) => v.toFixed(3));
        this.readout.textContent = `${line === undefined ? "" : `${t("nc.line")} ${line}  `}T${path?.toolNumber ?? 0}  X${x} Y${y} Z${z}`;
        if (followEditor && line !== undefined) this.editor?.markLine(line);
    }

    private togglePlayback(): void {
        if (this.playTimer !== undefined) {
            this.stopPlayback();
            return;
        }
        if (Number(this.slider.value) >= MAX_SLIDER) this.slider.value = "0";
        this.playTimer = setInterval(() => {
            const next = Math.min(MAX_SLIDER, Number(this.slider.value) + 2);
            this.slider.value = String(next);
            this.showPlayback(next / MAX_SLIDER);
            if (next >= MAX_SLIDER) this.stopPlayback();
        }, 40);
    }

    private stopPlayback(): void {
        if (this.playTimer === undefined) return;
        clearInterval(this.playTimer);
        this.playTimer = undefined;
    }

    // ------------------------------------------------------------------ Picking in the viewport

    private attachPicking(): void {
        this.detachPicking();
        const views: Iterable<IView> = this.document.application?.views ?? [];
        for (const view of views) {
            if (view.document !== this.document || view.dom === undefined) continue;
            const dom = view.dom;
            let down: { x: number; y: number } | undefined;
            const onDown = (event: PointerEvent) => {
                down = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
            };
            const onUp = (event: PointerEvent) => {
                if (down === undefined || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4)
                    return;
                const rect = dom.getBoundingClientRect();
                this.pickAt(view, event.clientX - rect.left, event.clientY - rect.top);
            };
            dom.addEventListener("pointerdown", onDown, true);
            dom.addEventListener("pointerup", onUp, true);
            this.detach.push(() => {
                dom.removeEventListener("pointerdown", onDown, true);
                dom.removeEventListener("pointerup", onUp, true);
            });
        }
    }

    private detachPicking(): void {
        for (const undo of this.detach.splice(0)) undo();
    }

    /** Picks the move nearest a viewport point (pixels in the view) and selects its line. */
    pickAt(view: IView, x: number, y: number): MoveRef | undefined {
        if (this.program === undefined) return undefined;
        const move = this.backplot.pick(view, x, y);
        if (move === undefined) return undefined;
        const line = this.program.toolpaths[move.path]?.lines[move.index];
        if (line !== undefined) this.selectLine(line, true);
        return move;
    }

    // ------------------------------------------------------------------ Settings

    private renderSettings(): void {
        const dialect = this.node.dialect;
        this.dialectSelect.replaceChildren(
            option({ value: "auto", textContent: t("nc.dialect.auto") }),
            ...ncDialects().map((d) => option({ value: d.id, textContent: d.name })),
        );
        this.dialectSelect.value = dialect;
        this.renderDialectLabel();
        const machines = machineProfiles();
        this.machineSelect.replaceChildren(option({ value: "", textContent: t("nc.machine.none") }));
        const groups = new Map<string, HTMLOptGroupElement>();
        for (const machine of machines) {
            let group = groups.get(machine.kind);
            if (group === undefined) {
                group = window.document.createElement("optgroup");
                group.label = t(`cam.kind.${machine.kind}` as I18nKeys);
                groups.set(machine.kind, group);
                this.machineSelect.append(group);
            }
            group.append(option({ value: machine.id, textContent: machine.name }));
        }
        this.machineSelect.value = this.node.machineId;
        const posts = postProcessors();
        this.postSelect.replaceChildren(
            ...posts.map((post) => option({ value: post.id, textContent: post.name })),
        );
        const preferred = this.program === undefined ? undefined : ncDialect(this.program.dialect).posts[0];
        if (preferred !== undefined && posts.some((post) => post.id === preferred))
            this.postSelect.value = preferred;
    }

    /** The "Auto" choice names what was detected. */
    private renderDialectLabel(): void {
        const auto = this.dialectSelect.querySelector<HTMLOptionElement>('option[value="auto"]');
        if (auto === null) return;
        const detected = this.program?.detected ? ncDialect(this.program.dialect).name : undefined;
        auto.textContent =
            detected === undefined ? t("nc.dialect.auto") : t("nc.dialect.detected{0}", detected);
    }

    private setDialect(value: string): void {
        if (value === this.node.dialect) return;
        Transaction.execute(this.document, "NC program dialect", () => {
            this.node.dialect = value as NcDialectId | "auto";
        });
    }

    private setMachine(value: string): void {
        if (value === this.node.machineId) return;
        Transaction.execute(this.document, "NC program machine", () => {
            this.node.machineId = value;
        });
    }

    private renderActions(): void {
        const actions = ncProgramActions();
        this.actionBar.replaceChildren(
            ...actions.map((action) => {
                const element = textButton(t(action.label), () => {
                    if (this.program !== undefined)
                        void action.run({ node: this.node, program: this.program, document: this.document });
                });
                element.dataset["action"] = `nc-${action.id}`;
                return element;
            }),
        );
    }

    // ------------------------------------------------------------------ Re-post and download

    private saveFile(text: string, fileName: string): void {
        if (this.options.download) this.options.download(text, fileName);
        else download([text], fileName);
    }

    private downloadProgram(): void {
        this.saveFile(this.draft, this.node.exportFileName);
    }

    /** Re-posts the program with the chosen post: a new NC Program element, or a download. */
    repost(target: "element" | "download", postId = this.postSelect.value): boolean {
        if (this.program === undefined) return false;
        const result = repostNcProgram(this.program, postId, {
            ...(this.machine() === undefined ? {} : { machine: this.machine()! }),
            name: this.node.name,
        });
        if (!result.isOk) {
            PubSub.default.pub("showToast", "nc.repostFailed{0}", result.error);
            return false;
        }
        const { text, post, machine } = result.value;
        const name = `${this.node.name} (${post.name})`;
        if (target === "download") {
            this.saveFile(text, `${this.node.name}${post.extension}`);
            return true;
        }
        const element = new NcProgramNode({
            document: this.document,
            name: uniqueName(this.document, name),
            source: text,
            fileName: `${name}${post.extension}`,
            dialect: dialectOfPost(post.id) ?? "auto",
            machineId: machine.id,
        });
        Transaction.execute(this.document, "re-post NC program", () => {
            this.document.modelManager.addNode(element);
        });
        openElement(this.document, element);
        return true;
    }

    // ------------------------------------------------------------------ Statistics and problems

    private renderPanel(): void {
        const problems = this.program?.diagnostics ?? [];
        const tabButton = (tab: PanelTab, text: string) => {
            const element = textButton(
                text,
                () => {
                    this.tab = tab;
                    this.renderPanel();
                },
                false,
                `tab-${tab}`,
            );
            element.className = `${style.tab}${this.tab === tab ? ` ${style.activeTab}` : ""}`;
            return element;
        };
        const counted = problems.filter((d) => d.severity !== "info").length;
        this.tabs.replaceChildren(
            tabButton("stats", t("nc.stats")),
            tabButton("problems", counted > 0 ? `${t("nc.problems")} (${counted})` : t("nc.problems")),
        );
        this.panel.replaceChildren(this.tab === "stats" ? this.renderStats() : this.renderProblems());
    }

    private renderStats(): HTMLElement {
        const program = this.program;
        if (program === undefined) return div({ className: style.empty, textContent: t("nc.unreadable") });
        const { stats } = program;
        const rows: [string, string][] = [
            [
                t("nc.dialect"),
                `${ncDialect(program.dialect).name}${program.detected ? ` (${t("nc.detected")})` : ""}`,
            ],
            [t("nc.units"), program.units === "inch" ? t("nc.units.inch") : t("nc.units.mm")],
            [t("nc.lines"), `${program.lineCount}`],
            [t("nc.moves"), `${stats.moves}`],
            [t("nc.cutting"), mm(stats.cuttingLength)],
            [t("nc.rapid"), mm(stats.rapidLength)],
            [
                t("nc.time"),
                `${formatNcDuration(stats.totalTime)}${stats.timeAssumed ? ` (${t("nc.timeAssumed")})` : ""}`,
            ],
            [t("nc.tools"), stats.tools.map((n) => `T${n}`).join(" ") || "—"],
        ];
        if (stats.spindle) rows.push([t("nc.spindle"), `${stats.spindle.min}–${stats.spindle.max} rpm`]);
        if (stats.feed)
            rows.push([
                t("nc.feed"),
                `${Number(stats.feed.min.toFixed(1))}–${Number(stats.feed.max.toFixed(1))} mm/min`,
            ]);
        if (stats.bounds) {
            const { min, max } = stats.bounds;
            const f = (v: number) => Number(v.toFixed(3));
            rows.push([
                t("nc.bounds"),
                `X ${f(min[0])}…${f(max[0])}  Y ${f(min[1])}…${f(max[1])}  Z ${f(min[2])}…${f(max[2])}`,
            ]);
        }
        if (stats.filament !== undefined) rows.push([t("nc.filament"), mm(stats.filament)]);
        if (stats.layers !== undefined) rows.push([t("nc.layers"), `${stats.layers}`]);
        for (const tool of program.tools) rows.push([`T${tool.number}`, tool.description]);
        const grid = div({ className: style.stats });
        grid.dataset["panel"] = "stats";
        for (const [name, value] of rows) {
            grid.append(
                span({ className: style.label, textContent: name }),
                span({ className: style.statValue, textContent: value }),
            );
        }
        return grid;
    }

    private renderProblems(): HTMLElement {
        const problems = this.program?.diagnostics ?? [];
        const list = div({ className: style.problems });
        list.dataset["panel"] = "problems";
        if (problems.length === 0) {
            list.append(div({ className: style.empty, textContent: t("nc.noProblems") }));
            return list;
        }
        for (const problem of problems) {
            const mark = span({ className: style.severity });
            mark.dataset["severity"] = problem.severity;
            const item = div(
                { className: style.problem, title: problem.message },
                mark,
                span({
                    className: style.problemLine,
                    textContent: problem.line > 0 ? `${t("nc.line")} ${problem.line}` : "",
                }),
                span({
                    className: style.problemText,
                    textContent:
                        problem.count > 1 ? `${problem.message} (×${problem.count})` : problem.message,
                }),
            );
            item.dataset["line"] = String(problem.line);
            item.addEventListener("click", () => {
                if (problem.line > 0) this.selectLine(problem.line, true);
            });
            list.append(item);
        }
        return list;
    }
}

function uniqueName(document: IDocument, base: string): string {
    const taken = new Set(document.modelManager.findNodes().map((node) => node.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
        const name = `${base} ${n}`;
        if (!taken.has(name.toLowerCase())) return name;
    }
}
