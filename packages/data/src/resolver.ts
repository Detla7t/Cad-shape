// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DataCell,
    type DataTable,
    dataCellValue,
    dataTableCell,
    dataTableColumn,
    type EvaluatedValue,
    type ExpressionArgument,
    type ExpressionFunctionContext,
    findDataTable,
    formatCellAddress,
    type IDisposable,
    mergeUnitSpecs,
    parseCellAddress,
    Result,
    registerExpressionFunction,
    type Scope,
    scopeContext,
    UNITLESS,
    type UnitSpec,
    unitSpecEquals,
    unitSpecLabel,
} from "@chili3d/core";

/**
 * THE RESOLVER — functions every expression can call to read document data tables (Data
 * Sources, and any other `IDataTableProvider`):
 *
 * - `data("Prices", "B3")` — a cell by A1 address (row 1 is the header row);
 * - `data("Parts", "Length", 3)` — a column by header (or letter, or 1-based number) and a
 *   1-based data row;
 * - `lookup("Parts", "Name", "Bracket", "Length")` — `Length` of the first row whose `Name` is
 *   `Bracket` (text matches exactly, then ignoring case; numbers match numerically);
 * - `count("Parts")` — the data rows; `count("Parts", "Length")` — the non-empty cells of a column;
 * - `sum("Parts", "Length")` — a column's total.
 *
 * Tables are named `"Source"` (its first table) or `"Source/Sheet"`. A number cell is unitless and
 * takes the unit of the slot it lands in, like a literal; text with a unit suffix ("12 mm", "2 in",
 * "30 deg") carries that unit (see `parseDataQuantity`). A missing table, row or cell, or a cell
 * that is not a number, is the expression's error — the feature reports it like any other.
 */

export const DATA_FUNCTION_NAMES = ["data", "lookup", "count", "sum"] as const;

type Args = readonly ExpressionArgument[];

function textArg(fn: string, args: Args, index: number, what: string): Result<string> {
    const value = args[index];
    return typeof value === "string" ? Result.ok(value) : Result.err(`${fn}() expects ${what} in quotes`);
}

function tableArg(
    fn: string,
    args: Args,
    context: ExpressionFunctionContext,
): Result<{ name: string; table: DataTable }> {
    const name = textArg(fn, args, 0, "a table name");
    if (!name.isOk) return Result.err(name.error);
    if (context.document === undefined)
        return Result.err(`${fn}(): data tables are only available in a document`);
    const table = cachedTable(context, name.value);
    return table.isOk ? Result.ok({ name: name.value, table: table.value }) : Result.err(table.error);
}

/**
 * Tables found per scope: a document scope carries a `token` of every table's revision, so for
 * one scope a reference always finds the same table — and a rebuild evaluating many `data()`
 * calls walks the document's nodes once per table, not once per call.
 */
const tableCache = new WeakMap<Scope, Map<string, Result<DataTable>>>();

function cachedTable(context: ExpressionFunctionContext, reference: string): Result<DataTable> {
    const document = context.document;
    if (document === undefined) return Result.err("no document");
    if (scopeContext(context.scope)?.token === undefined) return findDataTable(document, reference);
    let tables = tableCache.get(context.scope);
    if (tables === undefined) {
        tables = new Map();
        tableCache.set(context.scope, tables);
    }
    let table = tables.get(reference);
    if (table === undefined) {
        table = findDataTable(document, reference);
        tables.set(reference, table);
    }
    return table;
}

/** A column: a header or letters (text), or a 1-based column number. */
function columnArg(
    fn: string,
    table: { name: string; table: DataTable },
    value: ExpressionArgument | undefined,
): Result<number> {
    if (value === undefined) return Result.err(`${fn}() expects a column`);
    if (typeof value === "string") {
        const index = dataTableColumn(table.table, value);
        if (index !== undefined) return Result.ok(index);
        return Result.err(
            `${table.name} has no column "${value}" (columns: ${table.table.columns.join(", ")})`,
        );
    }
    const index = wholeNumber(value);
    if (index === undefined || index < 1 || index > table.table.columns.length) {
        return Result.err(`${fn}(): column ${value.value} is not a column of ${table.name}`);
    }
    return Result.ok(index - 1);
}

function wholeNumber(value: EvaluatedValue): number | undefined {
    const rounded = Math.round(value.value);
    return Math.abs(rounded - value.value) < 1e-9 && unitSpecEquals(value.unit, UNITLESS)
        ? rounded
        : undefined;
}

function cellResult(label: string, cell: DataCell | undefined): Result<EvaluatedValue> {
    const value = dataCellValue(cell);
    return value.isOk ? value : Result.err(`${label}: ${value.error}`);
}

function data(args: Args, context: ExpressionFunctionContext): Result<EvaluatedValue> {
    const table = tableArg("data", args, context);
    if (!table.isOk) return Result.err(table.error);
    if (args.length === 2) {
        const cell = textArg("data", args, 1, 'a cell like "B3"');
        if (!cell.isOk) return Result.err(cell.error);
        const address = parseCellAddress(cell.value);
        if (address === undefined) {
            return Result.err(
                `data(): "${cell.value}" is not a cell like "B3" — for a column by header add the row: data("${table.value.name}", "${cell.value}", 1)`,
            );
        }
        const label = `${table.value.name}!${formatCellAddress(address)}`;
        const value = dataTableCell(table.value.table, address);
        if (value === undefined) return Result.err(`${label} is outside the table`);
        return cellResult(label, value);
    }
    const column = columnArg("data", table.value, args[1]);
    if (!column.isOk) return Result.err(column.error);
    const rowValue = args[2];
    const row = typeof rowValue === "string" ? undefined : wholeNumber(rowValue);
    if (row === undefined || row < 1) return Result.err("data(): the row must be a whole number from 1");
    const rows = table.value.table.rows;
    const label = `${table.value.name}!${table.value.table.columns[column.value]}[${row}]`;
    if (row > rows.length) return Result.err(`${label}: the table has ${rows.length} rows`);
    return cellResult(label, rows[row - 1][column.value]);
}

/** Whether a cell is the lookup key: text exactly then ignoring case, numbers numerically. */
function matches(cell: DataCell | undefined, key: ExpressionArgument): boolean {
    if (cell === null || cell === undefined) return false;
    if (typeof key === "string") return String(cell).trim() === key.trim();
    const value = dataCellValue(cell);
    return (
        value.isOk &&
        mergeUnitSpecs(value.value.unit, key.unit) !== undefined &&
        Math.abs(value.value.value - key.value) <= 1e-9 * Math.max(1, Math.abs(key.value))
    );
}

function lookup(args: Args, context: ExpressionFunctionContext): Result<EvaluatedValue> {
    const table = tableArg("lookup", args, context);
    if (!table.isOk) return Result.err(table.error);
    const keyColumn = columnArg("lookup", table.value, args[1]);
    if (!keyColumn.isOk) return Result.err(keyColumn.error);
    const valueColumn = columnArg("lookup", table.value, args[3]);
    if (!valueColumn.isOk) return Result.err(valueColumn.error);
    const key = args[2];
    const rows = table.value.table.rows;
    let index = rows.findIndex((row) => matches(row[keyColumn.value], key));
    if (index < 0 && typeof key === "string") {
        const wanted = key.trim().toLowerCase();
        index = rows.findIndex((row) => {
            const cell = row[keyColumn.value];
            return cell !== null && cell !== undefined && String(cell).trim().toLowerCase() === wanted;
        });
    }
    const columns = table.value.table.columns;
    const shownKey = typeof key === "string" ? key : String(key.value);
    const label = `${table.value.name}!${columns[valueColumn.value]}[${columns[keyColumn.value]}=${shownKey}]`;
    if (index < 0) return Result.err(`${label}: no row has ${columns[keyColumn.value]} = ${shownKey}`);
    return cellResult(label, rows[index][valueColumn.value]);
}

function count(args: Args, context: ExpressionFunctionContext): Result<EvaluatedValue> {
    const table = tableArg("count", args, context);
    if (!table.isOk) return Result.err(table.error);
    const rows = table.value.table.rows;
    if (args.length === 1) return Result.ok({ value: rows.length, unit: UNITLESS });
    const column = columnArg("count", table.value, args[1]);
    if (!column.isOk) return Result.err(column.error);
    const filled = rows.filter((row) => {
        const cell = row[column.value];
        return cell !== null && cell !== undefined && !(typeof cell === "string" && cell.trim() === "");
    }).length;
    return Result.ok({ value: filled, unit: UNITLESS });
}

function sum(args: Args, context: ExpressionFunctionContext): Result<EvaluatedValue> {
    const table = tableArg("sum", args, context);
    if (!table.isOk) return Result.err(table.error);
    const column = columnArg("sum", table.value, args[1]);
    if (!column.isOk) return Result.err(column.error);
    const name = table.value.table.columns[column.value];
    let total = 0;
    let unit: UnitSpec = UNITLESS;
    for (const [index, row] of table.value.table.rows.entries()) {
        const cell = row[column.value];
        if (cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "")) continue;
        const value = cellResult(`${table.value.name}!${name}[${index + 1}]`, cell);
        if (!value.isOk) return value;
        const merged = mergeUnitSpecs(unit, value.value.unit);
        if (merged === undefined) {
            return Result.err(
                `sum(): ${table.value.name}!${name} mixes ${unitSpecLabel(unit)} with ${unitSpecLabel(value.value.unit)}`,
            );
        }
        unit = merged;
        total += value.value.value;
    }
    return Result.ok({ value: total, unit });
}

/** Adds the data functions to every expression; disposing removes them. */
export function registerDataFunctions(): IDisposable {
    const registrations = [
        registerExpressionFunction("data", data, { minArgs: 2, maxArgs: 3 }),
        registerExpressionFunction("lookup", lookup, { minArgs: 4, maxArgs: 4 }),
        registerExpressionFunction("count", count, { minArgs: 1, maxArgs: 2 }),
        registerExpressionFunction("sum", sum, { minArgs: 2, maxArgs: 2 }),
    ];
    return {
        dispose: () => {
            for (const registration of registrations) registration.dispose();
        },
    };
}

// ------------------------------------------------------------------ Static references

/** One data reference written in an expression (or a FeatureScript source). */
export interface DataReference {
    /** `data`, `lookup`, `count`, `sum`, or `getDataTable` (FeatureScript). */
    readonly fn: string;
    /** The table reference as written: `"Prices"`, `"Book/Sheet2"`. */
    readonly table: string;
    /** How the report shows it: `Prices!B3`, `Parts!Length[3]`, `Parts!Length[Name=Bracket]`. */
    readonly label: string;
}

type Token = { kind: "text" | "number" | "name" | "punct"; value: string };

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let pos = 0;
    while (pos < source.length) {
        const ch = source[pos];
        if (/\s/.test(ch)) {
            pos++;
        } else if (ch === '"' || ch === "'") {
            let value = "";
            pos++;
            while (pos < source.length && source[pos] !== ch) {
                if (source[pos] === "\\" && pos + 1 < source.length) pos++;
                value += source[pos++];
            }
            pos++;
            tokens.push({ kind: "text", value });
        } else if (/[A-Za-z_]/.test(ch)) {
            const name = /^[A-Za-z_]\w*/.exec(source.slice(pos))?.[0] ?? ch;
            tokens.push({ kind: "name", value: name });
            pos += name.length;
        } else if (/[\d.]/.test(ch)) {
            const number = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(source.slice(pos))?.[0] ?? ch;
            tokens.push({ kind: "number", value: number });
            pos += number.length;
        } else {
            tokens.push({ kind: "punct", value: ch });
            pos++;
        }
    }
    return tokens;
}

/** The top-level arguments of the call whose `(` is at `open`: a lone text or number, else undefined. */
function callArguments(tokens: Token[], open: number): (string | number | undefined)[] {
    const args: (string | number | undefined)[] = [];
    let depth = 0;
    let current: Token[] = [];
    const flush = () => {
        const only = current.length === 1 ? current[0] : undefined;
        args.push(
            only?.kind === "text" ? only.value : only?.kind === "number" ? Number(only.value) : undefined,
        );
        current = [];
    };
    for (let i = open + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind === "punct" && token.value === "(") depth++;
        if (token.kind === "punct" && token.value === ")") {
            if (depth === 0) {
                if (current.length > 0 || args.length > 0) flush();
                return args;
            }
            depth--;
        }
        if (depth === 0 && token.kind === "punct" && token.value === ",") flush();
        else current.push(token);
    }
    if (current.length > 0) flush();
    return args;
}

const show = (value: string | number | undefined) => (value === undefined ? "?" : String(value));

function referenceLabel(fn: string, table: string, args: readonly (string | number | undefined)[]): string {
    switch (fn) {
        case "data":
            return args.length >= 3
                ? `${table}!${show(args[1])}[${show(args[2])}]`
                : `${table}!${show(args[1])}`;
        case "lookup":
            return `${table}!${show(args[3])}[${show(args[1])}=${show(args[2])}]`;
        case "count":
            return args.length >= 2 ? `${table}!${show(args[1])} (count)` : `${table} (count)`;
        default:
            return `${table}!${show(args[1])} (sum)`;
    }
}

/** The data references an expression makes — those whose table is written as a literal. */
export function extractDataReferences(expression: string): DataReference[] {
    if (!DATA_FUNCTION_NAMES.some((name) => expression.includes(name))) return [];
    const tokens = tokenize(expression);
    const references: DataReference[] = [];
    tokens.forEach((token, index) => {
        if (token.kind !== "name" || !(DATA_FUNCTION_NAMES as readonly string[]).includes(token.value))
            return;
        const next = tokens[index + 1];
        if (next?.kind !== "punct" || next.value !== "(") return;
        const args = callArguments(tokens, index + 1);
        const table = args[0];
        if (typeof table !== "string") return;
        references.push({ fn: token.value, table, label: referenceLabel(token.value, table, args) });
    });
    return references;
}

/** `getDataTable(context, "Parts")` calls of a FeatureScript source. */
export function extractFeatureScriptReferences(source: string): DataReference[] {
    if (!source.includes("getDataTable")) return [];
    const references: DataReference[] = [];
    for (const match of source.matchAll(/getDataTable\s*\(\s*[^,()]+,\s*"((?:[^"\\]|\\.)*)"/g)) {
        references.push({ fn: "getDataTable", table: match[1], label: `${match[1]} (FeatureScript)` });
    }
    return references;
}
