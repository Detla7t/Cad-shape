// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, Localize, Transaction } from "@chili3d/core";
import { div, input, option, select, span } from "@chili3d/element";
import { setDocumentWorkbook } from "../../api";
import { applyCellStyle } from "../../sheet/cellStyle";
import { isFormulaError, WorkbookEvaluator } from "../../sheet/formula";
import {
    addressOf,
    type CellAddress,
    type CellData,
    type CellStyle,
    cellFromInput,
    cellInputText,
    cloneWorkbook,
    columnName,
    normalizeRange,
    parseAddress,
    parseRange,
    rangeText,
    usedSize,
    type WorkbookData,
} from "../../sheet/model";
import { adjustDecimalPlaces, COMMON_NUMBER_FORMATS, formatCellValue } from "../../sheet/numberFormat";
import { dropdownValues, translateFormula, validationAt } from "../../sheet/operations";
import { resolveRanges, validRangeName } from "../../sheet/ranges";
import { isWorkbookFormat, readWorkbook, type WorkbookFormat, writeWorkbook } from "../../sheet/workbookIo";
import style from "../documents.module.css";
import chrome from "../spreadsheet.module.css";
import type { DocumentExport, IDocumentViewer, ViewerContext } from "../viewer";
import { createFormulaAssist } from "./formulaAssist";
import { createSheetActions } from "./sheetActions";
import { sheetButton } from "./sheetControls";
import { createSheetToolbar } from "./sheetToolbar";

/**
 * Spreadsheets (CSV, TSV, XLSX, XLS, ODS) in a grid: sheet tabs, a formula bar, cell
 * editing (type or double-click; Enter, Tab, arrows, Escape), range selection with
 * Shift, Delete to clear, copy/paste as tab-separated text, number formats, resizable
 * columns, formulas evaluated live. Rows are rendered for the visible window only, so
 * large sheets scroll smoothly. Saving writes the file in its own format.
 */

const ROW_HEIGHT = 22;
const DEFAULT_WIDTH = 88;
const HEADER_WIDTH = 48;
const OVERSCAN = 10;
const CELLS_MIME = "application/x-chili3d-cells";
let copiedRange: { token: string; at: CellAddress; cells: (CellData | undefined)[][] } | undefined;
let copyId = 0;

export function createSpreadsheetViewer({ node, document, changed }: ViewerContext): IDocumentViewer {
    const format = node.format as WorkbookFormat;
    let workbook: WorkbookData = { sheets: [{ name: "Sheet1", cells: {} }] };
    let evaluator = new WorkbookEvaluator(workbook);
    let sheetIndex = 0;
    let anchor: CellAddress = { row: 0, col: 0 };
    let focus: CellAddress = { row: 0, col: 0 };
    let dirty = false;
    let loaded = false;
    let editor: HTMLInputElement | undefined;
    let disposeEditorAssist: (() => void) | undefined;
    const assist = createFormulaAssist(() => (workbook.names ?? []).map((n) => n.name));
    type Revision = { book: WorkbookData; index: number };
    const undoStack: Revision[] = [];
    const redoStack: Revision[] = [];
    let checkpoint: Revision = { book: cloneWorkbook(workbook), index: 0 };
    let checkpointText = JSON.stringify(workbook);
    let savedText = checkpointText;
    let rowTops: number[] = [];
    let layoutDirty = true;

    const cellName = input({ className: style.cellName, spellcheck: false });
    const formulaInput = input({ className: style.formulaInput, spellcheck: false });
    const formatMenu = select(
        { className: style.select, title: new Localize("documents.sheet.numberFormat") },
        ...COMMON_NUMBER_FORMATS.map((code) => option({ value: code, textContent: code })),
    );
    cellName.setAttribute("aria-label", "Cell or range");
    formulaInput.setAttribute("aria-label", "Formula bar");
    assist.bind(formulaInput);
    formulaInput.addEventListener("input", changed);
    const toolbar = createSheetToolbar(
        applyStyle,
        clearFormat,
        mergeSelection,
        applyNumberFormat,
        (change) => {
            const cell = sheet().cells[addressOf(focus.row, focus.col)];
            const adjusted = adjustDecimalPlaces(cell?.z ?? "General", change);
            applyNumberFormat(adjusted);
        },
    );
    toolbar.element.append(formatMenu);
    const notice = div({ className: style.notice });
    const table = window.document.createElement("table");
    table.className = style.grid;
    const colgroup = window.document.createElement("colgroup");
    const thead = window.document.createElement("thead");
    const tbody = window.document.createElement("tbody");
    table.append(colgroup, thead, tbody);
    const scroller = div({ className: style.gridScroller, tabIndex: 0 }, table);
    const tabs = div({ className: `${style.sheetTabs} ${chrome.tabs}` });

    const sheet = () => workbook.sheets[sheetIndex];
    const size = () => {
        const used = usedSize(sheet(), true);
        return { rows: Math.max(used.rows + 30, 100), cols: Math.max(used.cols + 6, 26) };
    };
    const widthOf = (col: number) =>
        sheet().hiddenCols?.includes(col) ? 0 : (sheet().cols?.[col] ?? DEFAULT_WIDTH);

    const markDirty = () => {
        const text = JSON.stringify(workbook);
        if (text !== checkpointText) {
            undoStack.push(checkpoint);
            if (undoStack.length > 60) undoStack.shift();
            redoStack.length = 0;
            checkpoint = { book: cloneWorkbook(workbook), index: sheetIndex };
            checkpointText = text;
        }
        dirty = text !== savedText;
        layoutDirty = true;
        evaluator = new WorkbookEvaluator(workbook);
        changed();
        actions.update(undoStack.length > 0, redoStack.length > 0);
    };
    function restoreRevision(redo: boolean): void {
        commitEditor();
        commitFormula();
        const from = redo ? redoStack : undoStack;
        const to = redo ? undoStack : redoStack;
        const revision = from.pop();
        if (!revision) return;
        to.push({ book: cloneWorkbook(workbook), index: sheetIndex });
        workbook = cloneWorkbook(revision.book);
        sheetIndex = Math.min(revision.index, workbook.sheets.length - 1);
        checkpoint = { book: cloneWorkbook(workbook), index: sheetIndex };
        checkpointText = JSON.stringify(workbook);
        dirty = checkpointText !== savedText;
        evaluator = new WorkbookEvaluator(workbook);
        layoutDirty = true;
        actions.resetFilters();
        renderAll();
        changed();
    }

    // ---------------------------------------------------------- rendering

    const renderColumns = () => {
        const { cols } = size();
        colgroup.replaceChildren();
        const header = window.document.createElement("tr");
        const corner = window.document.createElement("th");
        header.append(corner);
        const first = window.document.createElement("col");
        first.style.width = `${HEADER_WIDTH}px`;
        colgroup.append(first);
        for (let c = 0; c < cols; c++) {
            if (widthOf(c) === 0) continue;
            const col = window.document.createElement("col");
            col.style.width = `${widthOf(c)}px`;
            colgroup.append(col);
            const th = window.document.createElement("th");
            th.className = style.columnHeader;
            th.textContent = columnName(c);
            if (c < (sheet().frozen?.cols ?? 0)) {
                th.style.left = `${HEADER_WIDTH + Array.from({ length: c }, (_, i) => widthOf(i)).reduce((a, b) => a + b, 0)}px`;
                th.style.zIndex = "6";
            }
            const resizer = span({ className: style.resizer });
            resizer.addEventListener("mousedown", (e) => startResize(e, c));
            resizer.addEventListener("click", (e) => e.stopPropagation());
            resizer.addEventListener("dblclick", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const context = window.document.createElement("canvas").getContext("2d");
                let width = DEFAULT_WIDTH;
                for (const [address, cell] of Object.entries(sheet().cells)) {
                    const at = parseAddress(address);
                    if (!at || at.col !== c) continue;
                    const fontSize = ((cell.s?.font?.size ?? 11) * 4) / 3;
                    if (context)
                        context.font = `${cell.s?.font?.bold ? "bold " : ""}${fontSize}px ${cell.s?.font?.name ?? "Arial"}`;
                    const text = cellText(at.row, c).text;
                    width = Math.max(
                        width,
                        (context?.measureText(text).width ?? text.length * fontSize * 0.55) + 24,
                    );
                }
                const widths = sheet().cols ?? [];
                while (widths.length <= c) widths.push(null);
                widths[c] = Math.min(600, Math.ceil(width));
                sheet().cols = widths;
                markDirty();
                renderAll();
            });
            th.append(resizer);
            th.addEventListener("click", () =>
                selectRange({ row: 0, col: c }, { row: size().rows - 1, col: c }),
            );
            header.append(th);
        }
        thead.replaceChildren(header);
        table.style.width = `${HEADER_WIDTH + Array.from({ length: cols }, (_, c) => widthOf(c)).reduce((a, b) => a + b, 0)}px`;
    };

    const cellText = (row: number, col: number): { text: string; className: string } => {
        const address = addressOf(row, col);
        const value = evaluator.value(sheetIndex, address);
        if (value === null) return { text: "", className: "" };
        if (isFormulaError(value)) return { text: value.code, className: style.cellError };
        const text = formatCellValue(value, sheet().cells[address]?.z);
        return {
            text,
            className:
                typeof value === "number" ? style.number : typeof value === "boolean" ? style.boolean : "",
        };
    };

    const layoutRows = () => {
        if (!layoutDirty && rowTops.length) return;
        const { rows } = size();
        const heights = Array.from({ length: rows }, (_, r) => sheet().rows?.[r] ?? ROW_HEIGHT);
        for (const [address, cell] of Object.entries(sheet().cells)) {
            const at = parseAddress(address);
            if (!at || sheet().rows?.[at.row] !== undefined) continue;
            const fontHeight = ((cell.s?.font?.size ?? 11) * 4) / 3;
            const lines = cell.s?.alignment?.wrapText
                ? Math.max(
                      1,
                      Math.ceil(
                          (cellText(at.row, at.col).text.length * fontHeight * 0.55) /
                              Math.max(24, widthOf(at.col) - 8),
                      ),
                  )
                : 1;
            heights[at.row] = Math.max(
                heights[at.row] ?? ROW_HEIGHT,
                Math.ceil(fontHeight * 1.35 * lines + 3),
            );
        }
        const hidden = new Set(sheet().hiddenRows ?? []);
        rowTops = [0];
        for (let r = 0; r < heights.length; r++)
            rowTops.push(rowTops[rowTops.length - 1] + (hidden.has(r) ? 0 : heights[r]));
        layoutDirty = false;
    };
    const renderRows = () => {
        const { rows, cols } = size();
        const top = scroller.scrollTop;
        layoutRows();
        let visible = 0;
        while (visible < rows - 1 && rowTops[visible + 1] < top) visible++;
        let first = Math.max(0, visible - OVERSCAN);
        let last = visible;
        while (last < rows - 1 && rowTops[last] < top + scroller.clientHeight) last++;
        last = Math.min(rows - 1, last + OVERSCAN);
        const merges = (sheet().merges ?? []).map((text) => parseRange(text)).filter((r) => r !== undefined);
        // Include the master of a merged cell that spans into the visible window.
        for (const merge of merges)
            if (merge.start.row < first && merge.end.row >= first) first = merge.start.row;
        const range = normalizeRange(anchor, focus);
        const spacer = (height: number) => {
            const tr = window.document.createElement("tr");
            tr.style.height = `${height}px`;
            return tr;
        };
        const fragment = window.document.createDocumentFragment();
        const frozenRows = Math.min(sheet().frozen?.rows ?? 0, rows);
        const renderIndices = [
            ...new Set([
                ...Array.from({ length: frozenRows }, (_, i) => i),
                ...Array.from({ length: last - first + 1 }, (_, i) => first + i),
            ]),
        ].sort((a, b) => a - b);
        let previous = -1;
        const filterRange = parseRange(sheet().autoFilter ?? "");
        for (const r of renderIndices) {
            if (r > previous + 1) fragment.append(spacer(rowTops[r] - rowTops[previous + 1]));
            previous = r;
            if (rowTops[r + 1] === rowTops[r]) continue;
            const tr = window.document.createElement("tr");
            tr.style.height = `${rowTops[r + 1] - rowTops[r]}px`;
            const th = window.document.createElement("th");
            th.textContent = String(r + 1);
            th.addEventListener("click", () =>
                selectRange({ row: r, col: 0 }, { row: r, col: size().cols - 1 }),
            );
            if (r < frozenRows) {
                th.style.top = `${ROW_HEIGHT + rowTops[r]}px`;
                th.style.zIndex = "5";
            }
            tr.append(th);
            for (let c = 0; c < cols; c++) {
                if (widthOf(c) === 0) continue;
                const merge = merges.find(
                    (m) => r >= m.start.row && r <= m.end.row && c >= m.start.col && c <= m.end.col,
                );
                const mergeRows = merge
                    ? Array.from(
                          { length: merge.end.row - merge.start.row + 1 },
                          (_, i) => merge.start.row + i,
                      ).filter((i) => rowTops[i + 1] !== rowTops[i])
                    : [];
                const mergeCols = merge
                    ? Array.from(
                          { length: merge.end.col - merge.start.col + 1 },
                          (_, i) => merge.start.col + i,
                      ).filter((i) => widthOf(i) > 0)
                    : [];
                if (merge && (r !== mergeRows[0] || c !== mergeCols[0])) continue;
                const cellRow = merge?.start.row ?? r;
                const cellCol = merge?.start.col ?? c;
                const td = window.document.createElement("td");
                const { text, className } = cellText(cellRow, cellCol);
                td.textContent = text;
                if (merge) {
                    td.rowSpan = mergeRows.length;
                    td.colSpan = mergeCols.length;
                }
                applyCellStyle(td, sheet().cells[addressOf(cellRow, cellCol)]?.s);
                td.title = text.length > 12 ? text : "";
                const inRange =
                    r >= range.start.row && r <= range.end.row && c >= range.start.col && c <= range.end.col;
                const isFocus = cellRow === focus.row && cellCol === focus.col;
                td.className = [className, isFocus ? style.selected : inRange ? style.inRange : ""]
                    .join(" ")
                    .trim();
                if (r < frozenRows || c < (sheet().frozen?.cols ?? 0)) {
                    td.style.position = "sticky";
                    td.style.zIndex = r < frozenRows && c < (sheet().frozen?.cols ?? 0) ? "4" : "3";
                    if (!td.style.backgroundColor) td.style.backgroundColor = "white";
                    if (r < frozenRows) td.style.top = `${ROW_HEIGHT + rowTops[r]}px`;
                    if (c < (sheet().frozen?.cols ?? 0))
                        td.style.left = `${HEADER_WIDTH + Array.from({ length: c }, (_, i) => widthOf(i)).reduce((a, b) => a + b, 0)}px`;
                }
                if (className === style.cellError) {
                    td.dataset["error"] = text;
                    td.title = `${addressOf(r, c)}: ${text} — ${cellInputText(sheet().cells[addressOf(r, c)])}`;
                }
                const isFilter =
                    filterRange &&
                    r === filterRange.start.row &&
                    c >= filterRange.start.col &&
                    c <= filterRange.end.col;
                if (isFilter || validationAt(sheet(), r, c)?.type === "list") {
                    const dropdown = sheetButton(
                        isFilter ? `Filter ${columnName(c)}` : `Dropdown ${addressOf(r, c)}`,
                        "▾",
                        () => {
                            if (isFilter) actions.filterMenu(dropdown, c);
                            else actions.cellDropdown(dropdown, r, c);
                        },
                    );
                    dropdown.className = chrome.cellDropdown;
                    dropdown.addEventListener("mousedown", (e) => e.stopPropagation());
                    dropdown.addEventListener("dblclick", (e) => e.stopPropagation());
                    td.style.paddingRight = "20px";
                    td.append(dropdown);
                }
                td.dataset["row"] = String(cellRow);
                td.dataset["col"] = String(cellCol);
                tr.append(td);
            }
            fragment.append(tr);
        }
        if (previous < rows - 1) fragment.append(spacer(rowTops[rows] - rowTops[previous + 1]));
        tbody.replaceChildren(fragment);
    };

    const renderTabs = () => {
        const add = sheetButton("Add sheet", "+", () => actions.addSheet());
        const all = sheetButton("All sheets", "☰", () => actions.allSheets(all));
        tabs.replaceChildren(add, all);
        for (const [index, s] of workbook.sheets.entries()) {
            const tab = div({
                className: `${style.sheetTab} ${index === sheetIndex ? style.sheetActive : ""}`,
            });
            const name = sheetButton(s.name, s.name, () => switchSheet(index));
            name.setAttribute("role", "tab");
            name.setAttribute("aria-selected", String(index === sheetIndex));
            name.addEventListener("dblclick", () => actions.renameSheet(index));
            const menu = sheetButton(`Sheet options: ${s.name}`, "▾", () => actions.tabMenu(menu, index));
            tab.append(name, menu);
            tabs.append(tab);
        }
    };
    function switchSheet(index: number, range?: { start: CellAddress; end: CellAddress }): void {
        commitEditor();
        commitFormula();
        sheetIndex = index;
        layoutDirty = true;
        anchor = range?.start ?? { row: 0, col: 0 };
        focus = range?.end ?? anchor;
        scroller.scrollTop = scroller.scrollLeft = 0;
        renderAll();
        scrollIntoView(focus);
    }

    const renderFormulaBar = () => {
        const address = addressOf(focus.row, focus.col);
        const range = normalizeRange(anchor, focus);
        cellName.value =
            range.start.row === range.end.row && range.start.col === range.end.col
                ? address
                : `${addressOf(range.start.row, range.start.col)}:${addressOf(range.end.row, range.end.col)}`;
        const cell = sheet().cells[address];
        formulaInput.value = cellInputText(cell);
        toolbar.update(cell?.s);
        formatMenu.value = cell?.z ?? "General";
        if (formatMenu.value !== (cell?.z ?? "General")) {
            formatMenu.append(option({ value: cell?.z ?? "", textContent: cell?.z ?? "" }));
            formatMenu.value = cell?.z ?? "";
        }
    };

    const renderNotice = () => {
        const messages: string[] = [];
        if (format === "csv" || format === "tsv") {
            messages.push(I18n.translate("documents.sheet.csvNotice"));
            if (workbook.sheets.length > 1) messages.push(I18n.translate("documents.sheet.firstSheetOnly"));
        }
        notice.textContent = messages.join(" ");
        notice.style.display = messages.length === 0 ? "none" : "";
    };

    const renderAll = () => {
        renderColumns();
        renderRows();
        renderTabs();
        renderFormulaBar();
        renderNotice();
        actions.update(undoStack.length > 0, redoStack.length > 0);
    };

    // ---------------------------------------------------------- selection and editing

    const scrollIntoView = (at: CellAddress) => {
        layoutRows();
        const top = rowTops[at.row] ?? at.row * ROW_HEIGHT;
        const headerHeight = ROW_HEIGHT;
        if (top < scroller.scrollTop) scroller.scrollTop = top;
        else if (top + ROW_HEIGHT * 2 + headerHeight > scroller.scrollTop + scroller.clientHeight) {
            scroller.scrollTop = top + ROW_HEIGHT * 2 + headerHeight - scroller.clientHeight;
        }
        let left = HEADER_WIDTH;
        for (let c = 0; c < at.col; c++) left += widthOf(c);
        if (left - HEADER_WIDTH < scroller.scrollLeft) scroller.scrollLeft = left - HEADER_WIDTH;
        else if (left + widthOf(at.col) > scroller.scrollLeft + scroller.clientWidth) {
            scroller.scrollLeft = left + widthOf(at.col) - scroller.clientWidth;
        }
    };

    function selectRange(from: CellAddress, to: CellAddress = from): void {
        commitEditor();
        if (window.document.activeElement === formulaInput) commitFormula();
        assist.hide();
        anchor = from;
        focus = to;
        scrollIntoView(to);
        if (!tbody.querySelector(`td[data-row="${to.row}"][data-col="${to.col}"]`)) renderRows();
        else {
            // Keep cell DOM stable throughout a click/double-click/drag gesture.
            const range = normalizeRange(anchor, focus);
            for (const td of tbody.querySelectorAll<HTMLTableCellElement>("td[data-row]")) {
                const row = Number(td.dataset["row"]),
                    col = Number(td.dataset["col"]);
                const selected = row === focus.row && col === focus.col;
                td.classList.toggle(style.selected, selected);
                td.classList.toggle(
                    style.inRange,
                    !selected &&
                        row >= range.start.row &&
                        row <= range.end.row &&
                        col >= range.start.col &&
                        col <= range.end.col,
                );
            }
        }
        renderFormulaBar();
    }

    const setCell = (address: string, text: string) => {
        const at = parseAddress(address);
        if (at && text !== "" && !text.startsWith("=")) {
            const rule = validationAt(sheet(), at.row, at.col);
            const values = dropdownValues(workbook, sheetIndex, at.row, at.col);
            if (
                values &&
                rule?.showErrorMessage &&
                rule.errorStyle !== "warning" &&
                rule.errorStyle !== "information" &&
                !values.includes(text)
            ) {
                showMessage(`${address}: choose a value from the dropdown list.`);
                return;
            }
        }
        const cells = sheet().cells;
        const next = cellFromInput(text, cells[address]?.z);
        const formatting = cells[address]?.s;
        if (next === undefined && formatting === undefined) delete cells[address];
        else cells[address] = { ...next, ...(formatting ? { s: formatting } : {}) };
    };

    function commitEditor(): void {
        if (editor === undefined) return;
        const box = editor;
        disposeEditorAssist?.();
        disposeEditorAssist = undefined;
        editor = undefined;
        const address = box.dataset["address"] ?? "";
        const value = box.value;
        box.remove();
        if (value !== box.dataset["original"]) {
            setCell(address, value);
            markDirty();
            renderRows();
            renderFormulaBar();
        }
        scroller.focus();
    }

    const cancelEditor = () => {
        disposeEditorAssist?.();
        disposeEditorAssist = undefined;
        editor?.remove();
        editor = undefined;
        scroller.focus();
    };

    const openEditor = (initial?: string) => {
        commitEditor();
        const td = tbody.querySelector<HTMLTableCellElement>(
            `td[data-row="${focus.row}"][data-col="${focus.col}"]`,
        );
        if (td === null) return;
        const address = addressOf(focus.row, focus.col);
        const original = cellInputText(sheet().cells[address]);
        const box = input({ className: style.cellEditor, spellcheck: false });
        box.setAttribute("aria-label", `Edit ${address}`);
        box.addEventListener("input", changed);
        disposeEditorAssist = assist.bind(box);
        box.dataset["address"] = address;
        box.dataset["original"] = original;
        box.value = initial ?? original;
        box.style.left = `${td.offsetLeft}px`;
        box.style.top = `${td.offsetTop}px`;
        box.style.width = `${Math.max(td.offsetWidth, 120)}px`;
        box.style.height = `${td.offsetHeight}px`;
        box.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") return;
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                commitEditor();
                move(
                    e.key === "Enter" ? (e.shiftKey ? -1 : 1) : 0,
                    e.key === "Tab" ? (e.shiftKey ? -1 : 1) : 0,
                    false,
                );
            } else if (e.key === "Escape") {
                cancelEditor();
            }
        });
        box.addEventListener("blur", () => {
            if (editor === box) commitEditor();
        });
        scroller.append(box);
        editor = box;
        box.focus();
        if (initial === undefined) box.select();
        else box.setSelectionRange(box.value.length, box.value.length);
        assist.refresh(box);
    };

    const move = (dRow: number, dCol: number, extend: boolean) => {
        const next = { row: Math.max(0, focus.row + dRow), col: Math.max(0, focus.col + dCol) };
        while (dRow && sheet().hiddenRows?.includes(next.row) && next.row > 0) next.row += Math.sign(dRow);
        while (dCol && sheet().hiddenCols?.includes(next.col) && next.col > 0) next.col += Math.sign(dCol);
        if (extend) selectRange(anchor, next);
        else selectRange(next);
    };

    const clearRange = () => {
        const range = normalizeRange(anchor, focus);
        const cells = sheet().cells;
        let changedAny = false;
        for (let r = range.start.row; r <= range.end.row; r++) {
            for (let c = range.start.col; c <= range.end.col; c++) {
                const address = addressOf(r, c);
                const cell = cells[address];
                if (cell === undefined || (cell.v === undefined && cell.f === undefined)) continue;
                setCell(address, "");
                changedAny = true;
            }
        }
        if (changedAny) {
            markDirty();
            renderRows();
            renderFormulaBar();
        }
    };

    const rangeAsText = () => {
        const range = normalizeRange(anchor, focus);
        const lines: string[] = [];
        for (let r = range.start.row; r <= range.end.row; r++) {
            const fields: string[] = [];
            for (let c = range.start.col; c <= range.end.col; c++) fields.push(cellText(r, c).text);
            lines.push(fields.join("\t"));
        }
        return lines.join("\n");
    };

    const paste = (text: string) => {
        const rows = text
            .replace(/\r\n?/g, "\n")
            .replace(/\n$/, "")
            .split("\n")
            .map((line) => line.split("\t"));
        rows.forEach((fields, r) => {
            fields.forEach((field, c) => {
                setCell(addressOf(focus.row + r, focus.col + c), field);
            });
        });
        anchor = focus;
        focus = {
            row: focus.row + rows.length - 1,
            col: focus.col + Math.max(...rows.map((f) => f.length)) - 1,
        };
        markDirty();
        renderAll();
    };

    // ---------------------------------------------------------- column resizing

    function startResize(e: MouseEvent, col: number): void {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = widthOf(col);
        const onMove = (event: MouseEvent) => {
            const width = Math.max(24, Math.round(startWidth + event.clientX - startX));
            const cols = sheet().cols ?? [];
            while (cols.length <= col) cols.push(null);
            cols[col] = width;
            sheet().cols = cols;
            const visibleIndex = Array.from({ length: col }, (_, i) => widthOf(i)).filter(
                (w) => w > 0,
            ).length;
            const element = colgroup.children[visibleIndex + 1] as HTMLElement | undefined;
            if (element !== undefined) element.style.width = `${width}px`;
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            if (widthOf(col) === startWidth) return;
            markDirty();
            renderColumns();
            renderRows();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }

    // ---------------------------------------------------------- events

    let frame = 0;
    scroller.addEventListener("scroll", () => {
        if (frame !== 0) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (editor === undefined) renderRows();
        });
    });
    let selecting = false;
    const endSelection = () => {
        selecting = false;
    };
    window.addEventListener("mouseup", endSelection);
    scroller.addEventListener("mouseover", (e) => {
        if (!selecting || editor) return;
        const td = (e.target as HTMLElement).closest<HTMLTableCellElement>("td[data-row]");
        if (!td) return;
        const to = { row: Number(td.dataset["row"]), col: Number(td.dataset["col"]) };
        if (to.row !== focus.row || to.col !== focus.col) selectRange(anchor, to);
    });
    scroller.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const td = (e.target as HTMLElement).closest("td");
        if (td === null || td.dataset["row"] === undefined) return;
        selecting = true;
        e.preventDefault();
        const at = { row: Number(td.dataset["row"]), col: Number(td.dataset["col"]) };
        if (e.shiftKey) selectRange(anchor, at);
        else selectRange(at);
        scroller.focus();
    });
    scroller.addEventListener("dblclick", (e) => {
        if ((e.target as HTMLElement).closest("td") !== null) openEditor();
    });
    scroller.addEventListener("keydown", (e) => {
        if (editor !== undefined || !loaded) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") return;
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
            const key = e.key.toLowerCase();
            if (["z", "y", "f"].includes(key)) {
                e.preventDefault();
                if (key === "f") actions.findDialog();
                else restoreRevision(key === "y" || e.shiftKey);
                return;
            }
        }
        const arrows: Record<string, [number, number]> = {
            ArrowUp: [-1, 0],
            ArrowDown: [1, 0],
            ArrowLeft: [0, -1],
            ArrowRight: [0, 1],
        };
        if (arrows[e.key] !== undefined) {
            e.preventDefault();
            move(arrows[e.key][0], arrows[e.key][1], e.shiftKey);
        } else if (e.key === "Enter" || e.key === "F2") {
            e.preventDefault();
            openEditor();
        } else if (e.key === "Tab") {
            e.preventDefault();
            move(0, e.shiftKey ? -1 : 1, false);
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            clearRange();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            openEditor(e.key);
        }
    });
    const copySelection = (e: ClipboardEvent) => {
        if (editor !== undefined) return;
        e.preventDefault();
        const range = normalizeRange(anchor, focus);
        const cells = Array.from({ length: range.end.row - range.start.row + 1 }, (_, r) =>
            Array.from({ length: range.end.col - range.start.col + 1 }, (_, c) =>
                structuredClone(sheet().cells[addressOf(range.start.row + r, range.start.col + c)]),
            ),
        );
        copiedRange = { token: String(++copyId), at: range.start, cells };
        e.clipboardData?.setData("text/plain", rangeAsText());
        e.clipboardData?.setData(CELLS_MIME, copiedRange.token);
    };
    scroller.addEventListener("copy", copySelection);
    scroller.addEventListener("cut", (event: ClipboardEvent) => {
        if (editor !== undefined) return;
        copySelection(event);
        clearRange();
    });
    scroller.addEventListener("paste", (e: ClipboardEvent) => {
        if (editor !== undefined) return;
        const text = e.clipboardData?.getData("text/plain");
        if (text === undefined || text === "") return;
        e.preventDefault();
        if (copiedRange && e.clipboardData?.getData(CELLS_MIME) === copiedRange.token) {
            const start = focus;
            const copied = copiedRange;
            for (const [r, row] of copied.cells.entries())
                for (const [c, cell] of row.entries()) {
                    const address = addressOf(start.row + r, start.col + c);
                    if (cell) {
                        const copy = structuredClone(cell);
                        if (copy.f)
                            copy.f = translateFormula(
                                copy.f,
                                start.row - copied.at.row,
                                start.col - copied.at.col,
                            );
                        sheet().cells[address] = copy;
                    } else delete sheet().cells[address];
                }
            anchor = start;
            focus = { row: start.row + copied.cells.length - 1, col: start.col + copied.cells[0].length - 1 };
            markDirty();
            renderAll();
        } else paste(text);
    });

    const commitFormula = () => {
        if (!loaded) return;
        const address = addressOf(focus.row, focus.col);
        if (formulaInput.value !== cellInputText(sheet().cells[address])) {
            setCell(address, formulaInput.value);
            markDirty();
            renderRows();
        }
        assist.hide();
    };
    formulaInput.addEventListener("blur", commitFormula);
    formulaInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") return;
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            const address = addressOf(focus.row, focus.col);
            if (formulaInput.value !== cellInputText(sheet().cells[address])) {
                setCell(address, formulaInput.value);
                markDirty();
                renderRows();
            }
            move(1, 0, false);
            scroller.focus();
        } else if (e.key === "Escape") {
            renderFormulaBar();
            scroller.focus();
        }
    });
    cellName.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") return;
        e.stopPropagation();
        if (e.key !== "Enter") return;
        e.preventDefault();
        const value = cellName.value.trim();
        const [ref] = resolveRanges(workbook, value, sheetIndex);
        if (ref) switchSheet(ref.sheet, ref.range);
        else if (validRangeName(value)) {
            actions.namedRanges(value);
            return;
        } else showMessage("Enter a cell address, range, or named range.");
        scroller.focus();
    });
    formatMenu.addEventListener("change", () => applyNumberFormat(formatMenu.value));
    function applyNumberFormat(code: string): void {
        commitEditor();
        if (window.document.activeElement === formulaInput) commitFormula();
        const range = normalizeRange(anchor, focus);
        const cells = sheet().cells;
        for (let r = range.start.row; r <= range.end.row; r++) {
            for (let c = range.start.col; c <= range.end.col; c++) {
                const address = addressOf(r, c);
                const cell = { ...(cells[address] ?? {}) };
                if (code === "General") delete cell.z;
                else cell.z = code;
                if (
                    cell.v === undefined &&
                    cell.f === undefined &&
                    cell.z === undefined &&
                    cell.s === undefined
                )
                    delete cells[address];
                else cells[address] = cell;
            }
        }
        markDirty();
        renderRows();
        renderFormulaBar();
        scroller.focus();
    }

    function eachSelected(action: (address: string) => void): void {
        const range = normalizeRange(anchor, focus);
        for (let r = range.start.row; r <= range.end.row; r++) {
            for (let c = range.start.col; c <= range.end.col; c++) action(addressOf(r, c));
        }
    }
    function applyStyle(update: (style: CellStyle) => CellStyle): void {
        commitEditor();
        if (window.document.activeElement === formulaInput) commitFormula();
        eachSelected((address) => {
            const cell = sheet().cells[address] ?? {};
            sheet().cells[address] = { ...cell, s: update(cell.s ?? {}) };
        });
        markDirty();
        renderRows();
        renderFormulaBar();
        scroller.focus();
    }
    function clearFormat(): void {
        commitEditor();
        if (window.document.activeElement === formulaInput) commitFormula();
        eachSelected((address) => {
            const cell = sheet().cells[address];
            if (cell) {
                delete cell.s;
                delete cell.z;
            }
        });
        markDirty();
        renderRows();
        renderFormulaBar();
        scroller.focus();
    }
    function mergeSelection(): void {
        commitEditor();
        const range = normalizeRange(anchor, focus);
        const intersects = (text: string) => {
            const m = parseRange(text);
            return (
                m &&
                m.start.row <= range.end.row &&
                m.end.row >= range.start.row &&
                m.start.col <= range.end.col &&
                m.end.col >= range.start.col
            );
        };
        const merges = sheet().merges ?? [];
        if (merges.some(intersects)) sheet().merges = merges.filter((m) => !intersects(m));
        else {
            if (range.start.row === range.end.row && range.start.col === range.end.col) return;
            const master = addressOf(range.start.row, range.start.col);
            const values: string[] = [];
            eachSelected((address) => {
                if (address !== master && cellInputText(sheet().cells[address]) !== "") values.push(address);
            });
            if (
                values.length &&
                !window.confirm("Merging keeps only the upper-left value. Merge these cells?")
            )
                return;
            values.forEach((address) => {
                setCell(address, "");
            });
            sheet().merges = [...merges, rangeText(range)];
            anchor = focus = range.start;
        }
        markDirty();
        renderRows();
        renderFormulaBar();
        scroller.focus();
    }

    // ---------------------------------------------------------- loading and saving

    function showMessage(text: string): void {
        notice.textContent = text;
        notice.style.display = "";
    }
    const actions = createSheetActions({
        read: () => ({ workbook, index: sheetIndex, range: normalizeRange(anchor, focus), focus }),
        mutate: (action) => {
            commitEditor();
            commitFormula();
            action();
            sheetIndex = Math.min(sheetIndex, workbook.sheets.length - 1);
            markDirty();
            renderAll();
        },
        select: switchSheet,
        save: saveWorkbook,
        undo: () => restoreRevision(false),
        redo: () => restoreRevision(true),
        clear: clearRange,
        clearFormat,
        merge: mergeSelection,
        editFormula: (text, cursor = text.length) => {
            formulaInput.value = text;
            formulaInput.focus();
            formulaInput.setSelectionRange(cursor, cursor);
            changed();
            assist.refresh(formulaInput);
        },
        setValue: (address, value) => {
            commitEditor();
            setCell(address, value);
            markDirty();
            renderRows();
            renderFormulaBar();
        },
        zoom: (value) => {
            commitEditor();
            scroller.style.setProperty("zoom", String(value));
            renderRows();
        },
        message: showMessage,
    });
    toolbar.element.prepend(actions.leadingTools);
    toolbar.element.append(actions.trailingTools);
    const names = sheetButton("Named ranges", "▾", () => actions.namesMenu(names));
    names.className = chrome.namesButton;

    const message = div({ className: style.message, textContent: new Localize("documents.loading") });
    const gridHost = div({ className: style.body }, message);

    const load = async () => {
        loaded = false;
        layoutDirty = true;
        assist.hide();
        if (format === "xls") {
            gridHost.replaceChildren(
                div({ className: style.message, textContent: new Localize("documents.sheet.xlsNotice") }),
            );
            return;
        }
        const result =
            node.bytes.length === 0
                ? { isOk: true as const, value: { sheets: [{ name: "Sheet1", cells: {} }] } as WorkbookData }
                : await readWorkbook(node.bytes, format, node.name);
        if (!result.isOk) {
            gridHost.replaceChildren(div({ className: style.error, textContent: result.error }));
            return;
        }
        workbook = cloneWorkbook(result.value);
        checkpointText = savedText = JSON.stringify(workbook);
        checkpoint = { book: cloneWorkbook(workbook), index: sheetIndex };
        undoStack.length = redoStack.length = 0;
        actions.resetFilters();
        evaluator = new WorkbookEvaluator(workbook);
        sheetIndex = Math.min(sheetIndex, workbook.sheets.length - 1);
        dirty = false;
        loaded = true;
        gridHost.replaceChildren(scroller, tabs);
        renderAll();
        changed();
    };
    void load();

    const exportAs = (target: "xlsx" | "ods" | "csv"): DocumentExport => ({
        label: `documents.export.${target}`,
        extension: `.${target}`,
        produce: async () => {
            commitEditor();
            commitFormula();
            const bytes = await writeWorkbook(workbook, target);
            if (!bytes.isOk) throw new Error(bytes.error);
            return bytes.value;
        },
    });

    async function saveWorkbook(): Promise<void> {
        commitEditor();
        commitFormula();
        if (!isWorkbookFormat(format)) return;
        const saved = cloneWorkbook(workbook);
        const bytes = await writeWorkbook(saved, format);
        if (!bytes.isOk) throw new Error(bytes.error);
        Transaction.execute(document, "edit spreadsheet", () => node.setBytes(bytes.value));
        setDocumentWorkbook(node, saved);
        savedText = JSON.stringify(saved);
        dirty = JSON.stringify(workbook) !== savedText;
        changed();
    }
    return {
        element: div(
            { className: `${style.body} ${chrome.sheet}` },
            actions.menuBar,
            toolbar.element,
            div(
                { className: `${style.formulaBar} ${chrome.formulaBar}` },
                cellName,
                names,
                span({ textContent: "fx" }),
                formulaInput,
            ),
            notice,
            gridHost,
        ),
        isDirty: () =>
            dirty ||
            (loaded &&
                ((editor !== undefined && editor.value !== editor.dataset["original"]) ||
                    formulaInput.value !== cellInputText(sheet().cells[addressOf(focus.row, focus.col)]))),
        save: saveWorkbook,
        reload: () => void load(),
        exports: () => (["xlsx", "ods", "csv"] as const).filter((target) => target !== format).map(exportAs),
        activated: () => {
            scroller.focus();
            if (loaded) renderRows();
        },
        dispose: () => {
            cancelAnimationFrame(frame);
            assist.dispose();
            actions.dispose();
            window.removeEventListener("mouseup", endSelection);
            editor?.remove();
        },
    };
}
