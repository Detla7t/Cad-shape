// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommitEntry,
    Config,
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
import { graphCell, graphColumnWidth, laneColor } from "./graphCell";
import { showMergeDialog } from "./mergeDialog";
import { promptFields } from "./prompt";
import style from "./versions.module.css";
import { closeVersionsMenu, showVersionsMenu, type VersionsMenuItem } from "./versionsMenu";

/** Key of the pending-changes row in the expanded set (no commit has this id). */
const PENDING_KEY = "pending";
const PAGE = 150;
/** How often the relative timestamps ("5 min ago") are refreshed. */
const CLOCK_MS = 30_000;

/** What one render needs to know about the document's history, computed once per render. */
interface RenderContext {
    readonly control: DocumentVersionControl;
    readonly lanes: number;
    readonly operations: (commit: ObjectHash) => CommitEntry[];
}

/**
 * Versions & History, modelled on Onshape's panel: the active document's history as a
 * vertical timeline, newest first, one graph lane per branch. Named versions stand out (a
 * diamond marker, a tag, their description); the automatic changes recorded before a named
 * commit fold beneath it as "N changes"; the work not yet named by a commit sits on top.
 *
 * Clicking an entry selects it and shows its details (description, field changes, the main
 * actions); every action is also in the entry's context menu (right-click, the ⋯ button, the
 * ContextMenu key). The list is an ARIA tree: arrow keys move between entries, Right/Left
 * expand and collapse, Enter selects.
 */
export class VersionsPanel extends HTMLElement {
    private document?: IDocument;
    private control?: DocumentVersionControl;
    private unsubscribe?: () => void;
    /** Commits whose folded changes show, operations whose field changes show, PENDING_KEY. */
    private readonly expanded = new Set<string>();
    private readonly selectedChanges = new Map<ObjectHash, Set<string>>();
    /** The entry whose details show (a commit id or PENDING_KEY). */
    private selected?: string;
    /** The entry holding the list's roving tab stop. */
    private focusKey?: string;
    private limit = PAGE;
    private query = "";
    private versionsOnly = false;
    private clock?: ReturnType<typeof setInterval>;
    private readonly branchSelect: HTMLSelectElement;
    private readonly toolbar: HTMLElement;
    private readonly filterButton: HTMLButtonElement;
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
        this.branchSelect.setAttribute("aria-label", I18n.translate("versions.branch"));
        this.filterButton = this.iconButton("icon-tag", "versions.versionsOnly", () => {
            this.versionsOnly = !this.versionsOnly;
            this.filterButton.setAttribute("aria-pressed", String(this.versionsOnly));
            this.render();
        });
        this.filterButton.setAttribute("aria-pressed", "false");
        const search = input({
            className: style.searchInput,
            type: "search",
            placeholder: I18n.translate("versions.search"),
            oninput: (event: Event) => {
                this.query = (event.target as HTMLInputElement).value.trim().toLowerCase();
                this.limit = PAGE;
                this.render();
            },
            onkeydown: (event: KeyboardEvent) => {
                if (event.key === "ArrowDown") {
                    event.preventDefault();
                    this.navItems()[0]?.focus();
                }
            },
        });
        search.setAttribute("aria-label", I18n.translate("versions.search"));
        const createVersion = button(
            {
                className: `${style.button} ${style.primary}`,
                onclick: () => this.createVersion(this.control?.head),
            },
            svg({ icon: "icon-tag" }),
            span({ textContent: I18n.translate("versions.createVersionEllipsis") }),
        );
        this.toolbar = div(
            { className: style.toolbar },
            div(
                { className: style.toolbarRow },
                this.branchSelect,
                button({
                    className: style.button,
                    textContent: I18n.translate("versions.commitEllipsis"),
                    title: I18n.translate("versions.commit"),
                    onclick: () => this.createCommit(),
                }),
                createVersion,
            ),
            div(
                { className: style.toolbarRow },
                div(
                    { className: style.search },
                    svg({ className: style.searchIcon, icon: "icon-search" }),
                    search,
                ),
                this.filterButton,
                this.iconButton("icon-plus", "versions.newBranch", () => this.newBranch(this.control?.head)),
                this.iconButton("icon-share", "versions.mergeFrom", () => this.chooseMergeSource()),
            ),
        );
        this.list.setAttribute("role", "tree");
        this.list.setAttribute("aria-label", I18n.translate("versions.historyList"));
        this.list.addEventListener("keydown", this.handleListKey);
        this.list.addEventListener("focusin", this.handleListFocus);
        const close = button(
            {
                className: style.iconButton,
                title: I18n.translate("versions.close"),
                onclick: () => this.onClose?.(),
            },
            svg({ icon: "icon-times" }),
        );
        close.setAttribute("aria-label", I18n.translate("versions.close"));
        this.setAttribute("role", "region");
        this.setAttribute("aria-label", I18n.translate("versions.title"));
        this.append(
            div(
                { className: style.header },
                div(
                    { className: style.title },
                    svg({ className: style.titleIcon, icon: "icon-history" }),
                    span({ textContent: I18n.translate("versions.title") }),
                ),
                close,
            ),
            this.toolbar,
            this.list,
        );
    }

    connectedCallback(): void {
        PubSub.default.sub("activeViewChanged", this.handleActiveView);
        PubSub.default.sub("documentClosed", this.handleDocumentClosed);
        this.clock = setInterval(() => this.refreshTimes(), CLOCK_MS);
        this.bind(this.app.activeView?.document);
    }

    disconnectedCallback(): void {
        PubSub.default.remove("activeViewChanged", this.handleActiveView);
        PubSub.default.remove("documentClosed", this.handleDocumentClosed);
        clearInterval(this.clock);
        this.clock = undefined;
        closeVersionsMenu();
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
        this.selected = undefined;
        this.focusKey = undefined;
        this.limit = PAGE;
        if (control !== undefined) this.unsubscribe = control.onChanged(() => this.render());
        this.render();
    }

    private iconButton(icon: string, title: I18nKeys, onclick: () => void): HTMLButtonElement {
        const element = button(
            { className: style.iconButton, title: I18n.translate(title), onclick },
            svg({ icon }),
        );
        element.setAttribute("aria-label", I18n.translate(title));
        return element;
    }

    // ------------------------------------------------------------------ Rendering

    render(): void {
        const control = this.control;
        const hadFocus = this.list.contains(window.document.activeElement);
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
        const rows = layoutGraph(
            log,
            branches.map((b) => b.name),
            branches.map((b) => b.head),
        );
        const operationCache = new Map<ObjectHash, CommitEntry[]>();
        const operations = (commit: ObjectHash) => {
            let cached = operationCache.get(commit);
            if (cached === undefined) {
                cached = control.operations(commit);
                operationCache.set(commit, cached);
            }
            return cached;
        };
        const pending = this.pendingOperations(control);
        const grouped = new Set([
            ...log.flatMap((c) => operations(c.id).map((op) => op.id)),
            ...pending.map((op) => op.id),
        ]);
        const versions = control.versions();
        const versionCommits = new Set(versions.map((v) => v.commit));
        const searchText = (commit: CommitEntry) =>
            [
                commit.message,
                commit.author ?? "",
                commit.id,
                ...commit.summary,
                ...versions.filter((v) => v.commit === commit.id).flatMap((v) => [v.name, v.description]),
                ...branches.filter((b) => b.head === commit.id).map((b) => b.name),
            ]
                .join(" ")
                .toLowerCase();
        const matches = (commit: CommitEntry) => searchText(commit).includes(this.query);
        const filtered = rows.filter((r) => {
            if (grouped.has(r.commit.id)) return false;
            if (this.versionsOnly && r.commit.kind !== "version" && !versionCommits.has(r.commit.id))
                return false;
            return this.query === "" || matches(r.commit) || operations(r.commit.id).some(matches);
        });
        const shown = filtered.slice(0, this.limit);
        const context: RenderContext = { control, lanes: Math.max(1, graphWidth(shown)), operations };
        const elements = shown.map((row) => this.renderRow(context, row));
        if (pending.length > 0 && !this.versionsOnly && (this.query === "" || pending.some(matches)))
            elements.unshift(this.renderPending(context, pending));
        if (elements.length === 0) {
            elements.push(div({ className: style.empty, textContent: I18n.translate("versions.noMatches") }));
        }
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
        this.updateTabStop(hadFocus);
    }

    /** `pendingOperations` is new in the version control API — tolerate builds without it. */
    private pendingOperations(control: DocumentVersionControl): CommitEntry[] {
        const query = (control as Partial<Pick<DocumentVersionControl, "pendingOperations">>)
            .pendingOperations;
        return typeof query === "function" ? query.call(control) : [];
    }

    private renderRow(context: RenderContext, row: GraphRow): HTMLElement {
        const { control } = context;
        const commit = row.commit;
        const isHead = commit.id === control.head;
        const operations = context.operations(commit.id);
        const named = control.versions().filter((v) => v.commit === commit.id);
        const isVersion = commit.kind === "version" || named.length > 0;
        const tags = named.filter((v) => !(commit.kind === "version" && v.name === commit.message));
        const description = named.find((v) => v.description !== "")?.description ?? "";
        const selected = this.selected === commit.id;
        const expanded = this.expanded.has(commit.id);
        const branches = control.branches();
        const chips = [
            ...(isHead
                ? [
                      span({
                          className: `${style.chip} ${style.currentChip}`,
                          textContent: I18n.translate("versions.current"),
                      }),
                  ]
                : []),
            ...branches
                .filter((b) => b.head === commit.id)
                .map((b) => {
                    const chip = span({ className: style.chip, textContent: b.name });
                    chip.style.color = laneColor(branches.indexOf(b));
                    return chip;
                }),
            ...tags.map((v) =>
                span({ className: `${style.chip} ${style.versionChip}`, textContent: v.name }),
            ),
        ];
        const title = commit.message;
        const meta = [commit.author ?? I18n.translate("versions.local")];
        if (description === "" && !isVersion) {
            const summary = rowSubtitle(commit);
            if (summary !== "") meta.push(summary);
        }
        const body = div(
            { className: style.rowBody },
            div(
                { className: style.rowTitle },
                ...(isVersion ? [svg({ className: style.versionIcon, icon: "icon-tag" })] : []),
                span({ className: style.message, textContent: title, title }),
                ...chips,
                timeLabel(commit.time),
                this.menuButton(() => this.commitMenu(control, commit)),
            ),
            div({ className: style.meta, textContent: meta.join(" · ") }),
            ...(description === "" ? [] : [div({ className: style.description, textContent: description })]),
            ...(operations.length > 0 ? [this.changesToggle(commit.id, operations.length, expanded)] : []),
            ...(expanded && operations.length > 0 ? [this.operationGroup(control, operations)] : []),
            ...(selected ? [this.renderDetails(control, commit, operations.length > 0)] : []),
        );
        const classes = [style.row];
        if (selected) classes.push(style.selected);
        if (isHead) classes.push(style.head);
        if (isVersion) classes.push(style.version);
        const element = div(
            {
                className: classes.join(" "),
                dataset: { commit: commit.id, nav: commit.id },
                tabIndex: -1,
                onclick: (e: MouseEvent) => {
                    if (isInteractive(e.target, element)) return;
                    this.select(commit.id);
                },
                oncontextmenu: (e: MouseEvent) => {
                    if ((e.target as HTMLElement).closest(`.${style.operation}`)) return;
                    e.preventDefault();
                    this.focusKey = commit.id;
                    showVersionsMenu(this.commitMenu(control, commit), { x: e.clientX, y: e.clientY }, title);
                },
            },
            graphCell(row, context.lanes, commit.kind, isHead, style.graph),
            body,
        );
        treeItem(element, 1, selected, operations.length > 0 ? expanded : undefined, title);
        return element;
    }

    /**
     * The uncommitted work: the operations recorded since the last named commit, folded into
     * one row. They are saved like everything else; Commit names them (and squashes them into
     * one commit by default).
     */
    private renderPending(context: RenderContext, pending: CommitEntry[]): HTMLElement {
        const { control } = context;
        const expanded = this.expanded.has(PENDING_KEY);
        const title = I18n.translate("versions.pending{0}", String(pending.length));
        const graph = div({ className: style.graph });
        graph.style.width = `${graphColumnWidth(context.lanes)}px`;
        const body = div(
            { className: style.rowBody },
            div(
                { className: style.rowTitle },
                span({ className: style.message, textContent: title, title }),
                timeLabel(pending[0].time),
                this.menuButton(() => this.pendingMenu()),
            ),
            div({
                className: style.meta,
                textContent: I18n.translate("versions.unsaved{0}", pending[0].message),
            }),
            div(
                { className: style.pendingActions },
                this.changesToggle(PENDING_KEY, pending.length, expanded),
                button({
                    className: `${style.button} ${style.small}`,
                    textContent: I18n.translate("versions.commitEllipsis"),
                    onclick: () => this.createCommit(),
                }),
            ),
            ...(expanded ? [this.operationGroup(control, pending)] : []),
        );
        const element = div(
            {
                className: `${style.row} ${style.pending}`,
                dataset: { pending: "true", nav: PENDING_KEY },
                tabIndex: -1,
                onclick: (e: MouseEvent) => {
                    if (isInteractive(e.target, element)) return;
                    this.toggle(PENDING_KEY);
                },
                oncontextmenu: (e: MouseEvent) => {
                    if ((e.target as HTMLElement).closest(`.${style.operation}`)) return;
                    e.preventDefault();
                    this.focusKey = PENDING_KEY;
                    showVersionsMenu(this.pendingMenu(), { x: e.clientX, y: e.clientY }, title);
                },
            },
            graph,
            body,
        );
        treeItem(element, 1, false, expanded, title);
        return element;
    }

    /** "▸ N changes": shows or hides the automatic changes folded under a named commit. */
    private changesToggle(key: string, count: number, expanded: boolean): HTMLElement {
        const text =
            count === 1
                ? I18n.translate("versions.oneChange")
                : I18n.translate("versions.changes{0}", String(count));
        const element = button(
            {
                className: style.changesToggle,
                onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    this.toggle(key);
                },
            },
            svg({ className: style.chevron, icon: expanded ? "icon-angle-down" : "icon-angle-right" }),
            span({ textContent: text }),
        );
        element.setAttribute("aria-expanded", String(expanded));
        return element;
    }

    private operationGroup(control: DocumentVersionControl, operations: CommitEntry[]): HTMLElement {
        const group = div(
            { className: style.operations },
            ...operations.map((operation) => this.operationRow(control, operation)),
        );
        group.setAttribute("role", "group");
        return group;
    }

    /** The ⋯ button that opens an entry's context menu under itself. */
    private menuButton(items: () => VersionsMenuItem[]): HTMLElement {
        const element = button(
            {
                className: `${style.iconButton} ${style.rowMenu}`,
                title: I18n.translate("versions.moreActions"),
                tabIndex: -1,
                onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    const item = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-nav]");
                    item?.focus();
                    showVersionsMenu(
                        items(),
                        e.currentTarget as HTMLElement,
                        I18n.translate("versions.moreActions"),
                    );
                },
            },
            svg({ icon: "icon-ellipsis-vertical" }),
        );
        element.setAttribute("aria-label", I18n.translate("versions.moreActions"));
        element.setAttribute("aria-haspopup", "menu");
        return element;
    }

    private renderDetails(
        control: DocumentVersionControl,
        commit: CommitEntry,
        folded: boolean,
    ): HTMLElement {
        const isHead = commit.id === control.head;
        const action = (key: I18nKeys, onclick: () => void, disabled = false) =>
            button({
                className: `${style.button} ${style.small}`,
                textContent: I18n.translate(key),
                onclick,
                disabled,
            });
        return div(
            { className: style.details },
            ...(folded ? [] : [this.changeList(control, commit.id)]),
            div(
                { className: style.actions },
                action("versions.restore", () => this.restore(commit.id), isHead),
                action("versions.compare", () => showDiffView(control, commit.id), isHead),
                action("versions.branchFromHere", () => this.newBranch(commit.id)),
                button(
                    {
                        className: `${style.button} ${style.small}`,
                        title: I18n.translate("versions.moreActions"),
                        onclick: (e: MouseEvent) =>
                            showVersionsMenu(
                                this.commitMenu(control, commit),
                                e.currentTarget as HTMLElement,
                                I18n.translate("versions.moreActions"),
                            ),
                    },
                    svg({ icon: "icon-ellipsis-vertical" }),
                ),
            ),
        );
    }

    // ------------------------------------------------------------------ Context menus

    private commitMenu(control: DocumentVersionControl, commit: CommitEntry): VersionsMenuItem[] {
        const isHead = commit.id === control.head;
        const merged = control.repository.isAncestor(commit.id, control.head);
        const items: VersionsMenuItem[] = [
            {
                label: I18n.translate("versions.compare"),
                icon: "icon-search",
                disabled: isHead,
                onSelect: () => showDiffView(control, commit.id),
            },
            {
                label: I18n.translate("versions.restore"),
                icon: "icon-undo",
                disabled: isHead,
                onSelect: () => this.restore(commit.id),
            },
            {
                label: I18n.translate("versions.createVersionHere"),
                icon: "icon-tag",
                separatorBefore: true,
                onSelect: () => this.createVersion(commit.id),
            },
            {
                label: I18n.translate("versions.branchFromHere"),
                icon: "icon-plus",
                onSelect: () => this.newBranch(commit.id),
            },
            {
                label: I18n.translate("versions.merge"),
                icon: "icon-share",
                disabled: merged,
                onSelect: () => this.idle() && showMergeDialog(control, commit.id),
            },
        ];
        if (typeof (control as Partial<DocumentVersionControl>).squash === "function") {
            items.push({
                label: I18n.translate("versions.squashToHere"),
                icon: "icon-compress-alt",
                disabled: isHead || !merged,
                onSelect: () => this.squashToHere(commit.id),
            });
        }
        items.push({
            label: I18n.translate("versions.copyId"),
            icon: "icon-clone",
            separatorBefore: true,
            onSelect: () => this.copyId(control, commit.id),
        });
        return items;
    }

    private pendingMenu(): VersionsMenuItem[] {
        return [
            {
                label: I18n.translate("versions.commitEllipsis"),
                icon: "icon-check",
                onSelect: () => this.createCommit(),
            },
            {
                label: I18n.translate("versions.createVersionEllipsis"),
                icon: "icon-tag",
                onSelect: () => this.createVersion(this.control?.head),
            },
        ];
    }

    private copyId(control: DocumentVersionControl, commit: ObjectHash): void {
        const label = control.label(commit);
        const text = `${label} ${commit}`;
        const done = () => PubSub.default.pub("showToast", "versions.copied{0}", label);
        const clipboard = globalThis.navigator?.clipboard;
        if (clipboard === undefined) return;
        clipboard
            .writeText(text)
            .then(done, (error: unknown) =>
                PubSub.default.pub("showToast", "versions.error{0}", String(error)),
            );
    }

    // ------------------------------------------------------------------ Selection and keyboard

    private select(key: string): void {
        this.selected = this.selected === key ? undefined : key;
        this.focusKey = key;
        this.render();
    }

    private toggle(key: string): void {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.render();
    }

    private navItems(): HTMLElement[] {
        return [...this.list.querySelectorAll<HTMLElement>("[data-nav]")];
    }

    /** One entry holds the tab stop (the focused one, else the first); focus survives a render. */
    private updateTabStop(restoreFocus: boolean): void {
        const items = this.navItems();
        const target = items.find((item) => item.getAttribute("data-nav") === this.focusKey) ?? items[0];
        for (const item of items) item.tabIndex = item === target ? 0 : -1;
        if (restoreFocus && target !== undefined) target.focus();
    }

    private readonly handleListFocus = (e: FocusEvent) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>("[data-nav]");
        if (item === null || !this.list.contains(item)) return;
        this.focusKey = item.getAttribute("data-nav") ?? undefined;
        for (const other of this.navItems()) other.tabIndex = other === item ? 0 : -1;
    };

    private readonly handleListKey = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        const item = target.closest<HTMLElement>("[data-nav]");
        if (item === null || target.matches("input, textarea, select")) return;
        const key = item.getAttribute("data-nav") ?? "";
        const items = this.navItems();
        const index = items.indexOf(item);
        const expandable = item.getAttribute("aria-expanded");
        const level = item.getAttribute("aria-level");
        const focus = (next: HTMLElement | undefined) => next?.focus();
        switch (e.key) {
            case "ArrowDown":
                focus(items[index + 1]);
                break;
            case "ArrowUp":
                focus(items[index - 1]);
                break;
            case "Home":
                focus(items[0]);
                break;
            case "End":
                focus(items.at(-1));
                break;
            case "ArrowRight":
                if (expandable === "false") this.toggle(key);
                else if (expandable === "true")
                    focus(item.querySelector<HTMLElement>("[data-nav]") ?? undefined);
                break;
            case "ArrowLeft":
                if (expandable === "true") this.toggle(key);
                else if (level === "2")
                    focus(item.parentElement?.closest<HTMLElement>("[data-nav]") ?? undefined);
                break;
            case "Enter":
            case " ":
                if (target !== item) return;
                if (level === "2" || key === PENDING_KEY) this.toggle(key);
                else this.select(key);
                break;
            case "ContextMenu":
            case "F10":
                if (e.key === "F10" && !e.shiftKey) return;
                item.querySelector<HTMLElement>(`.${style.rowMenu}`)?.click();
                break;
            default:
                return;
        }
        e.preventDefault();
        e.stopPropagation();
    };

    private refreshTimes(): void {
        for (const element of this.list.querySelectorAll<HTMLElement>("[data-time]")) {
            element.textContent = relativeTime(Number(element.getAttribute("data-time")));
        }
    }

    // ------------------------------------------------------------------ Actions

    private operationRow(control: DocumentVersionControl, commit: CommitEntry): HTMLElement {
        const expanded = this.expanded.has(commit.id);
        const title = button({
            className: style.operationTitle,
            textContent: commit.message,
            title: commit.message,
            tabIndex: -1,
            onclick: (e: MouseEvent) => {
                e.stopPropagation();
                this.focusKey = commit.id;
                this.toggle(commit.id);
            },
        });
        title.setAttribute("aria-expanded", String(expanded));
        const element = div(
            {
                className: style.operation,
                dataset: { commit: commit.id, nav: commit.id },
                tabIndex: -1,
                oncontextmenu: (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.focusKey = commit.id;
                    showVersionsMenu(
                        this.commitMenu(control, commit),
                        { x: e.clientX, y: e.clientY },
                        commit.message,
                    );
                },
            },
            div(
                { className: style.operationHead },
                title,
                timeLabel(commit.time),
                this.menuButton(() => this.commitMenu(control, commit)),
            ),
            ...(expanded ? [this.changeList(control, commit.id)] : []),
        );
        treeItem(element, 2, false, expanded, commit.message);
        return element;
    }

    private changeList(control: DocumentVersionControl, commit: ObjectHash): HTMLElement {
        const changes = control.changes(commit);
        if (changes.length === 0)
            return div({ className: style.hint, textContent: I18n.translate("versions.noFieldChanges") });
        const selected = this.selectedChanges.get(commit) ?? new Set<string>();
        this.selectedChanges.set(commit, selected);
        const labels = {
            apply: "versions.applySelected",
            revert: "versions.revertSelected",
            rebase: "versions.rebaseWithout",
        } as const;
        const actions = (["apply", "revert", "rebase"] as const).map((mode) =>
            button({
                className: `${style.button} ${style.small}`,
                textContent: I18n.translate(labels[mode]),
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
                className: style.linkButton,
                textContent: I18n.translate("versions.selectAll{0}", String(changes.length)),
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

    /** Squashes every commit after `base` up to the head into one named commit. */
    private squashToHere(base: ObjectHash): void {
        const control = this.control;
        if (control === undefined || !this.idle()) return;
        const count = control
            .log()
            .filter((c) => c.id !== base && control.repository.isAncestor(base, c.id)).length;
        const message = input({
            ariaLabel: "Squash message",
            value: control.headCommit().message,
            spellcheck: false,
        });
        PubSub.default.pub(
            "showDialog",
            "versions.squashToHere",
            div(
                { className: style.form },
                div({
                    className: style.hint,
                    textContent: I18n.translate("versions.squashHint{0}", control.label(base)),
                }),
                label({}, I18n.translate("versions.commitMessage"), message),
            ),
            () => {
                if (!this.idle()) return;
                const result = control.squash(base, message.value);
                if (result.isOk) PubSub.default.pub("showToast", "versions.squashed{0}", String(count));
                else PubSub.default.pub("showToast", "versions.error{0}", result.error);
            },
        );
    }

    private createCommit(): void {
        const control = this.control;
        if (!control || !this.idle()) return;
        const message = input({
            ariaLabel: "Commit message",
            placeholder: I18n.translate("versions.commitPlaceholder"),
        });
        const pending = control.pendingOperations().length;
        const squash = input({ type: "checkbox", checked: true, ariaLabel: "Squash pending changes" });
        PubSub.default.pub(
            "showDialog",
            "versions.title",
            div(
                { className: style.form },
                label({}, I18n.translate("versions.commitMessage"), message),
                ...(pending > 0
                    ? [label({}, squash, I18n.translate("versions.squashPending{0}", String(pending)))]
                    : []),
            ),
            () => {
                if (!this.idle()) return;
                const result = control.createCommit(message.value, { squash: squash.checked });
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

/** Sets the ARIA tree-item state of a history entry. */
function treeItem(
    element: HTMLElement,
    level: number,
    selected: boolean,
    expanded: boolean | undefined,
    label: string,
): void {
    element.setAttribute("role", "treeitem");
    element.setAttribute("aria-level", String(level));
    element.setAttribute("aria-selected", String(selected));
    element.setAttribute("aria-label", label);
    if (expanded !== undefined) element.setAttribute("aria-expanded", String(expanded));
}

/** True when a click lands on a control or in an entry's expanded content, not its header. */
function isInteractive(target: EventTarget | null, row: HTMLElement): boolean {
    const element = target as HTMLElement | null;
    if (element === null) return false;
    const control = element.closest("button, input, label, select, textarea, a");
    if (control !== null && row.contains(control)) return true;
    const nested = element.closest(`.${style.details}, .${style.operations}`);
    return nested !== null && row.contains(nested);
}

/** The muted second line of a microversion or checkpoint: its first change. */
function rowSubtitle(commit: CommitEntry): string {
    const first = commit.summary[0] ?? "";
    return commit.summary.length > 1 ? `${first} (+${commit.summary.length - 1})` : first;
}

function absoluteTime(time: number): string {
    return new Date(time).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: Config.instance.preferences.timeFormat === "12",
    });
}

/** "now", "5 min ago", "3 hr ago", "yesterday", then the date — the absolute time is the title. */
export function relativeTime(time: number, now = Date.now()): string {
    const seconds = Math.round((time - now) / 1000);
    let format: Intl.RelativeTimeFormat;
    try {
        format = new Intl.RelativeTimeFormat(I18n.currentLanguage(), { numeric: "auto", style: "short" });
    } catch {
        format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
    }
    const abs = Math.abs(seconds);
    if (abs < 45) return format.format(0, "second");
    if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
    if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
    if (abs < 7 * 86_400) return format.format(Math.round(seconds / 86_400), "day");
    return new Date(time).toLocaleDateString([], { dateStyle: "medium" });
}

function timeLabel(time: number): HTMLElement {
    const element = span({
        className: style.time,
        textContent: relativeTime(time),
        title: absoluteTime(time),
    });
    element.setAttribute("data-time", String(time));
    return element;
}

customElements.define("chili-versions-panel", VersionsPanel);
