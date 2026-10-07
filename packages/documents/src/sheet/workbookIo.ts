// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { csvToWorkbook, sheetToCsv } from "./csv";
import { isFormulaError, WorkbookEvaluator } from "./formula";
import { cloneWorkbook, type WorkbookData } from "./model";

/**
 * Reading and writing workbook files: CSV/TSV (`csv.ts`, dependency-free), XLSX through
 * ExcelJS (`xlsx.ts`) and ODS through its own reader/writer (`ods.ts`), both loaded on
 * first use. Excel 97–2003 (.xls, binary BIFF) has no maintained open-source reader the
 * app can ship, so .xls files are kept and downloadable but not opened.
 */

export type WorkbookFormat = "csv" | "tsv" | "xlsx" | "xls" | "ods";

export const WORKBOOK_FORMATS: readonly WorkbookFormat[] = ["csv", "tsv", "xlsx", "xls", "ods"];

export function isWorkbookFormat(format: string): format is WorkbookFormat {
    return (WORKBOOK_FORMATS as readonly string[]).includes(format);
}

/** Why a binary Excel 97–2003 workbook cannot be opened (an i18n-free message for the API). */
export const XLS_UNSUPPORTED =
    "Excel 97–2003 workbooks (.xls) cannot be opened: save the file as .xlsx (or .ods) in a spreadsheet program and import that";

function decodeText(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder("windows-1252").decode(bytes);
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A workbook file's sheets. `name` names the sheet of a CSV/TSV file. */
export async function readWorkbook(
    bytes: Uint8Array,
    format: WorkbookFormat,
    name = "Sheet1",
): Promise<Result<WorkbookData>> {
    if (format === "csv" || format === "tsv") {
        return Result.ok(csvToWorkbook(decodeText(bytes), name, format === "tsv" ? "\t" : undefined));
    }
    if (format === "xls") return Result.err(XLS_UNSUPPORTED);
    try {
        if (format === "ods") return Result.ok(await (await import("./ods")).readOds(bytes));
        return Result.ok(await (await import("./xlsx")).readXlsx(bytes));
    } catch (error) {
        return Result.err(`The workbook cannot be read: ${message(error)}`);
    }
}

/** The workbook with each formula's evaluated result stored as its cached value. */
export function withCachedValues(workbook: WorkbookData): WorkbookData {
    const evaluator = new WorkbookEvaluator(workbook);
    const copy = cloneWorkbook(workbook);
    copy.sheets.forEach((sheet, index) => {
        for (const [address, cell] of Object.entries(sheet.cells)) {
            if (cell.f === undefined) continue;
            const value = evaluator.value(index, address);
            if (isFormulaError(value)) {
                cell.v = value.code;
                cell.e = true;
            } else if (value === null) {
                delete cell.v;
                delete cell.e;
            } else {
                cell.v = value;
                delete cell.e;
            }
        }
    });
    return copy;
}

/** The workbook as a file of `format`; CSV/TSV hold the first sheet's values. */
export async function writeWorkbook(
    workbook: WorkbookData,
    format: WorkbookFormat,
): Promise<Result<Uint8Array>> {
    if (format === "csv" || format === "tsv") {
        const sheet = workbook.sheets[0] ?? { name: "Sheet1", cells: {} };
        const text = sheetToCsv(sheet, new WorkbookEvaluator(workbook), 0, format === "tsv" ? "\t" : ",");
        return Result.ok(new TextEncoder().encode(text));
    }
    if (format === "xls") return Result.err(XLS_UNSUPPORTED);
    try {
        const cached = withCachedValues(workbook);
        if (format === "ods") return Result.ok(await (await import("./ods")).writeOds(cached));
        return Result.ok(await (await import("./xlsx")).writeXlsx(cached));
    } catch (error) {
        return Result.err(`The workbook cannot be written: ${message(error)}`);
    }
}
