// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    DocumentLibrary,
    type DocumentLibrarySnapshot,
    type DocumentTemplate,
    documentTemplates,
    download,
    type IApplication,
    type IDocument,
    type LibraryDocument,
    PubSub,
    readFilesAsync,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./home.module.css";
import { button, el, homeForm, iconButton } from "./homeControls";
import { showNewDocumentDialog } from "./newDocumentDialog";

type Filter = "owned" | "recent" | "created" | "shared" | "public" | "trash";
const sections: { id: Filter; name: string; icon: string }[] = [
    { id: "owned", name: "Owned by me", icon: "homeOwned" },
    { id: "recent", name: "Recently opened", icon: "homeRecent" },
    { id: "created", name: "Created by me", icon: "homeCreated" },
    { id: "shared", name: "Shared with me", icon: "homeShared" },
    { id: "public", name: "Public", icon: "homePublic" },
    { id: "trash", name: "Trash", icon: "homeTrash" },
];

export class Home extends HTMLElement {
    private readonly library: DocumentLibrary;
    private snapshot: DocumentLibrarySnapshot = { documents: [], folders: [], labels: [] };
    private filter: Filter = "owned";
    private folder?: string;
    private label?: string;
    private selected?: string;
    private sort: "name" | "date" = "date";
    private ascending = false;
    private readonly navigation = el("nav", style.navigation);
    private readonly results = el("div", style.results);
    private readonly search = el("input", style.search);
    private readonly notice = el("div", style.notice);
    private readonly details = el("aside", style.details);
    private readonly create: HTMLButtonElement;
    private menu?: HTMLElement;
    private dialog?: HTMLDialogElement;
    private request = 0;
    private active = false;
    private opening = false;

    constructor(readonly app: IApplication) {
        super();
        this.library = new DocumentLibrary(app.storage);
        this.className = style.root;
        this.setAttribute("aria-label", "Document dashboard");
        this.search.type = "search";
        this.search.placeholder = "Search documents";
        this.search.setAttribute("aria-label", "Search documents");
        this.search.oninput = () => this.renderResults();
        this.notice.setAttribute("role", "status");
        this.notice.hidden = true;
        this.details.hidden = true;
        this.create = button("Create", () => this.toggleCreate(), style.create);
        this.create.append(el("span", style.chevron, "▾"));
        this.create.setAttribute("aria-haspopup", "menu");
        this.create.setAttribute("aria-expanded", "false");
        this.addEventListener("keydown", (event) => event.stopPropagation());
        this.addEventListener("drop", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.length) this.run(() => this.importSelected(files));
        });
    }

    async render() {
        const header = el("header", style.header);
        const brand = el("div", style.brand, "Chili3D");
        header.append(
            brand,
            this.search,
            iconButton("Preferences", "settings", () => PubSub.default.pub("openPreferences")),
        );
        const sidebar = el("aside", style.sidebar);
        const createWrap = el("div", style.createWrap);
        createWrap.append(this.create);
        const bottom = el("div", style.sidebarBottom);
        if (this.app.activeView)
            bottom.append(
                button("Back to document", () => PubSub.default.pub("displayHome", false), style.navItem),
            );
        bottom.append(el("small", "", "Documents on this device"));
        sidebar.append(createWrap, this.navigation, bottom);
        const main = el("main", style.main);
        main.append(this.notice, this.results);
        const rail = el("aside", style.infoRail);
        const info = iconButton("Document information", "homeInfo", () => {
            this.details.hidden = !this.details.hidden;
            info.setAttribute("aria-expanded", String(!this.details.hidden));
            this.renderDetails();
        });
        info.setAttribute("aria-expanded", "false");
        rail.append(info);
        this.replaceChildren(header, sidebar, main, this.details, rail);
        this.app.mainWindow?.appendChild(this);
        await this.refresh();
    }

    connectedCallback() {
        this.active = true;
        PubSub.default.sub("documentSaved", this.documentSaved);
        document.addEventListener("pointerdown", this.dismissMenu);
        document.addEventListener("keydown", this.menuKeydown);
    }
    disconnectedCallback() {
        this.active = false;
        this.request++;
        PubSub.default.remove("documentSaved", this.documentSaved);
        document.removeEventListener("pointerdown", this.dismissMenu);
        document.removeEventListener("keydown", this.menuKeydown);
        this.closeMenu();
        this.dialog?.remove();
    }
    private readonly documentSaved = () => {
        void this.refresh();
    };
    private readonly dismissMenu = (event: PointerEvent) => {
        if (!this.menu?.contains(event.target as Node) && !this.create.contains(event.target as Node))
            this.closeMenu();
    };
    private readonly menuKeydown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && this.menu) {
            this.closeMenu();
            this.create.focus();
        }
    };
    private async refresh() {
        const request = ++this.request;
        try {
            const snapshot = await this.library.list();
            if (request !== this.request) return;
            this.snapshot = snapshot;
            this.renderNavigation();
            this.renderResults();
            this.renderDetails();
        } catch (error) {
            this.message(error instanceof Error ? error.message : String(error));
        }
    }
    private message(text: string, undo?: () => void) {
        this.notice.replaceChildren(el("span", "", text));
        if (undo) this.notice.append(button("Undo", undo, style.textButton));
        this.notice.append(
            iconButton("Dismiss notification", "close", () => {
                this.notice.hidden = true;
            }),
        );
        this.notice.hidden = false;
    }
    private run(work: () => Promise<void>) {
        void work().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (this.active) this.message(message);
            else PubSub.default.pub("showToast", "error.default:{0}", message);
        });
    }
    private choose(filter: Filter, folder?: string, label?: string) {
        this.filter = filter;
        this.folder = folder;
        this.label = label;
        this.selected = undefined;
        this.renderNavigation();
        this.renderResults();
        this.renderDetails();
    }
    private renderNavigation() {
        this.navigation.replaceChildren();
        for (const section of sections) {
            if (section.id === "public") this.navigation.append(this.labelNavigation());
            const control = button(section.name, () => this.choose(section.id), style.navItem, section.icon);
            if (this.filter === section.id && !this.folder && !this.label) {
                control.classList.add(style.active);
                control.setAttribute("aria-current", "page");
            }
            this.navigation.append(control);
        }
    }
    private labelNavigation() {
        const labels = el("details", style.labelNavigation);
        labels.open = !!this.label;
        const summary = el("summary");
        summary.append(createCadIcon("homeLabel"), el("span", "", "Labels"));
        const add = iconButton("Create label", "homeAddLabel", () => this.createLabel());
        add.onclick = (event) => {
            event.preventDefault();
            this.createLabel();
        };
        summary.append(add);
        labels.append(summary);
        for (const label of this.snapshot.labels) {
            const item = button(label.name, () => this.choose("owned", undefined, label.id), style.labelItem);
            const dot = el("i", style.labelDot);
            dot.style.backgroundColor = label.color;
            item.prepend(dot);
            if (this.label === label.id) {
                item.classList.add(style.active);
                item.setAttribute("aria-current", "page");
            }
            labels.append(item);
        }
        if (!this.snapshot.labels.length) labels.append(el("small", style.noLabels, "No labels yet"));
        return labels;
    }
    private visibleDocuments() {
        if (this.filter === "shared" || this.filter === "public") return [];
        const query = this.search.value.trim().toLowerCase();
        return this.snapshot.documents
            .filter((item) => {
                if (!!item.metadata.trashedAt !== (this.filter === "trash")) return false;
                if (this.folder && item.metadata.folderId !== this.folder) return false;
                if (this.label && !item.metadata.labels.includes(this.label)) return false;
                const names = this.snapshot.labels
                    .filter((label) => item.metadata.labels.includes(label.id))
                    .map((label) => label.name);
                return `${item.name} ${names.join(" ")}`.toLowerCase().includes(query);
            })
            .sort(
                (a, b) =>
                    (this.ascending ? 1 : -1) *
                    (this.sort === "name"
                        ? a.name.localeCompare(b.name)
                        : this.dateValue(a) - this.dateValue(b)),
            );
    }
    private dateValue(item: LibraryDocument) {
        return this.filter === "recent"
            ? (item.metadata.lastOpened ?? item.date)
            : this.filter === "trash"
              ? (item.metadata.trashedAt ?? item.date)
              : item.date;
    }
    private renderResults() {
        this.results.replaceChildren();
        const section = sections.find((item) => item.id === this.filter)!;
        const title =
            this.snapshot.folders.find((item) => item.id === this.folder)?.name ??
            this.snapshot.labels.find((item) => item.id === this.label)?.name ??
            section.name;
        const heading = el("div", style.heading);
        heading.append(
            createCadIcon(this.folder ? "folder" : this.label ? "homeLabel" : section.icon),
            el("h1", "", title),
        );
        if (this.folder || this.label)
            heading.append(button("All documents", () => this.choose("owned"), style.textButton));
        this.results.append(heading);
        if (this.filter === "public" && !this.folder && !this.label && this.publicTemplates().length) {
            this.results.append(this.templateTable(this.publicTemplates()));
            return;
        }
        if (this.filter === "owned" && !this.folder && !this.label && !this.search.value.trim())
            this.results.append(this.recentSection(), this.folderSection());
        const items = this.visibleDocuments();
        const toolbar = el("div", style.listToolbar);
        toolbar.append(el("small", "", `${items.length} document${items.length === 1 ? "" : "s"}`));
        if (this.filter !== "trash")
            toolbar.append(
                button("Add", () => this.run(() => this.importFiles()), style.textButton, "homeAdd"),
            );
        this.results.append(toolbar);
        if (!items.length) {
            const empty = el("div", style.empty);
            const remote = this.filter === "shared" || this.filter === "public";
            empty.append(
                createCadIcon(this.filter === "trash" ? "homeTrash" : "homeCreated"),
                el(
                    "h2",
                    "",
                    this.search.value
                        ? "No matching documents"
                        : this.filter === "trash"
                          ? "Trash is empty"
                          : remote
                            ? `No ${this.filter} documents`
                            : "No documents here yet",
                ),
            );
            empty.append(
                el(
                    "p",
                    "",
                    remote
                        ? "Your documents are stored on this device. Import a shared file or a file from a public URL to work on it here."
                        : this.filter === "trash"
                          ? "Documents sent to Trash can be restored here."
                          : "Create a document or import a file to get started.",
                ),
            );
            if (this.filter !== "trash")
                empty.append(
                    button(
                        remote ? "Open shared file…" : "Create document…",
                        () => (remote ? this.run(() => this.importFiles()) : this.createDocument()),
                        style.primary,
                    ),
                );
            if (remote) empty.append(button("Import from URL…", () => this.importURL(), style.textButton));
            this.results.append(empty);
            return;
        }
        const table = el("table", style.table);
        table.setAttribute("aria-label", "Documents");
        const head = el("thead");
        const titles = el("tr");
        for (const [text, key] of [
            ["Name", "name"],
            [
                this.filter === "recent" ? "Last opened" : this.filter === "trash" ? "Trashed" : "Modified",
                "date",
            ],
            ["Modified by", ""],
            ["Owned by", ""],
            ["", ""],
        ] as const) {
            const cell = el("th");
            cell.scope = "col";
            if (key) {
                cell.append(
                    button(
                        text,
                        () => {
                            this.ascending = this.sort === key ? !this.ascending : key === "name";
                            this.sort = key;
                            this.renderResults();
                        },
                        style.sortButton,
                    ),
                );
                cell.setAttribute(
                    "aria-sort",
                    this.sort === key ? (this.ascending ? "ascending" : "descending") : "none",
                );
            } else cell.textContent = text;
            if (!text) cell.setAttribute("aria-label", "Document actions");
            titles.append(cell);
        }
        head.append(titles);
        const body = el("tbody");
        body.append(...items.map((item) => this.documentRow(item)));
        table.append(head, body);
        this.results.append(table);
    }

    /** Published templates (`registerDocumentTemplate`) matching the search box. */
    private publicTemplates(): DocumentTemplate[] {
        const query = this.search.value.trim().toLowerCase();
        return documentTemplates().filter((template) =>
            [template.name, template.description, template.owner, ...(template.tags ?? [])]
                .join(" ")
                .toLowerCase()
                .includes(query),
        );
    }
    private templateTable(templates: readonly DocumentTemplate[]) {
        const table = el("table", `${style.table} ${style.templateTable}`);
        table.setAttribute("aria-label", "Public templates");
        const titles = el("tr");
        for (const text of ["Name", "Description", "Owned by", "Visibility", ""]) {
            const cell = el("th", "", text);
            cell.scope = "col";
            if (!text) cell.setAttribute("aria-label", "Template actions");
            titles.append(cell);
        }
        const head = el("thead");
        head.append(titles);
        const body = el("tbody");
        for (const template of templates) {
            const row = el("tr");
            row.tabIndex = 0;
            row.dataset["templateId"] = template.id;
            const open = () => this.run(() => this.openTemplate(template));
            row.ondblclick = open;
            row.onkeydown = (event) => {
                if (event.target === row && event.key === "Enter") open();
            };
            const nameWrap = el("div", style.documentName);
            const thumbnail = el("span", style.thumbnail);
            if (template.thumbnail) {
                const image = el("img");
                image.src = template.thumbnail;
                image.alt = "";
                thumbnail.append(image);
            } else thumbnail.append(createCadIcon("homeCreated"));
            const name = button(template.name, open, style.nameButton);
            name.title = template.name;
            nameWrap.append(thumbnail, name);
            const nameCell = el("td");
            nameCell.append(nameWrap);
            const description = el("td", style.templateDescription, template.description);
            description.title = template.description;
            const actionsCell = el("td");
            actionsCell.append(button("Open copy", open, style.textButton));
            row.append(
                nameCell,
                description,
                el("td", style.owner, template.owner),
                el("td", style.owner, "Public"),
                actionsCell,
            );
            body.append(row);
        }
        table.append(head, body);
        return table;
    }
    /** A new document from `template`, saved into the user's library like an import, then opened. */
    private async openTemplate(template: DocumentTemplate) {
        if (this.opening) return;
        this.opening = true;
        try {
            const created = await template.create(this.app);
            if (!created.isOk) throw new Error(created.error);
            await this.saveImported(created.value);
            PubSub.default.pub("displayHome", false);
        } finally {
            this.opening = false;
        }
    }
    private thumbnail(item: LibraryDocument, className: string) {
        const wrap = el("span", className);
        if (item.image) {
            const image = el("img");
            image.src = item.image;
            image.alt = "";
            image.loading = "lazy";
            image.onerror = () => wrap.replaceChildren(createCadIcon("homeCreated"));
            wrap.append(image);
        } else wrap.append(createCadIcon("homeCreated"));
        return wrap;
    }
    private recentSection() {
        const section = el("details", style.recentSection);
        section.open = true;
        const summary = el("summary");
        summary.append(createCadIcon("homeRecent"), el("span", "", "Last opened by me"));
        section.append(summary);
        const recent = [...this.snapshot.documents]
            .filter((item) => !item.metadata.trashedAt)
            .sort((a, b) => (b.metadata.lastOpened ?? b.date) - (a.metadata.lastOpened ?? a.date))
            .slice(0, 4);
        const cards = el("div", style.recentCards);
        for (const item of recent) {
            const card = button(item.name, () => this.run(() => this.open(item)), style.recentCard);
            card.prepend(this.thumbnail(item, style.recentThumbnail));
            card.title = item.name;
            cards.append(card);
        }
        if (!recent.length) cards.append(el("p", style.muted, "Your recent documents will appear here."));
        section.append(cards);
        return section;
    }
    private folderSection() {
        const section = el("details", style.folderSection);
        const summary = el("summary");
        summary.append(createCadIcon("folder"), el("span", "", "Folders"));
        section.append(summary);
        const folders = el("div", style.folders);
        for (const folder of this.snapshot.folders)
            folders.append(
                button(folder.name, () => this.choose("owned", folder.id), style.folder, "folder"),
            );
        folders.append(button("New folder…", () => this.createFolder(), style.textButton, "homeAdd"));
        section.append(folders);
        return section;
    }
    private selectRow(id: string) {
        this.selected = id;
        for (const row of this.results.querySelectorAll<HTMLElement>("[data-document-id]"))
            row.setAttribute("aria-selected", String(row.dataset["documentId"] === id));
        this.renderDetails();
    }
    private documentRow(item: LibraryDocument) {
        const row = el("tr");
        row.tabIndex = 0;
        row.dataset["documentId"] = item.id;
        row.setAttribute("aria-selected", String(item.id === this.selected));
        row.onclick = () => this.selectRow(item.id);
        row.ondblclick = () => {
            if (!item.metadata.trashedAt) this.run(() => this.open(item));
        };
        row.onkeydown = (event) => {
            if (event.target !== row) return;
            if (event.key === "Enter" && !item.metadata.trashedAt) this.run(() => this.open(item));
            if (event.key === " ") {
                event.preventDefault();
                this.selectRow(item.id);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const next = (
                    event.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling
                ) as HTMLElement | null;
                if (next?.dataset["documentId"]) {
                    this.selectRow(next.dataset["documentId"]);
                    next.focus();
                }
            }
        };
        const nameCell = el("td");
        const nameWrap = el("div", style.documentName);
        const name = button(item.name, () => this.run(() => this.open(item)), style.nameButton);
        name.title = item.name;
        name.onclick = (event) => {
            event.stopPropagation();
            this.run(() => this.open(item));
        };
        name.ondblclick = (event) => event.stopPropagation();
        name.disabled = !!item.metadata.trashedAt;
        const branch = el("span", style.branch);
        branch.append(createCadIcon("homeBranch"), el("span", "", item.branch ?? "Main"));
        nameWrap.append(this.thumbnail(item, style.thumbnail), name, branch);
        for (const label of this.snapshot.labels.filter((label) => item.metadata.labels.includes(label.id))) {
            const dot = el("i", style.labelDot);
            dot.style.backgroundColor = label.color;
            dot.title = label.name;
            nameWrap.append(dot);
        }
        nameCell.append(nameWrap);
        const date = el("td", "", this.formatDate(this.dateValue(item)));
        date.title = new Date(this.dateValue(item)).toLocaleString();
        const actionsCell = el("td");
        const actions = el("div", style.rowActions);
        actions.onclick = (event) => event.stopPropagation();
        actions.ondblclick = (event) => event.stopPropagation();
        if (item.metadata.trashedAt)
            actions.append(iconButton("Restore", "homeRestore", () => this.run(() => this.restore(item))));
        else
            actions.append(
                iconButton("Share", "homeShare", () => this.share(item)),
                iconButton("Send to trash", "homeTrash", () => this.run(() => this.trash(item))),
                iconButton("Label", "homeLabel", () => this.organize(item)),
            );
        actionsCell.append(actions);
        row.append(nameCell, date, el("td", style.owner, "me"), el("td", style.owner, "me"), actionsCell);
        return row;
    }
    private formatDate(value: number) {
        const date = new Date(value);
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        const day =
            date.toDateString() === now.toDateString()
                ? "Today"
                : date.toDateString() === yesterday.toDateString()
                  ? "Yesterday"
                  : date.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
                    });
        return `${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: Config.instance.preferences.timeFormat === "12" })} ${day}`;
    }
    private renderDetails() {
        const item = this.snapshot.documents.find((item) => item.id === this.selected);
        this.details.replaceChildren(el("h2", "", "Document information"));
        if (!item) {
            this.details.append(el("p", style.muted, "Select a document to see its details."));
            return;
        }
        this.details.append(this.thumbnail(item, style.detailThumbnail), el("h3", "", item.name));
        const list = el("dl");
        for (const [name, value] of [
            ["Modified", new Date(item.date).toLocaleString()],
            ["Workspace", item.branch ?? "Main"],
            ["Owned by", "me"],
            [
                "Folder",
                this.snapshot.folders.find((folder) => folder.id === item.metadata.folderId)?.name ??
                    "All documents",
            ],
            [
                "Labels",
                this.snapshot.labels
                    .filter((label) => item.metadata.labels.includes(label.id))
                    .map((label) => label.name)
                    .join(", ") || "None",
            ],
        ])
            list.append(el("dt", "", name), el("dd", "", value));
        this.details.append(list);
    }

    private closeMenu() {
        this.menu?.remove();
        this.menu = undefined;
        this.create.setAttribute("aria-expanded", "false");
    }
    private toggleCreate() {
        if (this.menu) {
            this.closeMenu();
            return;
        }
        const menu = el("div", style.createMenu);
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", "Create");
        const entries: [string, string, () => void][] = [
            ["Document…", "homeCreated", () => this.createDocument()],
            ["Folder…", "folder", () => this.createFolder()],
            ["Import files…", "import", () => this.run(() => this.importFiles())],
            ["Import from URL…", "import", () => this.importURL()],
            ["Label…", "homeLabel", () => this.createLabel()],
        ];
        for (const [index, [name, icon, run]] of entries.entries()) {
            if (index === 2 || index === 4) menu.append(el("hr"));
            const item = button(
                name,
                () => {
                    this.closeMenu();
                    run();
                },
                style.menuItem,
                icon,
            );
            item.setAttribute("role", "menuitem");
            menu.append(item);
        }
        menu.onkeydown = (event) => {
            if (event.key === "Escape") {
                this.closeMenu();
                this.create.focus();
                return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
                event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
        };
        this.menu = menu;
        this.create.parentElement?.append(menu);
        this.create.setAttribute("aria-expanded", "true");
        menu.querySelector("button")?.focus();
    }
    private form(title: string) {
        this.dialog?.remove();
        const form = homeForm(title);
        this.dialog = form.dialog;
        return form;
    }
    private nameForm(title: string, submit: (name: string) => Promise<void>, initial = "") {
        const form = this.form(title);
        const label = el("label", style.field, "Name");
        const input = el("input");
        input.value = initial;
        input.required = true;
        input.maxLength = 160;
        label.append(input);
        form.content.append(label);
        form.action("Create", async () => {
            if (!input.value.trim()) throw new Error("Enter a name.");
            await submit(input.value.trim());
        });
        input.focus();
        input.select();
    }
    private createDocument() {
        this.run(async () => {
            this.dialog?.remove();
            await showNewDocumentDialog(this.app, {
                folderId: this.folder,
                labels: this.label ? [this.label] : [],
            });
        });
    }
    private createFolder() {
        this.nameForm("Create folder", async (name) => {
            const folder = await this.library.createFolder(name);
            await this.refresh();
            this.choose("owned", folder.id);
        });
    }
    private createLabel() {
        this.nameForm("Create label", async (name) => {
            const label = await this.library.createLabel(name);
            await this.refresh();
            this.choose("owned", undefined, label.id);
        });
    }
    private organize(item: LibraryDocument) {
        const form = this.form(`Labels and folder · ${item.name}`);
        const checked = new Set(item.metadata.labels);
        const choices = el("div", style.labelChoices);
        const render = () => {
            choices.replaceChildren();
            for (const label of this.snapshot.labels) {
                const row = el("label", style.checkbox);
                const input = el("input");
                input.type = "checkbox";
                input.checked = checked.has(label.id);
                input.onchange = () => {
                    if (input.checked) checked.add(label.id);
                    else checked.delete(label.id);
                };
                const dot = el("i", style.labelDot);
                dot.style.backgroundColor = label.color;
                row.append(input, dot, el("span", "", label.name));
                choices.append(row);
            }
            if (!this.snapshot.labels.length)
                choices.append(el("p", style.muted, "No labels yet. Create one below."));
        };
        render();
        const newLabel = el("div", style.inlineField);
        const input = el("input");
        input.placeholder = "New label";
        input.setAttribute("aria-label", "New label");
        const add = button(
            "Add label",
            async () => {
                add.disabled = true;
                form.error.textContent = "";
                try {
                    const label = await this.library.createLabel(input.value);
                    checked.add(label.id);
                    input.value = "";
                    await this.refresh();
                    render();
                } catch (error) {
                    form.error.textContent = error instanceof Error ? error.message : String(error);
                } finally {
                    add.disabled = false;
                }
            },
            style.secondary,
        );
        newLabel.append(input, add);
        const field = el("label", style.field, "Folder");
        const folder = el("select");
        const all = el("option", "", "All documents");
        all.value = "";
        folder.append(all);
        for (const entry of this.snapshot.folders) {
            const option = el("option", "", entry.name);
            option.value = entry.id;
            folder.append(option);
        }
        folder.value = item.metadata.folderId ?? "";
        field.append(folder);
        form.content.append(choices, newLabel, field);
        form.action("Apply", async () => {
            await this.library.update(item.id, { labels: [...checked], folderId: folder.value || undefined });
            await this.refresh();
        });
    }
    private async trash(item: LibraryDocument) {
        await this.library.update(item.id, { trashedAt: Date.now() });
        await this.refresh();
        this.message(`${item.name} was sent to Trash.`, () => this.run(() => this.restore(item)));
    }
    private async restore(item: LibraryDocument) {
        await this.library.update(item.id, { trashedAt: undefined });
        await this.refresh();
        this.message(`${item.name} was restored.`);
    }
    private share(item: LibraryDocument) {
        const form = this.form(`Share · ${item.name}`);
        form.content.append(
            el(
                "p",
                "",
                "Share a portable .chili3d copy containing the model, feature history, and attached files. The recipient can import it into Chili3D.",
            ),
        );
        const prepare = async () => {
            if (!this.app.exportDocument) throw new Error("Document export is unavailable.");
            const result = await this.app.exportDocument(item.id);
            if (!result.isOk) throw new Error(result.error);
            return new File(
                [result.value as Uint8Array<ArrayBuffer>],
                `${item.name.replace(/[\\/:*?"<>|]/g, "_")}.chili3d`,
                { type: "application/octet-stream" },
            );
        };
        form.action("Download copy", async () => {
            const file = await prepare();
            download([file], file.name);
        });
        if (navigator.share && navigator.canShare?.({ files: [new File([""], "document.chili3d")] })) {
            let file: File | undefined;
            const share = form.action(
                "Share file…",
                async () => {
                    if (!file) {
                        file = await prepare();
                        share.textContent = "Send file…";
                        return;
                    }
                    try {
                        await navigator.share({ title: item.name, files: [file] });
                        form.dialog.close();
                    } catch (error) {
                        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
                    }
                },
                false,
            );
        }
    }
    private async open(item: LibraryDocument) {
        if (this.opening) return;
        this.opening = true;
        try {
            const view = this.app.views.find((view) => view.document.id === item.id);
            if (view) this.app.activeView = view;
            else if (!(await this.app.openDocument(item.id)))
                throw new Error("The document could not be opened.");
            await this.library.update(item.id, { lastOpened: Date.now() });
            PubSub.default.pub("displayHome", false);
        } finally {
            this.opening = false;
        }
    }
    private async saveImported(document: IDocument) {
        await document.save();
        await this.library.update(document.id, {
            folderId: this.folder,
            labels: this.label ? [this.label] : [],
            lastOpened: Date.now(),
        });
    }
    private async importFiles() {
        const files = await readFilesAsync("", true);
        if (files.isOk && files.value.length) await this.importSelected(Array.from(files.value));
    }
    private async importSelected(files: File[]) {
        const models = files.filter((file) => /\.(chili3d|cd)$/i.test(file.name));
        const imports = files.filter((file) => !models.includes(file));
        for (const file of models) {
            if (!this.app.importDocumentFile) throw new Error("Project import is unavailable.");
            const document = await this.app.importDocumentFile(file);
            await this.saveImported(document);
        }
        if (imports.length) {
            const document = await this.app.newDocument(imports[0].name.replace(/\.[^.]+$/, ""));
            await this.app.dataExchange.import(document, imports);
            this.app.activeView?.cameraController.fitContent();
            await this.saveImported(document);
        }
        PubSub.default.pub("displayHome", false);
    }
    private importURL() {
        const form = this.form("Import from URL");
        form.content.append(el("p", style.muted, "Enter a direct file URL that permits browser downloads."));
        const field = el("label", style.field, "File URL");
        const input = el("input");
        input.type = "url";
        input.required = true;
        input.placeholder = "https://…";
        field.append(input);
        form.content.append(field);
        form.action("Import", async () => {
            const url = new URL(input.value);
            if (!["http:", "https:"].includes(url.protocol))
                throw new Error("Use an HTTP or HTTPS file URL.");
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Download failed (${response.status}).`);
            const name = decodeURIComponent(url.pathname.split("/").pop() || "Imported file");
            await this.importSelected([new File([await response.blob()], name)]);
        });
        input.focus();
    }
}
customElements.define("chili-home", Home);
