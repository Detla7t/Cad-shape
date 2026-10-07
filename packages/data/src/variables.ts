// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type DataCell,
    type DataTable,
    dataCellValue,
    type IDocument,
    Id,
    isConstantName,
    isVariableType,
    LENGTH_UNITS,
    nextElementName,
    Result,
    Transaction,
    unitSpecEquals,
    type VariableData,
    VariableStudioNode,
    type VariableType,
} from "@chili3d/core";
import { cellText } from "./model/cells";

/**
 * "Import variables from table": rows of a name / value table become Variable Studio rows that
 * stay LINKED to it — each row's expression is `lookup("<table>", "<name column>", "<name>",
 * "<value column>")`, so a refreshed table re-values the variables, and reordering the table's
 * rows changes nothing. Re-importing updates the linked rows in place (same ids) and appends new
 * names; rows the user added by hand are kept.
 */

const NAME_PATTERN = /^[A-Za-z_]\w*$/;

/** Which columns hold what; found from the header row, else name, value = first, second. */
export interface VariableColumns {
    readonly name: number;
    readonly value: number;
    readonly type?: number;
    readonly description?: number;
}

const HEADER_HINTS: Record<keyof VariableColumns, readonly string[]> = {
    name: ["name", "variable", "parameter", "param", "key"],
    value: ["value", "expression", "val"],
    type: ["type", "kind"],
    description: ["description", "desc", "comment", "note", "notes"],
};

export function variableColumns(table: DataTable): VariableColumns {
    const find = (hints: readonly string[]) => {
        const index = table.columns.findIndex((column) => hints.includes(column.trim().toLowerCase()));
        return index < 0 ? undefined : index;
    };
    const name = find(HEADER_HINTS.name) ?? 0;
    const value = find(HEADER_HINTS.value) ?? (name === 0 ? 1 : 0);
    return { name, value, type: find(HEADER_HINTS.type), description: find(HEADER_HINTS.description) };
}

/** Text as an expression string literal. */
export function quoteText(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The linked expression of one variable row. */
export function linkedExpression(
    reference: string,
    table: DataTable,
    columns: VariableColumns,
    name: string,
): string {
    return `lookup(${quoteText(reference)}, ${quoteText(table.columns[columns.name])}, ${quoteText(name)}, ${quoteText(table.columns[columns.value])})`;
}

/** A type column's text, else the value's unit: a length, an angle — or, plain, a length. */
function typeOf(row: readonly DataCell[], columns: VariableColumns): VariableType {
    if (columns.type !== undefined) {
        const declared = String(row[columns.type] ?? "")
            .trim()
            .toLowerCase();
        if (isVariableType(declared)) return declared;
    }
    const value = dataCellValue(row[columns.value]);
    if (value.isOk && unitSpecEquals(value.value.unit, ANGLE_UNITS)) return "angle";
    if (value.isOk && unitSpecEquals(value.value.unit, LENGTH_UNITS)) return "length";
    return "length";
}

export interface VariableImport {
    readonly items: VariableData[];
    readonly added: number;
    readonly updated: number;
    /** Row names (or row numbers) that could not become variables, with why. */
    readonly skipped: string[];
}

/** Merges a table's rows into `existing` as linked variables (see the module comment). */
export function variablesFromTable(
    table: DataTable,
    reference: string,
    existing: readonly VariableData[],
    columns: VariableColumns = variableColumns(table),
): VariableImport {
    const items = [...existing];
    const skipped: string[] = [];
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;
    table.rows.forEach((row, index) => {
        const name = cellText(row[columns.name]).trim();
        if (name === "") return;
        if (!NAME_PATTERN.test(name) || isConstantName(name)) {
            skipped.push(`${name} (not a variable name)`);
            return;
        }
        if (seen.has(name)) {
            skipped.push(`${name} (repeated in row ${index + 1})`);
            return;
        }
        seen.add(name);
        const value = dataCellValue(row[columns.value]);
        if (!value.isOk) {
            skipped.push(`${name} (${value.error})`);
            return;
        }
        const expression = linkedExpression(reference, table, columns, name);
        const type = typeOf(row, columns);
        const description =
            columns.description === undefined ? undefined : cellText(row[columns.description]).trim();
        const at = items.findIndex((item) => item.name === name);
        const fields = { name, type, expression, ...(description ? { description } : {}) };
        if (at >= 0) {
            items[at] = { ...items[at], ...fields };
            updated++;
        } else {
            items.push({ id: Id.generate(), ...fields });
            added++;
        }
    });
    return { items, added, updated, skipped };
}

export interface ImportVariablesResult extends Omit<VariableImport, "items"> {
    readonly studio: VariableStudioNode;
}

/**
 * Imports `table` (referenced as `reference`) into `studio` — or a new Variable Studio named
 * after the table — as one undo step.
 */
export function importVariablesFromTable(
    document: IDocument,
    table: DataTable,
    reference: string,
    studio?: VariableStudioNode,
): Result<ImportVariablesResult> {
    if (table.columns.length < 2) return Result.err(`${reference} needs a name column and a value column`);
    let target = studio;
    let merged: VariableImport | undefined;
    Transaction.execute(document, "import variables", () => {
        if (target === undefined) {
            target = new VariableStudioNode({
                document,
                name: nextElementName(document, `${reference} variables`),
            });
            document.modelManager.addNode(target);
        }
        merged = variablesFromTable(table, reference, target.items);
        target.setItems(merged.items);
    });
    if (target === undefined || merged === undefined) return Result.err("The import did not run");
    return Result.ok({
        studio: target,
        added: merged.added,
        updated: merged.updated,
        skipped: merged.skipped,
    });
}
