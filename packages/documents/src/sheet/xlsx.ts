// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type * as ExcelJS from "exceljs";
import { addressOf, type CellData, type SheetData, type WorkbookData } from "./model";

/**
 * Excel workbooks (.xlsx) through ExcelJS (MIT), loaded on first use: values, formulas
 * with their cached results, number formats, column widths, merges and sheets. Dates
 * become Excel serial numbers (their date format is kept), rich text its plain text,
 * hyperlinks their text.
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

function cellOf(cell: ExcelJS.Cell): CellData | undefined {
    const value = cell.value;
    const z =
        typeof cell.numFmt === "string" && cell.numFmt !== "" && cell.numFmt !== "General"
            ? cell.numFmt
            : undefined;
    const { numFmt: _numFmt, ...style } = cell.style;
    const hasStyle = Object.values(style).some((part) => part && Object.keys(part).length > 0);
    const format = { ...(z === undefined ? {} : { z }), ...(hasStyle ? { s: structuredClone(style) } : {}) };
    if (value === null || value === undefined) return Object.keys(format).length === 0 ? undefined : format;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        return { v: value, ...format };
    }
    if (value instanceof Date) return { v: serial(value), ...format, z: z ?? "yyyy-mm-dd" };
    if ("formula" in value || "sharedFormula" in value) {
        const formula = cell.formula ?? ("formula" in value ? value.formula : undefined);
        if (formula === undefined || formula === "") return { ...resultOf(value.result), ...format };
        return { f: formula, ...resultOf(value.result), ...format };
    }
    if ("error" in value) return { v: value.error, e: true, ...format };
    if ("richText" in value) return { v: value.richText.map((run) => run.text).join(""), ...format };
    if ("text" in value) return { v: String(value.text), ...format };
    return undefined;
}

export async function readXlsx(bytes: Uint8Array): Promise<WorkbookData> {
    const { Workbook } = await excel();
    const book = new Workbook();
    await book.xlsx.load(bytes.slice().buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheets: SheetData[] = book.worksheets.map((worksheet) => {
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
                const data = cellOf(cell);
                if (data !== undefined) cells[cell.address] = data;
            }
        }
        const cols = (worksheet.columns ?? []).map((column) =>
            typeof column.width === "number" ? charsToPx(column.width) : null,
        );
        const merges = ((worksheet.model as { merges?: string[] }).merges ?? []).filter((range) =>
            range.includes(":"),
        );
        const validations = structuredClone((worksheet as ValidationWorksheet).dataValidations.model);
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
        };
    });
    return {
        sheets: sheets.length > 0 ? sheets : [{ name: "Sheet1", cells: {} }],
        names: structuredClone(book.definedNames.model),
    };
}

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
                target.value = {
                    formula: cell.f,
                    ...(cell.v === undefined ? {} : { result: cell.e ? error : cell.v }),
                };
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
        (worksheet as ValidationWorksheet).dataValidations.model = structuredClone(sheet.validations ?? {});
        if (sheet.autoFilter) worksheet.autoFilter = sheet.autoFilter;
        for (const row of sheet.hiddenRows ?? []) worksheet.getRow(row + 1).hidden = true;
        for (const col of sheet.hiddenCols ?? []) worksheet.getColumn(col + 1).hidden = true;
        if (sheet.frozen)
            worksheet.views = [{ state: "frozen", xSplit: sheet.frozen.cols, ySplit: sheet.frozen.rows }];
    }
    book.definedNames.model = structuredClone(workbook.names ?? []);
    return new Uint8Array(await book.xlsx.writeBuffer());
}
