// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FORMULA_FUNCTIONS, WorkbookEvaluator } from "@chili3d/sheet/formula";
import { FUNCTION_INFO } from "@chili3d/sheet/functionInfo";
import {
    addressOf,
    type CellAddress,
    type CellRange,
    columnName,
    parseRange,
    rangeText,
    type SheetData,
    usedSize,
    type WorkbookData,
} from "@chili3d/sheet/model";
import {
    alternateColors,
    BAND_COLORS,
    dropdownValues,
    setValidation,
    sortRange,
} from "@chili3d/sheet/operations";
import {
    quoteSheet,
    renameSheetReferences,
    renameWorkbookSheet,
    resolveRanges,
    validRangeName,
    validSheetName,
} from "@chili3d/sheet/ranges";
import style from "../spreadsheet.module.css";
import { createSheetOverlays, type SheetMenuItem, sheetButton, sheetField } from "./sheetControls";

export interface SheetActionContext {
    read(): { workbook: WorkbookData; index: number; range: CellRange; focus: CellAddress };
    mutate(action: () => void): void;
    select(index: number, range?: CellRange): void;
    save(): Promise<void>;
    undo(): void;
    redo(): void;
    clear(): void;
    clearFormat(): void;
    merge(): void;
    editFormula(text: string, cursor?: number): void;
    /** Opens the function browser for the active cell (Shift+F3). */
    browseFunctions(): void;
    setValue(address: string, value: string): void;
    zoom(value: number): void;
    message(text: string): void;
}

export function createSheetActions(ctx: SheetActionContext) {
    const overlays = createSheetOverlays();
    const sheet = () => {
        const { workbook, index } = ctx.read();
        return workbook.sheets[index];
    };
    const selection = () => rangeText(ctx.read().range);
    const dataRange = () => {
        const { range } = ctx.read();
        if (range.start.row !== range.end.row || range.start.col !== range.end.col) return range;
        const size = usedSize(sheet());
        return {
            start: { row: 0, col: 0 },
            end: { row: Math.max(0, size.rows - 1), col: Math.max(0, size.cols - 1) },
        };
    };
    const selectControl = (label: string, entries: string[]) => {
        const select = document.createElement("select");
        select.setAttribute("aria-label", label);
        for (const value of entries) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            select.append(option);
        }
        return select;
    };
    function renameSheet(index: number) {
        const { workbook } = ctx.read();
        const field = sheetField("Sheet name", workbook.sheets[index].name);
        overlays.dialog(
            "Rename sheet",
            field.element,
            () => {
                const name = field.input.value.trim();
                if (!validSheetName(name)) return "Use 1–31 characters, without / \\ ? * : [ or ].";
                if (
                    workbook.sheets.some((s, i) => i !== index && s.name.toLowerCase() === name.toLowerCase())
                )
                    return "A sheet with this name already exists.";
                ctx.mutate(() => renameWorkbookSheet(workbook, index, name));
                return undefined;
            },
            "Rename",
        );
    }
    function addSheet() {
        const { workbook } = ctx.read();
        let n = workbook.sheets.length + 1;
        while (workbook.sheets.some((s) => s.name.toLowerCase() === `sheet${n}`)) n++;
        ctx.mutate(() => workbook.sheets.push({ name: `Sheet${n}`, cells: {} }));
        ctx.select(workbook.sheets.length - 1);
    }
    function tabMenu(anchor: HTMLElement, index: number) {
        const { workbook } = ctx.read();
        overlays.menu(anchor, [
            { label: "Rename", action: () => renameSheet(index) },
            {
                label: "Duplicate",
                action: () => {
                    const copy = structuredClone(workbook.sheets[index]);
                    const base = copy.name.slice(0, 22);
                    let n = 1;
                    while (workbook.sheets.some((s) => s.name === `${base} copy ${n}`)) n++;
                    const from = copy.name;
                    copy.name = `${base} copy ${n}`;
                    for (const cell of Object.values(copy.cells))
                        if (cell.f) cell.f = renameSheetReferences(cell.f, from, copy.name);
                    for (const rule of Object.values(copy.validations ?? {}))
                        rule.formulae = rule.formulae.map((f: unknown) =>
                            typeof f === "string" ? renameSheetReferences(f, from, copy.name) : f,
                        );
                    ctx.mutate(() => workbook.sheets.splice(index + 1, 0, copy));
                    ctx.select(index + 1);
                },
            },
            { label: "Move left", disabled: index === 0, action: () => moveSheet(index, -1) },
            {
                label: "Move right",
                disabled: index === workbook.sheets.length - 1,
                action: () => moveSheet(index, 1),
            },
            null,
            {
                label: "Delete sheet",
                disabled: workbook.sheets.length === 1,
                action: () => {
                    const body = document.createElement("p");
                    body.textContent = `Delete “${workbook.sheets[index].name}”? Formulas referring to this sheet will show #REF!. You can undo this.`;
                    overlays.dialog(
                        "Delete sheet",
                        body,
                        () => {
                            ctx.mutate(() => workbook.sheets.splice(index, 1));
                            ctx.select(Math.min(index, workbook.sheets.length - 1));
                            return undefined;
                        },
                        "Delete",
                    );
                },
            },
        ]);
    }
    function moveSheet(index: number, direction: number) {
        const { workbook } = ctx.read();
        ctx.mutate(() => {
            const [moving] = workbook.sheets.splice(index, 1);
            workbook.sheets.splice(index + direction, 0, moving);
        });
        ctx.select(index + direction);
    }
    function allSheets(anchor: HTMLElement) {
        const { workbook, index } = ctx.read();
        overlays.menu(
            anchor,
            workbook.sheets.map((s, i) => ({
                label: s.name,
                checked: index === i,
                action: () => ctx.select(i),
            })),
        );
    }
    function namesMenu(anchor: HTMLElement) {
        const { workbook, index } = ctx.read();
        const items: (SheetMenuItem | null)[] = (workbook.names ?? []).map((name) => ({
            label: name.name,
            hint: name.ranges.join(", "),
            action: () => {
                const [ref] = resolveRanges(workbook, name.name, index);
                if (ref) ctx.select(ref.sheet, ref.range);
                else ctx.message("This named range refers to a missing sheet or range.");
            },
        }));
        items.push(null, { label: "Manage named ranges", action: () => namedRanges() });
        overlays.menu(anchor, items);
    }
    function namedRanges(initial?: string) {
        const { workbook, index } = ctx.read();
        const body = document.createElement("div");
        body.className = style.panelBody;
        const name = sheetField("Name", initial ?? "");
        const reference = sheetField("Range", `${quoteSheet(sheet().name)}!${selection()}`);
        const list = document.createElement("div");
        list.className = style.rangeList;
        let editing: string | undefined;
        const remove = sheetButton("Remove named range", "Remove", () => {
            if (!editing) return;
            ctx.mutate(() => {
                workbook.names = workbook.names?.filter((n) => n.name !== editing);
            });
            editing = undefined;
            name.input.value = "";
            renderList();
        });
        function renderList() {
            list.replaceChildren(
                ...(workbook.names ?? []).map((n) =>
                    sheetButton(n.name, `${n.name}   ${n.ranges.join(", ")}`, () => {
                        editing = n.name;
                        name.input.value = n.name;
                        reference.input.value = n.ranges.join(", ");
                        remove.disabled = false;
                    }),
                ),
            );
            remove.disabled = editing === undefined;
        }
        renderList();
        const help = document.createElement("p");
        help.textContent =
            "Use names in formulas, for example =SUM(Expenses), or enter a name in the address box to jump to its cells.";
        body.append(list, name.element, reference.element, help, remove);
        overlays.dialog(
            "Named ranges",
            body,
            () => {
                const value = name.input.value.trim();
                if (!validRangeName(value) || FORMULA_FUNCTIONS.includes(value.toUpperCase()))
                    return "Start with a letter or underscore. Use letters, numbers, underscores or periods, and not a cell address or function name.";
                if (
                    workbook.names?.some(
                        (n) => n.name !== editing && n.name.toLowerCase() === value.toLowerCase(),
                    )
                )
                    return "This name is already in use.";
                const refs = resolveRanges(workbook, reference.input.value, index);
                if (refs.length !== 1) return "Enter one valid range, such as 'Budget'!A2:A20.";
                const ref = refs[0];
                const absolute = (at: CellAddress) => `$${columnName(at.col)}$${at.row + 1}`;
                ctx.mutate(() => {
                    if (editing && editing !== value) {
                        // Names are tokens; string literals and sheet prefixes are never renamed.
                        const replace = (formula: string) =>
                            formula.replace(
                                /"(?:[^"]|"")*"|'(?:[^']|'')*'!|\b[A-Za-z_][\w.]*/g,
                                (token, at: number) =>
                                    token.toLowerCase() === editing!.toLowerCase() &&
                                    formula[at + token.length] !== "!"
                                        ? value
                                        : token,
                            );
                        for (const s of workbook.sheets) {
                            for (const cell of Object.values(s.cells)) if (cell.f) cell.f = replace(cell.f);
                            for (const rule of Object.values(s.validations ?? {}))
                                rule.formulae = rule.formulae.map((f: unknown) =>
                                    typeof f === "string" ? replace(f) : f,
                                );
                        }
                    }
                    workbook.names = [
                        ...(workbook.names ?? []).filter((n) => n.name !== editing),
                        {
                            name: value,
                            ranges: [
                                `${quoteSheet(workbook.sheets[ref.sheet].name)}!${absolute(ref.range.start)}:${absolute(ref.range.end)}`,
                            ],
                        },
                    ];
                });
                return undefined;
            },
            "Save",
        );
    }
    function dropdownDialog() {
        const { workbook, index, range } = ctx.read();
        const body = document.createElement("div");
        body.className = style.panelBody;
        const type = selectControl("Dropdown source", ["List of items", "Range or named range"]);
        const entries = sheetField(
            "Items (one per line)",
            (dropdownValues(workbook, index, range.start.row, range.start.col) ?? []).join("\n"),
            true,
        );
        const source = sheetField("Source range", "");
        source.element.hidden = true;
        type.addEventListener("change", () => {
            source.element.hidden = type.value === "List of items";
            entries.element.hidden = !source.element.hidden;
        });
        const caption = document.createElement("p");
        caption.textContent = `Dropdown for ${selection()}. Blank cells are allowed; other values must be on the list.`;
        body.append(
            caption,
            type,
            entries.element,
            source.element,
            sheetButton("Remove dropdown", "Remove dropdown", () => {
                ctx.mutate(() => setValidation(sheet(), range));
                overlays.close();
            }),
        );
        overlays.dialog("Cell dropdown", body, () => {
            let formula: string;
            if (type.value === "List of items") {
                const values = [
                    ...new Set(
                        entries.input.value
                            .split(/\r?\n/)
                            .map((v) => v.trim())
                            .filter(Boolean),
                    ),
                ];
                if (!values.length) return "Add at least one item.";
                if (values.some((v) => /[,"]/.test(v)) || values.join(",").length > 253)
                    return "For commas, quotes, or long lists, use a source range instead.";
                formula = `"${values.join(",")}"`;
            } else {
                formula = source.input.value.trim().replace(/^=/, "");
                const refs = resolveRanges(workbook, formula, index);
                if (
                    refs.length !== 1 ||
                    (refs[0].range.start.row !== refs[0].range.end.row &&
                        refs[0].range.start.col !== refs[0].range.end.col)
                )
                    return "Choose a single row or column, or its named range.";
            }
            ctx.mutate(() =>
                setValidation(sheet(), range, {
                    type: "list",
                    formulae: [formula],
                    allowBlank: true,
                    showErrorMessage: true,
                    errorStyle: "stop",
                    error: "Choose a value from the dropdown list.",
                }),
            );
            return undefined;
        });
    }
    function cellDropdown(anchor: HTMLElement, row: number, col: number) {
        const { workbook, index } = ctx.read();
        const values = dropdownValues(workbook, index, row, col) ?? [];
        overlays.menu(
            anchor,
            values.length
                ? values.map((value) => ({
                      label: value || "(blank)",
                      action: () => ctx.setValue(addressOf(row, col), value),
                  }))
                : [{ label: "No values in source range", disabled: true, action: () => {} }],
        );
    }
    function bandedRows() {
        const range = dataRange();
        const body = document.createElement("div");
        body.className = style.panelBody;
        body.textContent = `Apply alternating colors to ${rangeText(range)}, with the first row as the header.`;
        const palette = selectControl("Color palette", Object.keys(BAND_COLORS));
        body.append(palette);
        overlays.dialog("Alternating colors", body, () => {
            ctx.mutate(() => alternateColors(sheet(), range, palette.value as keyof typeof BAND_COLORS));
            return undefined;
        });
    }
    function sortDialog() {
        const { workbook, index } = ctx.read();
        const range = dataRange();
        const body = document.createElement("div");
        body.className = style.panelBody;
        const column = selectControl(
            "Sort by column",
            Array.from({ length: range.end.col - range.start.col + 1 }, (_, i) =>
                columnName(range.start.col + i),
            ),
        );
        const direction = selectControl("Sort order", ["A → Z", "Z → A"]);
        const header = document.createElement("input");
        header.type = "checkbox";
        header.checked = true;
        const label = document.createElement("label");
        label.append(header, " Data has a header row");
        body.append(`Sort ${rangeText(range)}`, label, column, direction);
        overlays.dialog(
            "Sort range",
            body,
            () => {
                const sortedRange = {
                    ...range,
                    start: { ...range.start, row: range.start.row + (header.checked ? 1 : 0) },
                };
                if (sortedRange.start.row > sortedRange.end.row) return "Select at least one data row.";
                let ok = false;
                ctx.mutate(() => {
                    ok = sortRange(
                        workbook,
                        index,
                        sortedRange,
                        range.start.col + column.selectedIndex,
                        direction.selectedIndex === 0,
                    );
                });
                return ok ? undefined : "Unmerge the cells in this range before sorting.";
            },
            "Sort",
        );
    }
    // Filter criteria are a view setting; hidden row state and the filter range are written to XLSX.
    let filters = new WeakMap<SheetData, Map<number, Set<string>>>();
    function toggleFilter() {
        ctx.mutate(() => {
            if (sheet().autoFilter) {
                delete sheet().autoFilter;
                sheet().hiddenRows = [];
                filters.delete(sheet());
            } else sheet().autoFilter = rangeText(dataRange());
        });
    }
    function filterMenu(anchor: HTMLElement, col: number) {
        const { workbook, index } = ctx.read();
        const range = parseRange(sheet().autoFilter ?? "");
        if (!range) return;
        const evaluator = new WorkbookEvaluator(workbook);
        const valueAt = (r: number, c: number) => String(evaluator.value(index, addressOf(r, c)) ?? "");
        const values = [
            ...new Set(
                Array.from({ length: range.end.row - range.start.row }, (_, i) =>
                    valueAt(range.start.row + i + 1, col),
                ),
            ),
        ].sort((a, b) => a.localeCompare(b));
        const body = document.createElement("div");
        body.className = style.panelBody;
        const search = sheetField("Search values");
        const list = document.createElement("div");
        list.className = style.filterList;
        const active = filters.get(sheet())?.get(col);
        const choices = values.map((value) => {
            const label = document.createElement("label");
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = !active || active.has(value);
            label.append(input, value || "(blank)");
            list.append(label);
            return { value, input, label };
        });
        search.input.addEventListener("input", () => {
            for (const c of choices)
                c.label.hidden = !c.value.toLowerCase().includes(search.input.value.toLowerCase());
        });
        const controls = document.createElement("div");
        controls.append(
            sheetButton("Select all values", "Select all", () =>
                choices.forEach((c) => {
                    c.input.checked = true;
                }),
            ),
            sheetButton("Clear values", "Clear", () =>
                choices.forEach((c) => {
                    c.input.checked = false;
                }),
            ),
        );
        body.append(search.element, controls, list);
        overlays.dialog(`Filter ${columnName(col)}`, body, () => {
            let criteria = filters.get(sheet());
            if (!criteria) {
                criteria = new Map();
                filters.set(sheet(), criteria);
            }
            criteria.set(col, new Set(choices.filter((c) => c.input.checked).map((c) => c.value)));
            ctx.mutate(() => {
                const hidden = (sheet().hiddenRows ?? []).filter(
                    (r) => r <= range.start.row || r > range.end.row,
                );
                for (let r = range.start.row + 1; r <= range.end.row; r++)
                    if ([...criteria!].some(([c, allowed]) => !allowed.has(valueAt(r, c)))) hidden.push(r);
                sheet().hiddenRows = hidden;
            });
            return undefined;
        });
        void anchor;
    }
    function freeze(rows: number, cols: number) {
        ctx.mutate(() => {
            sheet().frozen = { rows, cols };
        });
    }
    const menuBar = document.createElement("div");
    menuBar.className = style.menuBar;
    menuBar.setAttribute("role", "menubar");
    const menuButton = (name: string, items: () => (SheetMenuItem | null)[]) => {
        const button = sheetButton(name, name, () => overlays.menu(button, items()));
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("role", "menuitem");
        menuBar.append(button);
    };
    menuButton("File", () => [
        {
            label: "Save",
            hint: "Ctrl+S",
            action: () => {
                void ctx.save().catch((e: unknown) => ctx.message(String(e)));
            },
        },
    ]);
    menuButton("Edit", () => [
        { label: "Undo", hint: "Ctrl+Z", action: ctx.undo },
        { label: "Redo", hint: "Ctrl+Shift+Z", action: ctx.redo },
        null,
        { label: "Clear values", hint: "Delete", action: ctx.clear },
        { label: "Find", hint: "Ctrl+F", action: findDialog },
    ]);
    menuButton("View", () => [
        {
            label: "Freeze first row",
            checked: sheet().frozen?.rows === 1,
            action: () => freeze(1, sheet().frozen?.cols ?? 0),
        },
        {
            label: "Freeze first column",
            checked: sheet().frozen?.cols === 1,
            action: () => freeze(sheet().frozen?.rows ?? 0, 1),
        },
        {
            label: "Freeze through selected cell",
            action: () => freeze(ctx.read().focus.row + 1, ctx.read().focus.col + 1),
        },
        { label: "Unfreeze", action: () => freeze(0, 0) },
        null,
        {
            label: "Show all rows and columns",
            action: () =>
                ctx.mutate(() => {
                    sheet().hiddenRows = [];
                    sheet().hiddenCols = [];
                    filters.delete(sheet());
                }),
        },
    ]);
    menuButton("Insert", () => [
        { label: "Sheet", action: addSheet },
        { label: "Dropdown", action: dropdownDialog },
        { label: "Named range", action: () => namedRanges() },
    ]);
    menuButton("Format", () => [
        { label: "Alternating colors", action: bandedRows },
        { label: "Merge / unmerge cells", action: ctx.merge },
        { label: "Clear formatting", action: ctx.clearFormat },
    ]);
    menuButton("Data", () => [
        { label: "Sort range", action: sortDialog },
        { label: sheet().autoFilter ? "Remove filter" : "Create filter", action: toggleFilter },
        { label: "Cell dropdown", action: dropdownDialog },
        { label: "Named ranges", action: () => namedRanges() },
        null,
        {
            label: "Hide selected rows",
            action: () =>
                ctx.mutate(() => {
                    const { range } = ctx.read();
                    sheet().hiddenRows = [
                        ...new Set([
                            ...(sheet().hiddenRows ?? []),
                            ...Array.from(
                                { length: range.end.row - range.start.row + 1 },
                                (_, i) => range.start.row + i,
                            ),
                        ]),
                    ];
                }),
        },
        {
            label: "Hide selected columns",
            action: () =>
                ctx.mutate(() => {
                    const { range } = ctx.read();
                    sheet().hiddenCols = [
                        ...new Set([
                            ...(sheet().hiddenCols ?? []),
                            ...Array.from(
                                { length: range.end.col - range.start.col + 1 },
                                (_, i) => range.start.col + i,
                            ),
                        ]),
                    ];
                }),
        },
    ]);
    menuButton("Help", () => [{ label: "Function reference", action: functionHelp }]);
    function functionHelp() {
        const body = document.createElement("div");
        body.className = style.functionReference;
        for (const name of FORMULA_FUNCTIONS) {
            const row = document.createElement("p");
            const code = document.createElement("strong");
            code.textContent = `${name}(${FUNCTION_INFO[name][0]})`;
            row.append(code, document.createElement("br"), FUNCTION_INFO[name][1]);
            body.append(row);
        }
        overlays.dialog("Supported spreadsheet functions", body, () => undefined, "Close");
    }
    function findDialog() {
        const field = sheetField("Find in this sheet");
        overlays.dialog(
            "Find",
            field.element,
            () => {
                const query = field.input.value.toLowerCase();
                if (!query) return "Enter text to find.";
                const { workbook, index } = ctx.read();
                const evaluator = new WorkbookEvaluator(workbook);
                const match = Object.keys(sheet().cells).find((a) =>
                    String(evaluator.value(index, a) ?? "")
                        .toLowerCase()
                        .includes(query),
                );
                if (!match) return "No matching cells.";
                ctx.select(index, parseRange(match));
                return undefined;
            },
            "Find",
        );
    }
    const leadingTools = document.createElement("div");
    leadingTools.className = style.toolGroup;
    const undo = sheetButton("Undo", "↶", ctx.undo);
    const redo = sheetButton("Redo", "↷", ctx.redo);
    const zoom = selectControl("Zoom", ["50%", "75%", "90%", "100%", "125%", "150%", "200%"]);
    zoom.value = "100%";
    zoom.addEventListener("change", () => ctx.zoom(Number.parseFloat(zoom.value) / 100));
    leadingTools.append(undo, redo, sheetButton("Find", "⌕", findDialog), zoom);
    const trailingTools = document.createElement("div");
    trailingTools.className = style.toolGroup;
    const filter = sheetButton("Create or remove filter", "⏷", toggleFilter);
    const functions = sheetButton("Functions", "Σ", () =>
        overlays.menu(functions, [
            ...["SUM", "AVERAGE", "COUNT", "MAX", "MIN"].map((name) => ({
                label: name,
                action: () => {
                    const { index, range } = ctx.read();
                    const cell = sheet().cells[addressOf(range.start.row, range.start.col)];
                    const empty =
                        range.start.row === range.end.row &&
                        range.start.col === range.end.col &&
                        cell?.v === undefined &&
                        cell?.f === undefined;
                    if (empty) {
                        ctx.editFormula(`=${name}()`, name.length + 2);
                        return;
                    }
                    const source = rangeText(range);
                    let row = range.end.row + 1;
                    while (
                        sheet().cells[addressOf(row, range.start.col)]?.v !== undefined ||
                        sheet().cells[addressOf(row, range.start.col)]?.f !== undefined
                    )
                        row++;
                    const at = { row, col: range.start.col };
                    ctx.select(index, { start: at, end: at });
                    ctx.editFormula(`=${name}(${source})`);
                },
            })),
            null,
            { label: "More functions…", hint: "Shift+F3", action: ctx.browseFunctions },
        ]),
    );
    trailingTools.append(filter, functions);
    return {
        menuBar,
        leadingTools,
        trailingTools,
        namesMenu,
        namedRanges,
        tabMenu,
        renameSheet,
        addSheet,
        allSheets,
        cellDropdown,
        filterMenu,
        findDialog,
        update(canUndo: boolean, canRedo: boolean) {
            undo.disabled = !canUndo;
            redo.disabled = !canRedo;
            filter.setAttribute("aria-pressed", String(!!sheet().autoFilter));
        },
        resetFilters() {
            filters = new WeakMap();
        },
        dispose: overlays.close,
    };
}
