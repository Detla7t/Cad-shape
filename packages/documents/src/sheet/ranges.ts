// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CellRange, parseAddress, parseRange, usedSize, type WorkbookData } from "./model";

export function quoteSheet(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
}

export function validRangeName(name: string): boolean {
    return (
        /^[A-Za-z_][\w.]{0,254}$/.test(name) &&
        !parseAddress(name) &&
        !/^(true|false|r|c|r\d+c\d+)$/i.test(name)
    );
}

export function validSheetName(name: string): boolean {
    return (
        name.length > 0 &&
        name.length <= 31 &&
        !/[\\/*?:[\]]/.test(name) &&
        !name.startsWith("'") &&
        !name.endsWith("'")
    );
}

export type ResolvedRange = { sheet: number; range: CellRange };

/** Resolves a direct reference or workbook name. Names only contain direct ranges, never executable text. */
export function resolveRanges(workbook: WorkbookData, text: string, current = 0): ResolvedRange[] {
    const reference = text.replace(/^=/, "").trim();
    const name = workbook.names?.find((n) => n.name.toLowerCase() === reference.toLowerCase());
    return (name?.ranges ?? [reference]).flatMap((ref) => {
        const match = /^(?:'((?:[^']|'')*)'|([^!]+))!(.+)$/.exec(ref);
        const sheet = match
            ? workbook.sheets.findIndex(
                  (s) => s.name.toLowerCase() === (match[1]?.replace(/''/g, "'") ?? match[2]).toLowerCase(),
              )
            : current;
        if (!workbook.sheets[sheet]) return [];
        const range = parseRange(match?.[3] ?? ref, usedSize(workbook.sheets[sheet]));
        if (
            !range ||
            range.start.row < 0 ||
            range.start.col < 0 ||
            range.end.row >= 1048576 ||
            range.end.col >= 16384
        )
            return [];
        return [{ sheet, range }];
    });
}

export function contains(range: CellRange, row: number, col: number): boolean {
    return row >= range.start.row && row <= range.end.row && col >= range.start.col && col <= range.end.col;
}

/** Rewrites sheet prefixes but leaves string literals and other sheet names untouched. */
export function renameSheetReferences(formula: string, from: string, to: string): string {
    return formula.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'!|\b[A-Za-z_][\w.]*!/g, (token) => {
        if (!token.endsWith("!")) return token;
        const old = token.startsWith("'") ? token.slice(1, -2).replace(/''/g, "'") : token.slice(0, -1);
        return old.toLowerCase() === from.toLowerCase() ? `${quoteSheet(to)}!` : token;
    });
}

export function renameWorkbookSheet(workbook: WorkbookData, index: number, name: string): void {
    const from = workbook.sheets[index].name;
    const rewrite = (text: string) => renameSheetReferences(text, from, name);
    for (const sheet of workbook.sheets) {
        for (const cell of Object.values(sheet.cells)) if (cell.f) cell.f = rewrite(cell.f);
        for (const rule of Object.values(sheet.validations ?? {})) {
            rule.formulae = rule.formulae.map((value: unknown) =>
                typeof value === "string" ? rewrite(value) : value,
            );
        }
    }
    for (const range of workbook.names ?? []) range.ranges = range.ranges.map(rewrite);
    workbook.sheets[index].name = name;
}
