// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommitEntry,
    DocumentVersionControl,
    type GraphRow,
    graphWidth,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type IView,
    layoutGraph,
    type ObjectHash,
    PubSub,
} from "@chili3d/core";
import { button, div, input, label, option, select, span, svg } from "@chili3d/element";
import { showChangeDialog } from "./changeDialog";
import { showDiffView } from "./diffView";
import { graphCell, laneColor } from "./graphCell";
import { showMergeDialog } from "./mergeDialog";
import { promptFields } from "./prompt";
import style from "./versions.module.css";

const PAGE = 150;

/**
 * Versions & History: the active document's branches, its version graph (one lane per branch,
 * merge edges, named versions) and the microversion list with change summaries. Selecting an
 * entry offers: create a version, branch from it, restore to it, compare it with the current
 * state, merge it into the current branch.
 */
export class VersionsPanel extends HTMLElement {
    private document?: IDocument;
    private control?: DocumentVersionControl;
    private unsubscribe?: () => void;
    private readonly expanded = new Set<ObjectHash>();
    private readonly selectedChanges = new Map<ObjectHash, Set<string>>();
    private limit = PAGE;
    private query = "";
    private readonly branchSelect: HTMLSelectElement;
    private readonly toolbar: HTMLElement;
    private readonly list = div({ className: style.list });
    onClose?: () => void;

    constructor(readonly app: IApplication) {
        super();
        this.className = style.panel;
        this.branchSelect = select({
            className: style.select,
            title: I18n.translate("versions.branch"),
            onchange: () => this.switchBranch(this.branchSelect.value),
        });
        this.toolbar = div(
            { className: style.toolbar },
            this.branchSelect,
            button({ className: style.button, textContent: "Commit", onclick: () => this.createCommit() }),
            this.toolbarButton("icon-plus", "versions.newBranch", () => this.newBranch(this.control?.head)),
            this.toolbarButton("icon-tag", "versions.createVersion", () =>
                this.createVersion(this.control?.head),
            ),
            this.toolbarButton("icon-share", "versions.mergeFrom", () => this.chooseMergeSource()),
        );
        this.append(
            div(
                { className: style.header },
                div(
                    { className: style.title },
                    svg({ className: style.titleIcon, icon: "icon-history" }),
                    span({ textContent: I18n.translate("versions.title") }),
                ),
                button(
                    { className: style.iconButton, onclick: () => this.onClose?.() },
                    svg({ icon: "icon-times" }),
                ),
            ),
            input({
                className: style.historySearch,
                placeholder: "Search history",
                ariaLabel: "Search history",
                oninput: (event: Event) => {
                    this.query = (event.target as HTMLInputElement).value.toLowerCase();
                    this.render();
                },
            }),
            this.toolbar,
            div({ className: style.columns }, span("Name"), span("Modified")),
            this.list,
        );
    }

    connectedCallback(): void {
        PubSub.default.sub("activeViewChanged", this.handleActiveView);
        PubSub.default.sub("documentClosed", this.handleDocumentClosed);
        this.bind(this.app.activeView?.document);
    }

    disconnectedCallback(): void {
        PubSub.default.remove("activeViewChanged", this.handleActiveView);
        PubSub.default.remove("documentClosed", this.handleDocumentClosed);
        this.bind(undefined);
    }

    private readonly handleActiveView = (view: IView | undefined) => this.bind(view?.document);

    private readonly handleDocumentClosed = (document: IDocument) => {
        if (document === this.document) this.bind(undefined);
    };

    private bind(document: IDocument | undefined): void {
        const control = document === undefined ? undefined : DocumentVersionControl.of(document);
        if (document === this.document && control === this.control) return;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.document = document;
        this.control = control;
        this.expanded.clear();
        this.selectedChanges.clear();
        this.limit = PAGE;
        if (control !== undefined) this.unsubscribe = control.onChanged(() => this.render());
        this.render();
    }

    private toolbarButton(icon: string, title: I18nKeys, onclick: () => void) {
        return button(
            { className: style.button, title: I18n.translate(title), onclick },
            svg({ icon }),
            span({ textContent: I18n.translate(title) }),
        );
    }

    // ------------------------------------------------------------------ Rendering

    render(): void {
        const control = this.control;
        this.toolbar.style.display = control === undefined ? "none" : "";
        if (control === undefined) {
            this.list.replaceChildren(
                div({ className: style.empty, textContent: I18n.translate("versions.noDocument") }),
            );
            return;
        }
        const branches = control.branches();
        this.branchSelect.replaceChildren(
            ...branches.map((b) =>
                option({ value: b.name, textContent: b.name, selected: b.name === control.currentBranch }),
            ),
        );
        const log = control.log();
        const branchNames = branches.map((b) => b.name);
        const rows = layoutGraph(
            log,
            branchNames,
            branches.map((b) => b.head),
        );
        const grouped = new Set(log.flatMap((c) => control.operations(c.id).map((op) => op.id)));
        const matches = (commit: CommitEntry) =>
            [commit.message, commit.author ?? "", commit.id, ...commit.summary]
                .join(" ")
                .toLowerCase()
                .includes(this.query);
        const filtered = rows.filter(
            (r) =>
                !grouped.has(r.commit.id) &&
                (matches(r.commit) || control.operations(r.commit.id).some(matches)),
        );
        const shown = filtered.slice(0, this.limit);
        const lanes = graphWidth(shown);
        const elements = shown.map((row) => this.renderRow(control, row, lanes));
        if (filtered.length > shown.length) {
            elements.push(
                button({
                    className: `${style.button} ${style.more}`,
                    textContent: `${I18n.translate("versions.showMore")} (${filtered.length - shown.length})`,
                    onclick: () => {
                        this.limit += PAGE;
                        this.render();
                    },
                }),
            );
        }
        this.list.replaceChildren(...elements);
    }

    private disclosure(expanded: boolean, title: string) {
        const element = button({ className: style.disclosure, textContent: expanded ? "▾" : "▸" });
        element.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${title}`);
        element.setAttribute("aria-expanded", String(expanded));
        return element;
    }

    private renderRow(control: DocumentVersionControl, row: GraphRow, lanes: number): HTMLElement {
        const commit = row.commit;
        const isHead = commit.id === control.head;
        const selected = this.expanded.has(commit.id);
        const versions = control
            .versions()
            .filter(
                (v) => v.commit === commit.id && !(commit.kind === "version" && v.name === commit.message),
            );
        const heads = control.branches().filter((b) => b.head === commit.id);
        const subtitle = rowSubtitle(control, commit);
        const chips = [
            ...heads.map((b) => {
                const chip = span({ className: style.chip, textContent: b.name });
                chip.style.color = laneColor(control.branches().indexOf(b));
                return chip;
            }),
            ...versions.map((v) =>
                span({ className: `${style.chip} ${style.versionChip}`, textContent: v.name }),
            ),
        ];
        const body = div(
            { className: style.rowBody },
            div(
                { className: style.rowTitle },
                this.disclosure(selected, commitTitle(commit)),
                span({ className: style.message, textContent: commitTitle(commit), title: commit.message }),
                ...chips,
                div(
                    { className: style.modified },
                    span({ textContent: commit.author ?? "Local" }),
                    span({
                        className: style.time,
                        textContent: formatTime(commit.time),
                        title: new Date(commit.time).toLocaleString(),
                    }),
                ),
            ),
            div({
                className: style.summary,
                textContent: control.operations(commit.id).length
                    ? `${selected ? "▾" : "▸"} ${control.operations(commit.id).length} changes`
                    : selected
                      ? "Changes"
                      : `Show changes…${subtitle ? ` · ${subtitle}` : ""}`,
            }),
            ...(selected ? [this.renderDetails(control, commit)] : []),
        );
        const classes = [style.row];
        if (selected) classes.push(style.selected);
        if (isHead) classes.push(style.head);
        return div(
            {
                className: classes.join(" "),
                dataset: { commit: commit.id },
                onclick: (e: MouseEvent) => {
                    if ((e.target as HTMLElement).closest(`.${style.details}`)) return;
                    if (selected) this.expanded.delete(commit.id);
                    else this.expanded.add(commit.id);
                    this.render();
                },
            },
            graphCell(row, lanes, commit.kind, isHead, style.graph),
            body,
        );
    }

    private renderDetails(control: DocumentVersionControl, commit: CommitEntry): HTMLElement {
        const versions = control.versions().filter((v) => v.commit === commit.id && v.description !== "");
        const isHead = commit.id === control.head;
        const merged = control.repository.isAncestor(commit.id, control.head);
        const action = (key: I18nKeys, onclick: () => void, disabled = false) =>
            button({ className: style.button, textContent: I18n.translate(key), onclick, disabled });
        return div(
            { className: style.details },
            ...versions.map((v) => div({ className: style.description, textContent: v.description })),
            ...(control.operations(commit.id).length
                ? control.operations(commit.id).map((operation) => this.operationRow(control, operation))
                : [this.changeList(control, commit.id)]),
            div(
                { className: style.actions },
                action("versions.createVersion", () => this.createVersion(commit.id)),
                action("versions.branchFromHere", () => this.newBranch(commit.id)),
                action("versions.restore", () => this.restore(commit.id), isHead),
                action("versions.compare", () => showDiffView(control, commit.id), isHead),
                action("versions.merge", () => this.idle() && showMergeDialog(control, commit.id), merged),
            ),
        );
    }

    // ------------------------------------------------------------------ Actions

    private operationRow(control: DocumentVersionControl, commit: CommitEntry): HTMLElement {
        const expanded = this.expanded.has(commit.id);
        const title = button({
            className: style.operationTitle,
            textContent: commit.message,
            title: `${commit.message} · ${new Date(commit.time).toLocaleString()}`,
            onclick: () => {
                if (expanded) this.expanded.delete(commit.id);
                else this.expanded.add(commit.id);
                this.render();
            },
        });
        title.setAttribute("aria-expanded", String(expanded));
        return div(
            { className: style.operationRow, dataset: { commit: commit.id } },
            title,
            ...(expanded ? [this.changeList(control, commit.id)] : []),
        );
    }

    private changeList(control: DocumentVersionControl, commit: ObjectHash): HTMLElement {
        const changes = control.changes(commit);
        if (changes.length === 0)
            return div({ className: style.hint, textContent: "No changes in this checkpoint." });
        const selected = this.selectedChanges.get(commit) ?? new Set<string>();
        this.selectedChanges.set(commit, selected);
        const actions = (["apply", "revert", "rebase"] as const).map((mode) =>
            button({
                className: style.button,
                textContent:
                    mode === "apply"
                        ? "Apply selected…"
                        : mode === "revert"
                          ? "Revert selected…"
                          : "Rebase without selected…",
                disabled: selected.size === 0,
                onclick: () =>
                    this.idle() && showChangeDialog(control, commit, [...selected], mode, () => this.idle()),
            }),
        );
        const checkboxes = changes.map((change) =>
            input({
                type: "checkbox",
                checked: selected.has(change.id),
                ariaLabel: change.label,
                onchange: (event: Event) => {
                    if ((event.target as HTMLInputElement).checked) selected.add(change.id);
                    else selected.delete(change.id);
                    for (const action of actions) action.disabled = selected.size === 0;
                },
            }),
        );
        return div(
            { className: style.commitChanges },
            button({
                className: style.button,
                textContent: `Select all ${changes.length} changes`,
                onclick: () => {
                    for (const change of changes) selected.add(change.id);
                    for (const checkbox of checkboxes) checkbox.checked = true;
                    for (const action of actions) action.disabled = false;
                },
            }),
            ...changes.map((change, index) =>
                label(
                    { className: style.commitChange },
                    checkboxes[index],
                    div(
                        span({ textContent: change.label }),
                        div({
                            className: style.changeValues,
                            textContent: `${change.before} → ${change.after}`,
                        }),
                    ),
                ),
            ),
            div({ className: style.actions }, ...actions),
        );
    }

    private createCommit(): void {
        const control = this.control;
        if (!control || !this.idle()) return;
        const message = input({ ariaLabel: "Commit message", placeholder: "Describe this checkpoint" });
        PubSub.default.pub(
            "showDialog",
            "versions.title",
            div({ className: style.form }, label({}, "Commit message", message)),
            () => {
                if (!this.idle()) return;
                const result = control.createCommit(message.value);
                if (!result.isOk) PubSub.default.pub("showToast", "versions.error{0}", result.error);
            },
        );
    }

    /**
     * Checkouts, restores and merges rewrite the document under a running command (a sketch
     * being edited, a pick in progress) — they wait until it is done.
     */
    private idle(): boolean {
        if (this.app.executingCommand === undefined) return true;
        PubSub.default.pub("showToast", "versions.busy");
        return false;
    }

    private switchBranch(name: string): void {
        const control = this.control;
        if (control === undefined || name === control.currentBranch) return;
        if (!this.idle()) {
            this.render();
            return;
        }
        const result = control.switchBranch(name);
        if (result.isOk) PubSub.default.pub("showToast", "versions.branchSwitched{0}", name);
        else PubSub.default.pub("showToast", "versions.error{0}", result.error);
    }

    private newBranch(from: ObjectHash | undefined): void {
        const control = this.control;
        if (control === undefined || from === undefined || !this.idle()) return;
        promptFields(
            "versions.newBranch",
            [{ label: "versions.branchName" }],
            ([name]) => {
                const result = control.createBranch(name, from);
                if (result.isOk)
                    PubSub.default.pub("showToast", "versions.branchCreated{0}", result.value.name);
                else PubSub.default.pub("showToast", "versions.error{0}", result.error);
            },
            I18n.translate("versions.from{0}", control.label(from)),
        );
    }

    private createVersion(commit: ObjectHash | undefined): void {
        const control = this.control;
        if (control === undefined || commit === undefined) return;
        promptFields(
            "versions.createVersion",
            [
                { label: "versions.versionName", value: `V${control.versions().length + 1}` },
                { label: "versions.description", multiline: true },
            ],
            ([name, description]) => {
                const result = control.createVersion(name, description, commit);
                if (result.isOk)
                    PubSub.default.pub("showToast", "versions.versionCreated{0}", result.value.name);
                else PubSub.default.pub("showToast", "versions.error{0}", result.error);
            },
            I18n.translate("versions.from{0}", control.label(commit)),
        );
    }

    private restore(commit: ObjectHash): void {
        const control = this.control;
        if (control === undefined || !this.idle()) return;
        const label = control.label(commit);
        const outcome = control.restore(commit);
        PubSub.default.pub("showToast", "versions.restored{0}", label);
        if (outcome.errors.length > 0) {
            PubSub.default.pub(
                "displayError",
                I18n.translate(
                    "versions.featureErrors{0}",
                    outcome.errors.map((e) => `${e.nodeName} › ${e.feature}: ${e.message}`).join("; "),
                ),
            );
        }
    }

    /** Merge from another branch head or a version, picked from a list. */
    private chooseMergeSource(): void {
        const control = this.control;
        if (control === undefined || !this.idle()) return;
        const sources = [
            ...control
                .branches()
                .filter((b) => b.name !== control.currentBranch)
                .map((b) => ({ label: `${I18n.translate("versions.branch")}: ${b.name}`, commit: b.head })),
            ...control.versions().map((v) => ({
                label: `${I18n.translate("versions.kind.version")}: ${v.name}`,
                commit: v.commit,
            })),
        ].filter((s) => !control.repository.isAncestor(s.commit, control.head));
        if (sources.length === 0) {
            PubSub.default.pub("showToast", "versions.upToDate");
            return;
        }
        promptChoice(sources, (commit) => showMergeDialog(control, commit));
    }
}

function promptChoice(
    sources: { label: string; commit: ObjectHash }[],
    onPick: (commit: ObjectHash) => void,
) {
    const picker = select(
        { className: style.select },
        ...sources.map((s, i) => option({ value: String(i), textContent: s.label })),
    );
    PubSub.default.pub("showDialog", "versions.mergeFrom", div({ className: style.form }, picker), () =>
        onPick(sources[Number(picker.value)].commit),
    );
}

function commitTitle(commit: CommitEntry): string {
    if (commit.kind === "version") return `${I18n.translate("versions.kind.version")} ${commit.message}`;
    return commit.message;
}

/** The muted second line of a row: a version's description, or the first change of the commit. */
function rowSubtitle(control: DocumentVersionControl, commit: CommitEntry): string {
    if (commit.kind === "version") {
        return control.repository.version(commit.message)?.description ?? "";
    }
    const first = commit.summary[0] ?? "";
    return commit.summary.length > 1 ? `${first}  (+${commit.summary.length - 1})` : first;
}

function formatTime(time: number): string {
    const date = new Date(time);
    const now = new Date();
    const elapsed = now.getTime() - time;
    if (elapsed < 60_000) return "now";
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString();
}

customElements.define("chili-versions-panel", VersionsPanel);
