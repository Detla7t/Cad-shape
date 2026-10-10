// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type * as ExcelJS from "exceljs";
import { resolveStyleColors } from "./cellStyle";
import { translateFormula } from "./formulaText";
import {
    addressOf,
    type CellData,
    type CellStyle,
    parseAddress,
    parseRange,
    type SheetData,
    type WorkbookData,
} from "./model";
import { contains } from "./ranges";
import { addFormulaPrefixes, stripFormulaPrefixes } from "./xlsxFormula";
import { finishXlsxPackage, nameReferences, readWorkbookParts, type WorkbookParts } from "./xlsxParts";

/**
 * Excel workbooks (.xlsx) through ExcelJS (MIT), loaded on first use: values, formulas
 * (shared formulas expanded per cell, array / dynamic-array formulas with their range,
 * cached results kept), number formats, styles with theme colours resolved, column
 * widths, row heights, merges, validations, frozen panes and sheets. Dates become Excel
 * serial numbers (their date format is kept), rich text its plain text. What ExcelJS
 * does not model — Excel tables, hyperlink locations, pictures, the theme, formula names,
 * hidden gridlines — is read from and written to the package by `xlsxParts.ts`.
 */

type ExcelModule = typeof ExcelJS;
type ValidationWorksheet = ExcelJS.Worksheet & {
    dataValidations: { model: NonNullable<SheetData["validations"]> };
};

async function excel(): Promise<ExcelModule> {
    const module = (await import("exceljs")) as ExcelModule & { default?: ExcelModule };
    return module.default ?? module;
}

/** Days since 1899-12-30, the Excel (1900 system) serial number of a date. */
function serial(date: Date): number {
    return (date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Column width: Excel characters ↔ pixels (7 px per character of the default font, 5 px padding). */
const charsToPx = (chars: number) => Math.round(chars * 7 + 5);
const pxToChars = (px: number) => Math.max(0, (px - 5) / 7);

type Result = NonNullable<ExcelJS.CellFormulaValue["result"]>;

function resultOf(result: Result | undefined): Pick<CellData, "v" | "e"> {
    if (result === undefined || result === null) return {};
    if (result instanceof Date) return { v: serial(result) };
    if (typeof result === "object") return "error" in result ? { v: result.error, e: true } : {};
    return { v: result };
}

type StoredFormula = {
    formula?: string;
    sharedFormula?: string;
    result?: Result;
    shareType?: string;
    ref?: string;
};

interface ReadContext {
    worksheet: ExcelJS.Worksheet;
    parts?: WorkbookParts;
    /** Resolved styles by ExcelJS style object (shared by cells of one style). */
    styles: Map<object, CellStyle | undefined>;
}

function styleOf(cell: ExcelJS.Cell, context: ReadContext): CellStyle | undefined {
    const source = cell.style;
    if (context.styles.has(source)) return context.styles.get(source);
    const { numFmt: _numFmt, ...style } = source;
    const hasStyle = Object.values(style).some((part) => part && Object.keys(part).length > 0);
    const resolved = !hasStyle
        ? undefined
        : context.parts
          ? resolveStyleColors(style, context.parts.theme, context.parts.indexed)
          : structuredClone(style);
    context.styles.set(source, resolved);
    return resolved;
}

/** A shared formula's text at `address`: the master's formula moved by the offset between them. */
function sharedFormulaText(
    worksheet: ExcelJS.Worksheet,
    master: string,
    address: string,
): string | undefined {
    const value = worksheet.getCell(master).value as StoredFormula | null;
    const from = parseAddress(master);
    const to = parseAddress(address);
    if (!value?.formula || !from || !to) return undefined;
    return translateFormula(value.formula, to.row - from.row, to.col - from.col);
}

function cellOf(cell: ExcelJS.Cell, context: ReadContext): CellData | undefined {
    const value = cell.value;
    const z =
        typeof cell.numFmt === "string" && cell.numFmt !== "" && cell.numFmt !== "General"
            ? cell.numFmt
            : undefined;
    const style = styleOf(cell, context);
    const format = { ...(z === undefined ? {} : { z }), ...(style ? { s: structuredClone(style) } : {}) };
    if (value === null || value === undefined) return Object.keys(format).length === 0 ? undefined : format;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        return { v: value, ...format };
    }
    if (value instanceof Date) return { v: serial(value), ...format, z: z ?? "yyyy-mm-dd" };
    if ("formula" in value || "sharedFormula" in value) {
        const stored = value as StoredFormula;
        const formula =
            stored.formula ??
            (stored.sharedFormula
                ? sharedFormulaText(context.worksheet, stored.sharedFormula, cell.address)
                : undefined);
        const result = resultOf(stored.result);
        if (formula === undefined || formula === "") return { ...result, ...format };
        const array = stored.shareType === "array" && stored.ref ? { a: stored.ref } : {};
        return { f: stripFormulaPrefixes(formula), ...result, ...array, ...format };
    }
    if ("error" in value) return { v: value.error, e: true, ...format };
    if ("richText" in value) return { v: value.richText.map((run) => run.text).join(""), ...format };
    if ("text" in value) {
        const text = value.text as unknown;
        const plain =
            typeof text === "object" && text !== null && "richText" in text
                ? (text as ExcelJS.CellRichTextValue).richText.map((run) => run.text).join("")
                : String(text);
        return { v: plain, ...format };
    }
    return undefined;
}

/** Marks the cached cells inside each array formula's range as spill output (`sp`). */
function markSpills(cells: Record<string, CellData>): void {
    for (const [address, cell] of Object.entries(cells)) {
        const range = cell.a ? parseRange(cell.a) : undefined;
        if (!range) continue;
        const area = (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1);
        const mark = (key: string) => {
            const target = cells[key];
            if (key !== address && target && target.f === undefined && target.v !== undefined)
                target.sp = true;
        };
        if (area <= 100_000) {
            for (let r = range.start.row; r <= range.end.row; r++)
                for (let c = range.start.col; c <= range.end.col; c++) mark(addressOf(r, c));
        } else {
            for (const key of Object.keys(cells)) {
                const at = parseAddress(key);
                if (at && contains(range, at.row, at.col)) mark(key);
            }
        }
    }
}

type Validations = NonNullable<SheetData["validations"]>;

/**
 * Identical rules over neighbouring cells merged into rectangular ranges ("H4:H568") —
 * ExcelJS expands every `sqref` range into one entry per cell on load, and its own merging
 * on save sorts addresses as text and emits overlapping ranges.
 */
export function compressValidations(rules: Validations): Validations {
    const out: Validations = {};
    const groups = new Map<string, { rule: Validations[string]; cells: { row: number; col: number }[] }>();
    for (const [key, rule] of Object.entries(rules)) {
        const at = parseAddress(key);
        if (!at) {
            out[key] = rule;
            continue;
        }
        const id = JSON.stringify(rule);
        const group = groups.get(id) ?? { rule, cells: [] };
        groups.set(id, group);
        group.cells.push(at);
    }
    for (const { rule, cells } of groups.values()) {
        cells.sort((a, b) => a.col - b.col || a.row - b.row);
        // Vertical runs per column, then runs with the same rows in adjacent columns joined.
        const runs: { col: number; endCol: number; row: number; endRow: number }[] = [];
        for (const cell of cells) {
            const last = runs[runs.length - 1];
            if (last && last.col === cell.col && last.endRow + 1 === cell.row) last.endRow = cell.row;
            else runs.push({ col: cell.col, endCol: cell.col, row: cell.row, endRow: cell.row });
        }
        const merged: typeof runs = [];
        for (const run of runs) {
            const join = merged.find(
                (m) => m.endCol + 1 === run.col && m.row === run.row && m.endRow === run.endRow,
            );
            if (join) join.endCol = run.col;
            else merged.push(run);
        }
        for (const run of merged) {
            const start = addressOf(run.row, run.col);
            const end = addressOf(run.endRow, run.endCol);
            out[start === end ? start : `${start}:${end}`] = structuredClone(rule);
        }
    }
    return out;
}

function readNames(book: ExcelJS.Workbook, parts: WorkbookParts | undefined): WorkbookData["names"] {
    const names = structuredClone(book.definedNames.model);
    const known = new Set(names.map((n) => n.name.toLowerCase()));
    for (const name of parts?.names ?? []) {
        if (
            !name.name ||
            name.name.startsWith("_xlnm.") ||
            known.has(name.name.toLowerCase()) ||
            /^#[A-Z/0!?]+[!?]?$/.test(name.value) ||
            name.value === ""
        )
            continue;
        known.add(name.name.toLowerCase());
        names.push({
            name: name.name,
            ranges: nameReferences(name.value) ?? [stripFormulaPrefixes(name.value)],
        });
    }
    return names;
}

export async function readXlsx(bytes: Uint8Array): Promise<WorkbookData> {
    const [{ Workbook }, { default: JSZip }] = await Promise.all([excel(), import("jszip")]);
    const book = new Workbook();
    const [, parts] = await Promise.all([
        book.xlsx.load(bytes.slice().buffer as unknown as Parameters<typeof book.xlsx.load>[0]),
        // The package parts ExcelJS skips; a malformed one costs those features, not the workbook.
        JSZip.loadAsync(bytes)
            .then((zip) => readWorkbookParts(zip))
            .catch(() => undefined),
    ]);
    const styles = new Map<object, CellStyle | undefined>();
    const sheets: SheetData[] = book.worksheets.map((worksheet, sheetIndex) => {
        const context: ReadContext = { worksheet, parts, styles };
        const extra = parts?.sheets[sheetIndex];
        const cells: Record<string, CellData> = {};
        const rows: Record<number, number> = {};
        const hiddenRows: number[] = [];
        // Iterate stored rows/cells rather than materializing the gaps in sparse workbooks.
        const model = worksheet.model as typeof worksheet.model & {
            rows: { number: number; cells: { address: string }[] }[];
        };
        for (const stored of model.rows) {
            const row = worksheet.getRow(stored.number);
            if (row.hidden) hiddenRows.push(stored.number - 1);
            if (row.height) rows[stored.number - 1] = (row.height * 4) / 3;
            for (const entry of stored.cells) {
                const cell = worksheet.getCell(entry.address);
                if (cell.isMerged && cell.master.address !== cell.address) continue;
                const data = cellOf(cell, context);
                if (data !== undefined) cells[cell.address] = data;
            }
        }
        markSpills(cells);
        const cols = (worksheet.columns ?? []).map((column) =>
            typeof column.width === "number" ? charsToPx(column.width) : null,
        );
        const merges = ((worksheet.model as { merges?: string[] }).merges ?? []).filter((range) =>
            range.includes(":"),
        );
        const validations = compressValidations((worksheet as ValidationWorksheet).dataValidations.model);
        const view = worksheet.views?.find((v) => v.state === "frozen");
        const hiddenCols = (worksheet.columns ?? []).flatMap((col, i) => (col.hidden ? [i] : []));
        const filter = worksheet.autoFilter;
        const filterAddress = (point: string | { row: number; column: number }) =>
            typeof point === "string" ? point : addressOf(point.row - 1, point.column - 1);
        const autoFilter =
            typeof filter === "string"
                ? filter
                : filter
                  ? `${filterAddress(filter.from)}:${filterAddress(filter.to)}`
                  : undefined;
        const tables = extra?.tables ?? [];
        const hyperlinks = extra?.hyperlinks ?? {};
        const images = extra?.images ?? [];
        return {
            name: worksheet.name,
            ...(Object.keys(validations).length ? { validations } : {}),
            ...(autoFilter ? { autoFilter } : {}),
            ...(hiddenRows.length ? { hiddenRows } : {}),
            ...(hiddenCols.length ? { hiddenCols } : {}),
            ...(view?.state === "frozen"
                ? { frozen: { rows: view.ySplit ?? 0, cols: view.xSplit ?? 0 } }
                : {}),
            cells,
            ...(Object.keys(rows).length ? { rows } : {}),
            ...(cols.some((width) => width !== null) ? { cols } : {}),
            ...(merges.length > 0 ? { merges } : {}),
            ...(tables.length > 0 ? { tables } : {}),
            ...(Object.keys(hyperlinks).length > 0 ? { hyperlinks } : {}),
            ...(images.length > 0 ? { images } : {}),
            ...(extra && !extra.gridLines ? { gridLines: false } : {}),
        };
    });
    return {
        sheets: sheets.length > 0 ? sheets : [{ name: "Sheet1", cells: {} }],
        names: readNames(book, parts),
    };
}

const overlaps = (a: string, b: string) => {
    const x = parseRange(a);
    const y = parseRange(b);
    return (
        !!x &&
        !!y &&
        x.start.row <= y.end.row &&
        y.start.row <= x.end.row &&
        x.start.col <= y.end.col &&
        y.start.col <= x.end.col
    );
};

/** The workbook as .xlsx bytes; formula cells carry their cached result (`v`). */
export async function writeXlsx(workbook: WorkbookData): Promise<Uint8Array> {
    const { Workbook } = await excel();
    const book = new Workbook();
    book.creator = "Chili3D";
    for (const sheet of workbook.sheets) {
        const worksheet = book.addWorksheet(sheet.name.slice(0, 31) || "Sheet");
        for (const [address, cell] of Object.entries(sheet.cells)) {
            const target = worksheet.getCell(address);
            const error = { error: String(cell.v) } as ExcelJS.CellErrorValue;
            if (cell.f !== undefined) {
                const array = cell.a && parseRange(cell.a) ? { shareType: "array", ref: cell.a } : {};
                target.value = {
                    formula: addFormulaPrefixes(cell.f),
                    ...(cell.v === undefined ? {} : { result: cell.e ? error : cell.v }),
                    ...array,
                } as ExcelJS.CellFormulaValue;
            } else if (cell.v !== undefined) {
                target.value = cell.e ? error : cell.v;
            }
            if (cell.s !== undefined) target.style = structuredClone(cell.s);
            if (cell.z !== undefined) target.numFmt = cell.z;
        }
        (sheet.cols ?? []).forEach((width, index) => {
            if (width !== null) worksheet.getColumn(index + 1).width = pxToChars(width);
        });
        for (const [row, height] of Object.entries(sheet.rows ?? {})) {
            worksheet.getRow(Number(row) + 1).height = (height * 3) / 4;
        }
        for (const range of sheet.merges ?? []) worksheet.mergeCells(range);
        (worksheet as ValidationWorksheet).dataValidations.model = compressValidations(
            sheet.validations ?? {},
        );
        // A table carries its own filter; a sheet filter over a table makes Excel repair the file.
        const tableRefs = (sheet.tables ?? []).map((table) => table.ref);
        if (sheet.autoFilter && !tableRefs.some((ref) => overlaps(ref, sheet.autoFilter as string)))
            worksheet.autoFilter = sheet.autoFilter;
        for (const row of sheet.hiddenRows ?? []) worksheet.getRow(row + 1).hidden = true;
        for (const col of sheet.hiddenCols ?? []) worksheet.getColumn(col + 1).hidden = true;
        const gridLines = sheet.gridLines === false ? { showGridLines: false } : {};
        if (sheet.frozen)
            worksheet.views = [
                { state: "frozen", xSplit: sheet.frozen.cols, ySplit: sheet.frozen.rows, ...gridLines },
            ];
        else if (sheet.gridLines === false) worksheet.views = [{ state: "normal", showGridLines: false }];
    }
    // ExcelJS writes names that are plain references; formula names are added to the package.
    const names = workbook.names ?? [];
    const plain = names.filter((n) => n.ranges.length > 0 && n.ranges.every((r) => nameReferences(r)));
    const formulas = names
        .filter((n) => !plain.includes(n) && n.ranges.length > 0)
        .map((n) => ({ name: n.name, value: n.ranges.join(",") }));
    book.definedNames.model = structuredClone(plain);
    const bytes = new Uint8Array(await book.xlsx.writeBuffer());
    return finishXlsxPackage(bytes, workbook, formulas);
}
