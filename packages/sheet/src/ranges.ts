// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CellRange,
    parseAddress,
    parseRange,
    type TableData,
    usedSize,
    type WorkbookData,
} from "./model";

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

/**
 * Resolves a direct reference, a structured table reference (`Sales[Amount]`) or a workbook
 * name whose entries are such references. Never evaluates formulas.
 */
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
        if (!match) {
            const table = resolveTableReference(workbook, ref);
            if (table) return [table];
        }
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

/** The table named `name` (case-insensitive) and the index of its sheet. */
export function findTable(
    workbook: WorkbookData,
    name: string,
): { sheet: number; table: TableData } | undefined {
    const lower = name.toLowerCase();
    for (const [sheet, data] of workbook.sheets.entries()) {
        const table = data.tables?.find((t) => t.name.toLowerCase() === lower);
        if (table) return { sheet, table };
    }
    return undefined;
}

/** `[a],[b]:[c]` → ["a", ",", "b", ":", "c"], honouring Excel's `'` escapes inside items. */
function specifierItems(inner: string): string[] | undefined {
    const items: string[] = [];
    let i = 0;
    while (i < inner.length) {
        const ch = inner[i];
        if (ch === " ") i++;
        else if (ch === "," || ch === ":") {
            items.push(ch);
            i++;
        } else if (ch === "[") {
            let item = "";
            i++;
            while (i < inner.length && inner[i] !== "]") {
                if (inner[i] === "'" && i + 1 < inner.length) i++;
                item += inner[i++];
            }
            if (inner[i] !== "]") return undefined;
            items.push(item.trim());
            i++;
        } else return undefined;
    }
    return items;
}

/**
 * A structured reference without a current row (`Table`, `Table[Col]`, `Table[#Data]`,
 * `Table[[#Headers],[Col]]`, `Table[[Col1]:[Col2]]`) as a range; undefined for anything else
 * (including `[#This Row]` / `[@Col]`, which need the referencing cell).
 */
export function resolveTableReference(workbook: WorkbookData, text: string): ResolvedRange | undefined {
    const match = /^([A-Za-z_\\][\w.\\]*)(\[.*\])?$/s.exec(text.trim());
    if (!match) return undefined;
    const found = findTable(workbook, match[1]);
    const bounds = found ? parseRange(found.table.ref) : undefined;
    if (!found || !bounds) return undefined;
    const { table } = found;
    const spec = match[2]?.slice(1, -1) ?? "";
    let items: string[] | undefined;
    if (spec === "") items = [];
    else if (!spec.includes("[")) items = [spec.replace(/'(.)/g, "$1").trim()];
    else items = specifierItems(spec);
    if (!items || items.some((item) => item.startsWith("@"))) return undefined;
    const header = table.headerRow !== false;
    const firstData = bounds.start.row + (header ? 1 : 0);
    const lastData = bounds.end.row - (table.totalsRow ? 1 : 0);
    const areas = new Set<string>();
    const columns: number[] = [];
    let span = false;
    for (const item of items) {
        if (item === ",") continue;
        if (item === ":") {
            span = true;
            continue;
        }
        if (item.startsWith("#")) {
            const area = item.toLowerCase().replace(/\s+/g, " ");
            if (area === "#this row") return undefined;
            areas.add(area);
            continue;
        }
        const index = table.columns.findIndex((c) => c.name.toLowerCase() === item.toLowerCase());
        if (index < 0) return undefined;
        columns.push(index);
    }
    if (columns.length > 2 || (columns.length === 2 && !span)) return undefined;
    const rows: number[] = [];
    if (areas.size === 0 || areas.has("#data") || areas.has("#all")) rows.push(firstData, lastData);
    if ((areas.has("#headers") || areas.has("#all")) && header) rows.push(bounds.start.row);
    if ((areas.has("#totals") || areas.has("#all")) && table.totalsRow) rows.push(bounds.end.row);
    if (rows.length === 0) return undefined;
    const startCol = bounds.start.col + (columns.length ? Math.min(...columns) : 0);
    const endCol = columns.length ? bounds.start.col + Math.max(...columns) : bounds.end.col;
    const start = Math.min(...rows);
    const end = Math.max(...rows);
    if (end < start) return undefined;
    return {
        sheet: found.sheet,
        range: { start: { row: start, col: startCol }, end: { row: end, col: endCol } },
    };
}
