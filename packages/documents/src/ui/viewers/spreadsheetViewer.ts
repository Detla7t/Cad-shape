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
import { COMMON_NUMBER_FORMATS, formatCellValue } from "../../sheet/numberFormat";
import { isWorkbookFormat, readWorkbook, type WorkbookFormat, writeWorkbook } from "../../sheet/workbookIo";
import { labelButton } from "../controls";
import style from "../documents.module.css";
import type { DocumentExport, IDocumentViewer, ViewerContext } from "../viewer";
import { createFormulaAssist } from "./formulaAssist";
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
    const assist = createFormulaAssist();
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
    const toolbar = createSheetToolbar(applyStyle, clearFormat, mergeSelection);
    toolbar.element.append(formatMenu);
    const notice = div({ className: style.notice });
    const table = window.document.createElement("table");
    table.className = style.grid;
    const colgroup = window.document.createElement("colgroup");
    const thead = window.document.createElement("thead");
    const tbody = window.document.createElement("tbody");
    table.append(colgroup, thead, tbody);
    const scroller = div({ className: style.gridScroller, tabIndex: 0 }, table);
    const tabs = div({ className: style.sheetTabs });

    const sheet = () => workbook.sheets[sheetIndex];
    const size = () => {
        const used = usedSize(sheet(), true);
        return { rows: Math.max(used.rows + 30, 100), cols: Math.max(used.cols + 6, 26) };
    };
    const widthOf = (col: number) => sheet().cols?.[col] ?? DEFAULT_WIDTH;

    const markDirty = () => {
        dirty = true;
        layoutDirty = true;
        evaluator = new WorkbookEvaluator(workbook);
        changed();
    };

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
            const col = window.document.createElement("col");
            col.style.width = `${widthOf(c)}px`;
            colgroup.append(col);
            const th = window.document.createElement("th");
            th.className = style.columnHeader;
            th.textContent = columnName(c);
            const resizer = span({ className: style.resizer });
            resizer.addEventListener("mousedown", (e) => startResize(e, c));
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
        rowTops = [0];
        for (const height of heights) rowTops.push(rowTops[rowTops.length - 1] + height);
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
        if (first > 0) fragment.append(spacer(rowTops[first]));
        for (let r = first; r <= last; r++) {
            const tr = window.document.createElement("tr");
            tr.style.height = `${rowTops[r + 1] - rowTops[r]}px`;
            const th = window.document.createElement("th");
            th.textContent = String(r + 1);
            th.addEventListener("click", () =>
                selectRange({ row: r, col: 0 }, { row: r, col: size().cols - 1 }),
            );
            tr.append(th);
            for (let c = 0; c < cols; c++) {
                const merge = merges.find(
                    (m) => r >= m.start.row && r <= m.end.row && c >= m.start.col && c <= m.end.col,
                );
                if (merge && (r !== merge.start.row || c !== merge.start.col)) continue;
                const td = window.document.createElement("td");
                const { text, className } = cellText(r, c);
                td.textContent = text;
                if (merge) {
                    td.rowSpan = merge.end.row - r + 1;
                    td.colSpan = merge.end.col - c + 1;
                }
                applyCellStyle(td, sheet().cells[addressOf(r, c)]?.s);
                td.title = text.length > 12 ? text : "";
                const inRange =
                    r >= range.start.row && r <= range.end.row && c >= range.start.col && c <= range.end.col;
                const isFocus = r === focus.row && c === focus.col;
                td.className = [className, isFocus ? style.selected : inRange ? style.inRange : ""]
                    .join(" ")
                    .trim();
                td.dataset["row"] = String(r);
                td.dataset["col"] = String(c);
                tr.append(td);
            }
            fragment.append(tr);
        }
        if (last < rows - 1) fragment.append(spacer(rowTops[rows] - rowTops[last + 1]));
        tbody.replaceChildren(fragment);
    };

    const renderTabs = () => {
        tabs.replaceChildren(
            ...workbook.sheets.map((s, index) =>
                div({
                    className:
                        index === sheetIndex ? `${style.sheetTab} ${style.sheetActive}` : style.sheetTab,
                    textContent: s.name,
                    onclick: () => {
                        commitEditor();
                        sheetIndex = index;
                        layoutDirty = true;
                        anchor = focus = { row: 0, col: 0 };
                        renderAll();
                    },
                    ondblclick: () => {
                        const name = window.prompt(I18n.translate("documents.sheet.rename"), s.name)?.trim();
                        if (
                            !name ||
                            workbook.sheets.some(
                                (other) => other !== s && other.name.toLowerCase() === name.toLowerCase(),
                            )
                        )
                            return;
                        s.name = name;
                        markDirty();
                        renderTabs();
                    },
                }),
            ),
            labelButton("documents.sheet.add", () => {
                let n = workbook.sheets.length + 1;
                while (workbook.sheets.some((s) => s.name === `Sheet${n}`)) n++;
                workbook.sheets.push({ name: `Sheet${n}`, cells: {} });
                sheetIndex = workbook.sheets.length - 1;
                markDirty();
                renderAll();
            }),
        );
    };

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
        renderRows();
        renderFormulaBar();
    }

    const setCell = (address: string, text: string) => {
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
            const element = colgroup.children[col + 1] as HTMLElement | undefined;
            if (element !== undefined) element.style.width = `${width}px`;
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
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
    scroller.addEventListener("mousedown", (e) => {
        const td = (e.target as HTMLElement).closest("td");
        if (td === null || td.dataset["row"] === undefined) return;
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
    scroller.addEventListener("copy", (e: ClipboardEvent) => {
        if (editor !== undefined) return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", rangeAsText());
    });
    scroller.addEventListener("paste", (e: ClipboardEvent) => {
        if (editor !== undefined) return;
        const text = e.clipboardData?.getData("text/plain");
        if (text === undefined || text === "") return;
        e.preventDefault();
        paste(text);
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
        const [a, b] = cellName.value.split(":");
        const from = parseAddress(a ?? "");
        const to = b === undefined ? from : parseAddress(b);
        if (from !== undefined && to !== undefined) selectRange(from, to);
        scroller.focus();
    });
    formatMenu.addEventListener("change", () => {
        const code = formatMenu.value;
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
        scroller.focus();
    });

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

    return {
        element: div(
            { className: style.body },
            toolbar.element,
            div({ className: style.formulaBar }, cellName, span({ textContent: "fx" }), formulaInput),
            notice,
            gridHost,
        ),
        isDirty: () => dirty,
        save: async () => {
            commitEditor();
            commitFormula();
            if (!isWorkbookFormat(format)) return;
            const bytes = await writeWorkbook(workbook, format);
            if (!bytes.isOk) throw new Error(bytes.error);
            Transaction.execute(document, "edit spreadsheet", () => node.setBytes(bytes.value));
            setDocumentWorkbook(node, cloneWorkbook(workbook));
            dirty = false;
            changed();
        },
        reload: () => void load(),
        exports: () => (["xlsx", "ods", "csv"] as const).filter((target) => target !== format).map(exportAs),
        activated: () => {
            scroller.focus();
            if (loaded) renderRows();
        },
        dispose: () => {
            cancelAnimationFrame(frame);
            assist.dispose();
            editor?.remove();
        },
    };
}
