// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    FUNCTION_CATEGORIES,
    type FunctionDoc,
    functionDoc,
    searchFunctions,
} from "@chili3d/sheet/functionInfo";
import style from "../spreadsheet.module.css";

const ROW_HEIGHT = 28;
const OVERSCAN = 6;
/** List viewport height used before layout (and under happy-dom, which has no layout). */
const FALLBACK_HEIGHT = ROW_HEIGHT * 10;

export interface FunctionBrowserOptions {
    /** The functions to list (the engine's evaluated set). */
    names(): readonly string[];
    /** Enter, double-click or the Insert button. The browser has already closed. */
    insert(name: string): void;
    /** Escape. The browser has already closed. */
    cancel(): void;
    /** A mouse press outside the browser and the ignored element. The browser has already closed. */
    dismiss(): void;
}

let nextId = 0;

/**
 * An "Insert function" popover: search box, category filter, a virtualized list of every
 * function (only the visible rows exist in the DOM) and a detail pane with the signature,
 * argument notes and an example. Keyboard focus stays in the search box; the list follows
 * the combobox pattern (aria-activedescendant).
 */
export function createFunctionBrowser(options: FunctionBrowserOptions) {
    const id = `sheet-function-browser-${++nextId}`;
    const root = document.createElement("div");
    root.className = style.functionBrowser;
    root.id = id;
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Insert function");

    const search = document.createElement("input");
    search.type = "search";
    search.className = style.functionSearch;
    search.placeholder = "Search functions";
    search.spellcheck = false;
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Search functions");
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-autocomplete", "list");
    search.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-controls", `${id}-list`);
    const category = document.createElement("select");
    category.className = style.functionCategory;
    category.setAttribute("aria-label", "Function category");
    const header = document.createElement("div");
    header.className = style.functionBrowserHeader;
    header.append(search, category);

    const list = document.createElement("div");
    list.id = `${id}-list`;
    list.className = style.functionBrowserList;
    list.tabIndex = 0;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Functions");
    const sizer = document.createElement("div");
    sizer.className = style.functionBrowserSizer;
    list.append(sizer);
    const detail = document.createElement("div");
    detail.className = style.functionDetail;
    const body = document.createElement("div");
    body.className = style.functionBrowserBody;
    body.append(list, detail);

    const status = document.createElement("span");
    status.setAttribute("aria-live", "polite");
    const hint = document.createElement("span");
    hint.textContent = "↑ ↓ to browse · Enter to insert · Esc to close";
    const footer = document.createElement("div");
    footer.className = style.functionBrowserFooter;
    footer.append(status, hint);
    root.append(header, body, footer);

    let docs: FunctionDoc[] = [];
    let results: FunctionDoc[] = [];
    let selected = 0;
    let open = false;
    let anchor: HTMLElement | undefined;
    let ignore: HTMLElement | undefined;

    const optionId = (index: number) => `${id}-option-${index}`;
    const viewport = () => list.clientHeight || FALLBACK_HEIGHT;
    const page = () => Math.max(1, Math.floor(viewport() / ROW_HEIGHT) - 1);

    const highlighted = (name: string) => {
        const span = document.createElement("span");
        span.className = style.functionName;
        const q = search.value.trim().toUpperCase();
        const at = q ? name.indexOf(q) : -1;
        if (at < 0) span.textContent = name;
        else {
            const mark = document.createElement("mark");
            mark.textContent = name.slice(at, at + q.length);
            span.append(name.slice(0, at), mark, name.slice(at + q.length));
        }
        return span;
    };
    const option = (index: number) => {
        const doc = results[index];
        const item = document.createElement("div");
        item.id = optionId(index);
        item.className = style.functionOption;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === selected));
        item.setAttribute("aria-setsize", String(results.length));
        item.setAttribute("aria-posinset", String(index + 1));
        item.dataset["index"] = String(index);
        item.style.top = `${index * ROW_HEIGHT}px`;
        const summary = document.createElement("span");
        summary.className = style.functionSummary;
        summary.textContent = doc.description;
        item.append(highlighted(doc.name), summary);
        return item;
    };
    const renderList = () => {
        sizer.style.height = `${results.length * ROW_HEIGHT}px`;
        const top = list.scrollTop;
        const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
        const last = Math.min(results.length, Math.ceil((top + viewport()) / ROW_HEIGHT) + OVERSCAN);
        const indices = Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i);
        // The active descendant must exist even when it has been scrolled out of view.
        if (results.length && (selected < first || selected >= last)) indices.push(selected);
        const items = indices.map(option);
        if (results.length === 0) {
            const empty = document.createElement("div");
            empty.className = style.functionEmpty;
            empty.textContent = search.value.trim()
                ? `No functions match “${search.value.trim()}”.`
                : "No functions in this category.";
            items.push(empty);
        }
        sizer.replaceChildren(...items);
        const active = results.length ? optionId(selected) : "";
        for (const element of [search, list]) {
            if (active) element.setAttribute("aria-activedescendant", active);
            else element.removeAttribute("aria-activedescendant");
        }
    };
    const renderDetail = () => {
        const doc = results[selected];
        detail.replaceChildren();
        if (!doc) return;
        const title = document.createElement("div");
        title.className = style.functionDetailTitle;
        const name = document.createElement("strong");
        name.textContent = doc.name;
        const tag = document.createElement("span");
        tag.className = style.functionTag;
        tag.textContent = doc.category;
        title.append(name, tag);
        const signature = document.createElement("code");
        signature.className = style.functionSignature;
        signature.textContent = `${doc.name}(${doc.signature})`;
        const description = document.createElement("p");
        description.textContent = doc.description;
        detail.append(title, signature, description);
        if (doc.args.length) {
            const args = document.createElement("dl");
            args.className = style.functionArgs;
            for (const arg of doc.args) {
                const term = document.createElement("dt");
                term.textContent = arg.name;
                if (arg.optional || arg.repeating) {
                    const note = document.createElement("small");
                    note.textContent = [arg.optional ? "optional" : "", arg.repeating ? "repeatable" : ""]
                        .filter(Boolean)
                        .join(", ");
                    term.append(" ", note);
                }
                const definition = document.createElement("dd");
                definition.textContent = arg.description || "—";
                args.append(term, definition);
            }
            detail.append(args);
        }
        const exampleLabel = document.createElement("div");
        exampleLabel.className = style.functionExampleLabel;
        exampleLabel.textContent = "Example";
        const example = document.createElement("code");
        example.className = style.functionExample;
        example.textContent = doc.example;
        const insert = document.createElement("button");
        insert.type = "button";
        insert.className = style.functionInsert;
        insert.textContent = `Insert ${doc.name}`;
        insert.addEventListener("mousedown", (e) => e.preventDefault());
        insert.addEventListener("click", () => choose(selected));
        detail.append(exampleLabel, example, insert);
    };
    const renderStatus = () => {
        status.textContent = `${results.length} function${results.length === 1 ? "" : "s"}`;
    };
    const ensureVisible = () => {
        const top = selected * ROW_HEIGHT;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + ROW_HEIGHT > list.scrollTop + viewport())
            list.scrollTop = top + ROW_HEIGHT - viewport();
    };
    const select = (index: number) => {
        if (results.length === 0) return;
        selected = Math.max(0, Math.min(results.length - 1, index));
        ensureVisible();
        const item = sizer.querySelector(`#${optionId(selected)}`);
        if (item) {
            // Update in place so the element under the pointer survives (double-click to insert).
            for (const option of sizer.querySelectorAll("[role=option]"))
                option.setAttribute("aria-selected", String(option === item));
            search.setAttribute("aria-activedescendant", item.id);
            list.setAttribute("aria-activedescendant", item.id);
        } else renderList();
        renderDetail();
    };
    const filter = () => {
        results = searchFunctions(docs, search.value, category.value);
        selected = 0;
        list.scrollTop = 0;
        renderList();
        renderDetail();
        renderStatus();
    };
    const fillCategories = () => {
        const previous = category.value;
        const counts = new Map<string, number>();
        for (const doc of docs) counts.set(doc.category, (counts.get(doc.category) ?? 0) + 1);
        const all = document.createElement("option");
        all.value = "";
        all.textContent = `All functions (${docs.length})`;
        category.replaceChildren(all);
        for (const name of FUNCTION_CATEGORIES) {
            const count = counts.get(name);
            if (!count) continue;
            const item = document.createElement("option");
            item.value = name;
            item.textContent = `${name} (${count})`;
            category.append(item);
        }
        category.value = counts.has(previous) ? previous : "";
    };
    const position = () => {
        if (!open || !anchor) return;
        const box = anchor.getBoundingClientRect();
        const width = Math.min(680, window.innerWidth - 16);
        root.style.width = `${width}px`;
        root.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
        const below = window.innerHeight - box.bottom - 10;
        const above = box.top - 10;
        const placeAbove = below < 260 && above > below;
        const height = Math.max(160, Math.min(400, placeAbove ? above : below));
        root.style.height = `${height}px`;
        root.style.top = `${placeAbove ? Math.max(8, box.top - height - 3) : box.bottom + 3}px`;
    };

    function close(): boolean {
        if (!open) return false;
        open = false;
        root.hidden = true;
        root.remove();
        document.removeEventListener("mousedown", outside, true);
        window.removeEventListener("resize", position);
        return true;
    }
    function choose(index: number): void {
        const doc = results[index];
        if (!doc) return;
        close();
        options.insert(doc.name);
    }
    function outside(event: MouseEvent): void {
        const target = event.target as Node | null;
        if (target && (root.contains(target) || ignore?.contains(target))) return;
        close();
        options.dismiss();
    }

    search.addEventListener("input", filter);
    category.addEventListener("change", () => {
        filter();
        search.focus();
    });
    list.addEventListener("scroll", renderList);
    list.addEventListener("mousedown", (event) => {
        // Keep typing focus in the search box when picking with the mouse; the scrollbar still works.
        if ((event.target as HTMLElement).closest("[role=option]")) event.preventDefault();
    });
    list.addEventListener("click", (event) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>("[role=option]");
        if (item) select(Number(item.dataset["index"]));
    });
    list.addEventListener("dblclick", (event) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>("[role=option]");
        if (item) choose(Number(item.dataset["index"]));
    });
    root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    root.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") return;
        event.stopPropagation();
        if (event.isComposing) return;
        const inSearch = event.target === search;
        const step: Record<string, number> = {
            ArrowDown: 1,
            ArrowUp: -1,
            PageDown: page(),
            PageUp: -page(),
        };
        if (step[event.key] !== undefined) {
            event.preventDefault();
            select(selected + step[event.key]);
        } else if ((event.key === "Home" || event.key === "End") && (!inSearch || event.ctrlKey)) {
            event.preventDefault();
            select(event.key === "Home" ? 0 : results.length - 1);
        } else if (event.key === "Enter" && (event.target === search || event.target === list)) {
            event.preventDefault();
            choose(selected);
        } else if (event.key === "Escape") {
            event.preventDefault();
            close();
            options.cancel();
        } else if (event.key === "Tab") {
            const insert = detail.querySelector("button");
            const stops: HTMLElement[] = insert ? [search, category, list, insert] : [search, category, list];
            const at = stops.indexOf(event.target as HTMLElement);
            if (event.shiftKey ? at <= 0 : at === stops.length - 1) {
                event.preventDefault();
                (event.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
            }
        }
    });

    return {
        element: root,
        isOpen: () => open,
        /**
         * Opens under `anchorElement`; presses inside `ignoreElement` (the formula bar) do not
         * dismiss it. `query` pre-fills the search, e.g. with the function name being typed.
         */
        open(anchorElement: HTMLElement, ignoreElement?: HTMLElement, query = "") {
            anchor = anchorElement;
            ignore = ignoreElement;
            docs = options.names().map(functionDoc);
            fillCategories();
            search.value = query;
            if (!open) {
                open = true;
                document.body.append(root);
                root.hidden = false;
                document.addEventListener("mousedown", outside, true);
                window.addEventListener("resize", position);
            }
            position();
            filter();
            search.focus();
            search.setSelectionRange(query.length, query.length);
        },
        close,
        dispose() {
            close();
        },
    };
}
