// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isFormulaError, type Scalar, WorkbookEvaluator } from "./formula";
import {
    addressOf,
    type CellRange,
    columnName,
    parseRange,
    rangeText,
    type SheetData,
    type WorkbookData,
} from "./model";
import { contains, resolveRanges } from "./ranges";

/** Excel relative references follow a moved/copied formula; absolute references do not. */
export function translateFormula(formula: string, rows: number, cols = 0): string {
    return formula.replace(
        /"(?:[^"]|"")*"|'(?:[^']|'')*'!|\b[A-Za-z_][\w.]*!|(?<![\w.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![\w.(])/g,
        (token, absoluteCol: string | undefined, letters: string, absoluteRow: string, digits: string) => {
            if (absoluteCol === undefined) return token;
            const c =
                [...letters.toUpperCase()].reduce((n, v) => n * 26 + v.charCodeAt(0) - 64, 0) -
                1 +
                (absoluteCol ? 0 : cols);
            const r = Number(digits) - 1 + (absoluteRow ? 0 : rows);
            return r < 0 || c < 0 || c >= 16384 || r >= 1048576
                ? "#REF!"
                : `${absoluteCol}${columnName(c)}${absoluteRow}${r + 1}`;
        },
    );
}

export function sortRange(
    workbook: WorkbookData,
    index: number,
    range: CellRange,
    column: number,
    ascending: boolean,
): boolean {
    const sheet = workbook.sheets[index];
    if (
        sheet.merges?.some((m) => {
            const merged = parseRange(m);
            return (
                merged &&
                merged.start.row <= range.end.row &&
                merged.end.row >= range.start.row &&
                merged.start.col <= range.end.col &&
                merged.end.col >= range.start.col
            );
        })
    )
        return false;
    const evaluator = new WorkbookEvaluator(workbook);
    const rows = Array.from({ length: range.end.row - range.start.row + 1 }, (_, i) => range.start.row + i);
    const key = (r: number) => evaluator.value(index, addressOf(r, column));
    const compare = (a: Scalar, b: Scalar) => {
        if (a === null) return b === null ? 0 : 1;
        if (b === null) return -1;
        const direction = ascending ? 1 : -1;
        return (
            direction *
            (typeof a === "number" && typeof b === "number"
                ? a - b
                : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }))
        );
    };
    rows.sort((a, b) => compare(key(a), key(b)));
    const original = structuredClone(sheet.cells);
    rows.forEach((sourceRow, i) => {
        const targetRow = range.start.row + i;
        for (let c = range.start.col; c <= range.end.col; c++) {
            const cell = original[addressOf(sourceRow, c)];
            const address = addressOf(targetRow, c);
            if (!cell) delete sheet.cells[address];
            else
                sheet.cells[address] = {
                    ...cell,
                    ...(cell.f ? { f: translateFormula(cell.f, targetRow - sourceRow) } : {}),
                };
        }
    });
    return true;
}

const validationRanges = new WeakMap<
    object,
    { range: CellRange; rule: NonNullable<SheetData["validations"]>[string] }[]
>();

export function validationAt(sheet: SheetData, row: number, col: number) {
    const rules = sheet.validations;
    if (!rules) return undefined;
    const direct = rules[addressOf(row, col)];
    if (direct) return direct;
    let ranges = validationRanges.get(rules);
    if (!ranges) {
        ranges = Object.entries(rules).flatMap(([text, rule]) => {
            const range = text.includes(":") ? parseRange(text) : undefined;
            return range ? [{ range, rule }] : [];
        });
        validationRanges.set(rules, ranges);
    }
    return ranges.find(({ range }) => contains(range, row, col))?.rule;
}

export function dropdownValues(
    workbook: WorkbookData,
    index: number,
    row: number,
    col: number,
): string[] | undefined {
    const rule = validationAt(workbook.sheets[index], row, col);
    if (rule?.type !== "list") return undefined;
    const source = String(rule.formulae[0] ?? "").replace(/^=/, "");
    if (source.startsWith('"') && source.endsWith('"')) return source.slice(1, -1).split(",");
    const evaluator = new WorkbookEvaluator(workbook);
    const values: string[] = [];
    for (const ref of resolveRanges(workbook, source, index)) {
        const area =
            (ref.range.end.row - ref.range.start.row + 1) * (ref.range.end.col - ref.range.start.col + 1);
        if (area > 100000) continue;
        for (const value of evaluator.range(ref.sheet, ref.range.start, ref.range.end).flat()) {
            if (value !== null && !isFormulaError(value)) values.push(String(value));
        }
    }
    return [...new Set(values)];
}

export const BAND_COLORS = {
    Rose: ["FFCA91A6", "FFFFFFFF", "FFF4E8EE"],
    Blue: ["FF4F81BD", "FFFFFFFF", "FFEAF1FA"],
    Green: ["FF548235", "FFFFFFFF", "FFEBF1DE"],
    Gray: ["FF666666", "FFFFFFFF", "FFF2F2F2"],
} as const;

export function alternateColors(sheet: SheetData, range: CellRange, palette: keyof typeof BAND_COLORS): void {
    const colors = BAND_COLORS[palette];
    for (let r = range.start.row; r <= range.end.row; r++) {
        for (let c = range.start.col; c <= range.end.col; c++) {
            const address = addressOf(r, c);
            const cell = sheet.cells[address] ?? {};
            const header = r === range.start.row;
            sheet.cells[address] = {
                ...cell,
                s: {
                    ...cell.s,
                    fill: {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: header ? colors[0] : colors[1 + ((r - range.start.row - 1) % 2)] },
                    },
                    ...(header ? { font: { ...cell.s?.font, color: { argb: "FFFFFFFF" }, bold: true } } : {}),
                },
            };
        }
    }
}

/** Replace validation on a rectangle without overlapping XLSX rules or changing cells outside it. */
export function setValidation(
    sheet: SheetData,
    range: CellRange,
    rule?: NonNullable<SheetData["validations"]>[string],
): void {
    const rules: NonNullable<SheetData["validations"]> = {};
    for (const [text, existing] of Object.entries(sheet.validations ?? {})) {
        const old = parseRange(text);
        if (
            !old ||
            old.end.row < range.start.row ||
            old.start.row > range.end.row ||
            old.end.col < range.start.col ||
            old.start.col > range.end.col
        ) {
            rules[text] = existing;
            continue;
        }
        const top = Math.max(old.start.row, range.start.row);
        const bottom = Math.min(old.end.row, range.end.row);
        const pieces: CellRange[] = [
            { start: old.start, end: { row: top - 1, col: old.end.col } },
            { start: { row: bottom + 1, col: old.start.col }, end: old.end },
            {
                start: { row: top, col: old.start.col },
                end: { row: bottom, col: Math.max(old.start.col, range.start.col) - 1 },
            },
            {
                start: { row: top, col: Math.min(old.end.col, range.end.col) + 1 },
                end: { row: bottom, col: old.end.col },
            },
        ];
        for (const piece of pieces)
            if (piece.start.row <= piece.end.row && piece.start.col <= piece.end.col) {
                rules[rangeText(piece)] = {
                    ...structuredClone(existing),
                    formulae: existing.formulae.map((formula: unknown) =>
                        typeof formula === "string"
                            ? translateFormula(
                                  formula,
                                  piece.start.row - old.start.row,
                                  piece.start.col - old.start.col,
                              )
                            : formula,
                    ),
                };
            }
    }
    if (rule) rules[rangeText(range)] = structuredClone(rule);
    sheet.validations = rules;
}
