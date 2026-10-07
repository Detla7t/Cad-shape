// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { IDisposable } from "../foundation/disposable";
import { Result } from "../foundation/result";
import type { INode } from "../model/node";
import type { EvaluatedValue } from "./expression";
import { ANGLE_UNITS, LENGTH_UNITS, UNITLESS } from "./unitSpec";

/**
 * DATA TABLES — named grids of typed cells a document's nodes expose (a Data Source's sheets
 * and query results, a Document element's spreadsheet) for expressions (`data("Prices", "B3")`)
 * and FeatureScript (`getDataTable(context, "Parts")`) to read.
 *
 * Core only knows the shape of a table and how to find one: a module that keeps tables in
 * nodes registers an `IDataTableProvider`, and `findDataTable` asks the providers. The scope
 * (`VariableTable`) folds every provider's `revision` into its key, so a table that changes —
 * then calls `notifyDataTablesChanged` — re-scopes the document and everything rebuilds.
 */

/** One cell: a number, text (which may carry a unit, "12 mm"), a boolean, or empty. */
export type DataCell = number | string | boolean | null;

/** A table as a grid: header names, then the data rows (each as long as `columns` or shorter). */
export interface DataTable {
    readonly name: string;
    /** One header per column; a source without a header row names them `A`, `B`, … */
    readonly columns: readonly string[];
    readonly rows: readonly (readonly DataCell[])[];
    /**
     * Whether row 1 of the A1 grid is the header row (so `A2` is the first data row). Defaults to
     * true; false for a headerless source, whose `A1` is the first data row.
     */
    readonly hasHeader?: boolean;
}

/**
 * Reads tables out of document nodes. Calls are synchronous — expressions evaluate
 * synchronously — so a provider whose parsing is asynchronous keeps the parsed tables cached,
 * answers an error while it loads, and calls `notifyDataTablesChanged` once they are ready.
 */
export interface IDataTableProvider {
    /** True for a node this provider reads tables from. */
    canRead(node: INode): boolean;
    /** The node's table names (sheets, query results); the first is its default table. */
    tableNames?(node: INode): readonly string[];
    /**
     * One table: `sheet` names it (the default table when undefined), `range` is an optional A1
     * range ("B2:D10") within it, whose first row is then the header (see `sliceDataTable`).
     */
    readTable(node: INode, sheet?: string, range?: string): Result<DataTable>;
    /**
     * Changes whenever the node's tables do. Part of the document scope's key — without it a
     * changed table does not re-scope the document.
     */
    revision?(node: INode): string | number;
}

const providers: IDataTableProvider[] = [];

/** Registers a provider (once); disposing unregisters it. */
export function registerDataTableProvider(provider: IDataTableProvider): IDisposable {
    if (!providers.includes(provider)) providers.push(provider);
    return {
        dispose: () => {
            const index = providers.indexOf(provider);
            if (index >= 0) providers.splice(index, 1);
        },
    };
}

/** The provider reading `node`, if any. */
export function dataTableProviderOf(node: INode): IDataTableProvider | undefined {
    return providers.find((provider) => {
        try {
            return provider.canRead(node);
        } catch {
            return false;
        }
    });
}

export function isDataTableNode(node: INode): boolean {
    return providers.length > 0 && dataTableProviderOf(node) !== undefined;
}

/** A node some provider reads tables from. */
export interface DataTableSource {
    readonly node: INode;
    readonly provider: IDataTableProvider;
}

/** Every node of `document` some provider reads, in model-tree order. */
export function dataTableSources(document: IDocument): DataTableSource[] {
    if (providers.length === 0) return [];
    const sources: DataTableSource[] = [];
    for (const node of document.modelManager.findNodes()) {
        const provider = dataTableProviderOf(node);
        if (provider !== undefined) sources.push({ node, provider });
    }
    return sources;
}

/** The table names of one source; a provider that throws lists none. */
export function dataTableNames(source: DataTableSource): readonly string[] {
    try {
        return source.provider.tableNames?.(source.node) ?? [];
    } catch {
        return [];
    }
}

function readSource(source: DataTableSource, sheet?: string, range?: string): Result<DataTable> {
    try {
        return source.provider.readTable(source.node, sheet, range);
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

function byName(sources: readonly DataTableSource[], name: string): DataTableSource | undefined {
    return (
        sources.find((source) => source.node.name === name) ??
        sources.find((source) => source.node.name.trim().toLowerCase() === name.trim().toLowerCase())
    );
}

/** Where a table reference points: a source, and the table within it (its default when undefined). */
export interface DataTableTarget {
    readonly source: DataTableSource;
    readonly sheet?: string;
}

/**
 * Resolves a table reference: `"Prices"` (a source's default table), `"Workbook/Sheet2"` (a named
 * table of a source), or `"Sheet2"` alone when exactly one source has a table of that name.
 * Source names match exactly first, then ignoring case and surrounding spaces.
 */
export function resolveDataTableReference(document: IDocument, reference: string): Result<DataTableTarget> {
    const sources = dataTableSources(document);
    const whole = byName(sources, reference);
    if (whole !== undefined) return Result.ok({ source: whole });
    for (let at = reference.indexOf("/"); at >= 0; at = reference.indexOf("/", at + 1)) {
        const source = byName(sources, reference.slice(0, at));
        if (source !== undefined) return Result.ok({ source, sheet: reference.slice(at + 1) });
    }
    const holders = sources.filter((source) => dataTableNames(source).includes(reference));
    if (holders.length === 1) return Result.ok({ source: holders[0], sheet: reference });
    if (holders.length > 1) {
        return Result.err(
            `Data table "${reference}" is ambiguous: ${holders.map((x) => `${x.node.name}/${reference}`).join(", ")}`,
        );
    }
    const known = sources.map((source) => source.node.name);
    return Result.err(
        known.length === 0
            ? `Unknown data table "${reference}": the document has no data sources`
            : `Unknown data table "${reference}" (available: ${known.join(", ")})`,
    );
}

/** The table a reference names (see `resolveDataTableReference`), optionally an A1 `range` of it. */
export function findDataTable(document: IDocument, reference: string, range?: string): Result<DataTable> {
    const target = resolveDataTableReference(document, reference);
    if (!target.isOk) return Result.err(target.error);
    return readSource(target.value.source, target.value.sheet, range);
}

/**
 * What the document's tables are, as one string: which sources, under which names, at which
 * revisions. The variable table folds it into its layers key and the scope's `token`.
 */
export function dataTablesKey(document: IDocument): string {
    return dataTableSources(document)
        .map(({ node, provider }) => {
            let revision: string | number = "";
            try {
                revision = provider.revision?.(node) ?? "";
            } catch {
                revision = "?";
            }
            return `${node.id}\u0002${node.name}\u0002${revision}`;
        })
        .join("\u0001");
}

/** Called by a provider after a node's tables changed: re-scopes `document` when they differ. */
export function notifyDataTablesChanged(document: IDocument): void {
    document.variables.notifyScopeChanged();
}

// ------------------------------------------------------------------ A1 addressing

/** A cell of the A1 grid, both 0-based: `B3` is `{ column: 1, row: 2 }`. */
export interface CellAddress {
    readonly column: number;
    readonly row: number;
}

export interface CellRange {
    readonly start: CellAddress;
    readonly end: CellAddress;
}

const CELL_PATTERN = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/;

/** `0 → "A"`, `25 → "Z"`, `26 → "AA"`. */
export function columnName(index: number): string {
    let name = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    }
    return name;
}

/** `"A" → 0`, `"AA" → 26`; undefined for anything but one to three letters. */
export function columnIndex(letters: string): number | undefined {
    if (!/^[A-Za-z]{1,3}$/.test(letters)) return undefined;
    let index = 0;
    for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
    return index - 1;
}

/** `"B3"`, `"$B$3"` or `"b3"` as an address; undefined when it is not one. */
export function parseCellAddress(text: string): CellAddress | undefined {
    const match = CELL_PATTERN.exec(text.trim());
    if (match === null) return undefined;
    const column = columnIndex(match[1]);
    return column === undefined ? undefined : { column, row: Number(match[2]) - 1 };
}

export function formatCellAddress(address: CellAddress): string {
    return `${columnName(address.column)}${address.row + 1}`;
}

/** `"A1:C10"` (corners in either order) or a single cell `"B3"`. */
export function parseCellRange(text: string): CellRange | undefined {
    const [first, second, ...rest] = text.split(":");
    if (rest.length > 0) return undefined;
    const a = parseCellAddress(first);
    const b = second === undefined ? a : parseCellAddress(second);
    if (a === undefined || b === undefined) return undefined;
    return {
        start: { column: Math.min(a.column, b.column), row: Math.min(a.row, b.row) },
        end: { column: Math.max(a.column, b.column), row: Math.max(a.row, b.row) },
    };
}

/** The A1 grid of a table: its header row (when it has one), then the data rows. */
export function dataTableGrid(table: DataTable): (readonly DataCell[])[] {
    return table.hasHeader === false ? [...table.rows] : [table.columns, ...table.rows];
}

/** The cell at an A1 address, header row included; undefined outside the grid. */
export function dataTableCell(table: DataTable, address: CellAddress): DataCell | undefined {
    const headerRows = table.hasHeader === false ? 0 : 1;
    if (address.row < headerRows) return table.columns[address.column];
    const row = table.rows[address.row - headerRows];
    if (row === undefined || address.column >= Math.max(table.columns.length, row.length)) return undefined;
    return row[address.column] ?? null;
}

/**
 * A column by header — exactly, then ignoring case and surrounding spaces — or, when no header
 * matches, by its letters (`"B"`). Undefined when neither finds one.
 */
export function dataTableColumn(table: DataTable, column: string): number | undefined {
    const exact = table.columns.indexOf(column);
    if (exact >= 0) return exact;
    const wanted = column.trim().toLowerCase();
    const loose = table.columns.findIndex((name) => name.trim().toLowerCase() === wanted);
    if (loose >= 0) return loose;
    const index = columnIndex(column.trim());
    return index !== undefined && index < table.columns.length ? index : undefined;
}

/**
 * The part of a table's A1 grid inside `range`, as a table whose header is the range's first
 * row — what a provider answers for `readTable(node, sheet, "B2:D10")`.
 */
export function sliceDataTable(table: DataTable, range: CellRange): DataTable {
    const grid = dataTableGrid(table);
    const rows: DataCell[][] = [];
    for (let r = range.start.row; r <= range.end.row && r < grid.length; r++) {
        const row: DataCell[] = [];
        for (let c = range.start.column; c <= range.end.column; c++) row.push(grid[r][c] ?? null);
        rows.push(row);
    }
    const [header = [], ...data] = rows;
    return {
        name: table.name,
        columns: header.map((cell, i) =>
            cell === null || cell === "" ? columnName(range.start.column + i) : String(cell),
        ),
        rows: data,
        hasHeader: true,
    };
}

// ------------------------------------------------------------------ Cell values

/** Unit suffixes a data value may carry, as the factor to the app's unit (mm, degrees). */
const LENGTH_FACTORS: Record<string, number> = {
    mm: 1,
    millimeter: 1,
    millimeters: 1,
    millimetre: 1,
    millimetres: 1,
    cm: 10,
    centimeter: 10,
    centimeters: 10,
    centimetre: 10,
    centimetres: 10,
    m: 1000,
    meter: 1000,
    meters: 1000,
    metre: 1000,
    metres: 1000,
    km: 1e6,
    um: 0.001,
    µm: 0.001,
    micron: 0.001,
    microns: 0.001,
    in: 25.4,
    inch: 25.4,
    inches: 25.4,
    '"': 25.4,
    ft: 304.8,
    foot: 304.8,
    feet: 304.8,
    "'": 304.8,
    yd: 914.4,
    yard: 914.4,
    yards: 914.4,
};

const ANGLE_FACTORS: Record<string, number> = {
    deg: 1,
    degree: 1,
    degrees: 1,
    "°": 1,
    rad: 180 / Math.PI,
    radian: 180 / Math.PI,
    radians: 180 / Math.PI,
};

const QUANTITY_PATTERN = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(\S*)$/;

/**
 * A data value as a quantity: `"12"` is a plain number (it takes the unit of the slot it lands
 * in, like a literal), `"12 mm"`, `"2 in"`, `"0.5m"` are lengths in mm, `"30 deg"`, `"30°"`,
 * `"0.5 rad"` angles in degrees, `"50%"` the ratio 0.5. Undefined for anything else.
 */
export function parseDataQuantity(text: string): EvaluatedValue | undefined {
    const match = QUANTITY_PATTERN.exec(text.trim());
    if (match === null) return undefined;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return undefined;
    const unit = match[2];
    if (unit === "") return { value, unit: UNITLESS };
    if (unit === "%") return { value: value / 100, unit: UNITLESS };
    const key = unit === "µm" || unit === "°" ? unit : unit.toLowerCase();
    if (Object.hasOwn(LENGTH_FACTORS, key)) return { value: value * LENGTH_FACTORS[key], unit: LENGTH_UNITS };
    if (Object.hasOwn(ANGLE_FACTORS, key)) return { value: value * ANGLE_FACTORS[key], unit: ANGLE_UNITS };
    return undefined;
}

/** A cell as a number with its unit: booleans are 1 / 0, text must read as a quantity. */
export function dataCellValue(cell: DataCell | undefined): Result<EvaluatedValue> {
    if (typeof cell === "number") {
        return Number.isFinite(cell)
            ? Result.ok({ value: cell, unit: UNITLESS })
            : Result.err("not a number");
    }
    if (typeof cell === "boolean") return Result.ok({ value: cell ? 1 : 0, unit: UNITLESS });
    if (cell === null || cell === undefined || cell.trim() === "") return Result.err("the cell is empty");
    const quantity = parseDataQuantity(cell);
    return quantity === undefined ? Result.err(`"${cell}" is not a number`) : Result.ok(quantity);
}
