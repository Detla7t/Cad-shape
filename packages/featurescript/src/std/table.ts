// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    expectArray,
    expectMap,
    expectString,
    FsArray,
    FsEnumValue,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    fsMap,
    isCallable,
    toDisplayString,
    typeName,
    type UserFunction,
} from "../lang/values";
import { mergeMaps } from "./core";
import { arg, expectArgCount, type StdBuilder } from "./registry";

/**
 * Custom tables on the native std — the TypeScript counterpart of std's `table.fs`, with
 * the same value shapes: a `Table` is `{ title, columnDefinitions, rows }` tagged `Table`,
 * a column `{ id, name, alignment? }`, a row `{ columnIdToCell }`, an error cell
 * `{ value, error }`. Cells hold "table values": strings, numbers, `ValueWithUnits` and
 * `TemplateString`s, formatted for display by the host (`tableRuntime.ts`).
 */

const TABLE_VALUE_TAGS = new Set(["TemplateString", "StringWithTolerances", "ValueWithUnitsAndPrecision"]);

/** std's `isTableValue`: a string, a number, a `ValueWithUnits` or a `TemplateString` (or a tolerance string). */
export function isTableValue(value: FsValue): boolean {
    return (
        typeof value === "string" ||
        typeof value === "number" ||
        value instanceof FsQuantity ||
        (value instanceof FsMap && value.tag !== undefined && TABLE_VALUE_TAGS.has(value.tag))
    );
}

function expectTableValue(value: FsValue, what: string): FsValue {
    if (!isTableValue(value))
        fail(`${what} must be a string, number, ValueWithUnits or TemplateString, got ${typeName(value)}`);
    return value;
}

function isQuery(value: FsValue): boolean {
    return value instanceof FsMap && value.tag === "Query";
}

function expectQuery(value: FsValue, what: string): FsValue {
    if (!isQuery(value)) fail(`${what} must be a Query, got ${typeName(value)}`);
    return value;
}

function isAlignment(value: FsValue): value is FsEnumValue {
    return value instanceof FsEnumValue && value.type.name === "TableTextAlignment";
}

export function installTables(std: StdBuilder): void {
    for (const type of [
        "Table",
        "TableArray",
        "TableColumnDefinition",
        "TableRow",
        "TableCellError",
        "TableCellWithInfo",
        "TemplateString",
        "ValueWithUnitsAndPrecision",
        "StringWithTolerances",
    ]) {
        std.tagType(type);
    }
    std.enumType("TableTextAlignment", ["LEFT", "CENTER", "RIGHT"]);

    std.fn("defineTable", (args) => {
        const fn = arg(args, 0, "defineTable");
        if (!isCallable(fn) || fn.kind !== "user") fail("defineTable needs a function(context, definition)");
        if (fn.params.length !== 2) fail("A table function takes exactly (context, definition)");
        const defaults = args[1] === undefined ? undefined : expectMap(args[1], "defineTable defaults");
        return {
            kind: "native",
            name: fn.name,
            table: { fn: fn as UserFunction, defaults },
            impl: (callArgs, site) => {
                if (callArgs.length !== 2) fail("A table is called as table(context, definition)");
                const definition = expectMap(callArgs[1], "table definition");
                const merged = defaults === undefined ? definition : mergeMaps(defaults, definition);
                return site.call(fn, [callArgs[0], merged]);
            },
        };
    });

    std.fn("table", (args) => {
        expectArgCount(args, 3, 4, "table");
        const columnDefinitions = expectArray(args[1], "columnDefinitions");
        const rows = expectArray(args[2], "rows");
        columnDefinitions.items.forEach((column, i) => {
            if (!(column instanceof FsMap) || column.tag !== "TableColumnDefinition")
                fail(`columnDefinitions[${i}] must be a TableColumnDefinition, got ${typeName(column)}`);
        });
        rows.items.forEach((row, i) => {
            if (!(row instanceof FsMap) || row.tag !== "TableRow")
                fail(`rows[${i}] must be a TableRow, got ${typeName(row)}`);
        });
        return fsMap(
            {
                title: expectTableValue(args[0], "The table title"),
                columnDefinitions,
                rows,
                entities: args[3] === undefined ? undefined : expectQuery(args[3], "The table entities"),
            },
            "Table",
        );
    });

    std.fn("tableColumnDefinition", (args) => {
        expectArgCount(args, 2, 3, "tableColumnDefinition");
        const id = expectString(args[0], "The column id");
        const name = expectTableValue(args[1], "The column name");
        const third = args[2];
        if (third !== undefined && !isAlignment(third) && !isQuery(third))
            fail(`A column's third argument must be a TableTextAlignment or a Query, got ${typeName(third)}`);
        return fsMap(
            {
                id,
                name,
                alignment: isAlignment(third) ? third : undefined,
                entities: isQuery(third) ? third : undefined,
            },
            "TableColumnDefinition",
        );
    });

    std.fn("tableRow", (args) => {
        expectArgCount(args, 1, 2, "tableRow");
        const cells = expectMap(args[0], "columnIdToCell");
        for (const [key, value] of cells.pairs()) {
            if (typeof key !== "string") fail(`A row's column ids must be strings, got ${typeName(key)}`);
            const tag = value instanceof FsMap ? value.tag : undefined;
            if (!isTableValue(value) && tag !== "TableCellError" && tag !== "TableCellWithInfo")
                fail(`The cell "${key}" must be a table value or a TableCellError, got ${typeName(value)}`);
        }
        return fsMap(
            {
                columnIdToCell: cells,
                entities: args[1] === undefined ? undefined : expectQuery(args[1], "entities"),
            },
            "TableRow",
        );
    });

    std.fn("tableArray", (args) => {
        const tables = expectArray(arg(args, 0, "tableArray"), "tableArray argument");
        tables.items.forEach((item, i) => {
            if (!(item instanceof FsMap) || item.tag !== "Table")
                fail(`tableArray[${i}] must be a Table, got ${typeName(item)}`);
        });
        return new FsArray(tables.items, "TableArray");
    });

    std.fn("tableCellError", (args) => {
        expectArgCount(args, 2, 2, "tableCellError");
        return fsMap(
            {
                value: expectTableValue(args[0], "The cell value"),
                error: expectTableValue(args[1], "The cell error"),
            },
            "TableCellError",
        );
    });

    std.fn("tableCellWithInfo", (args) => {
        expectArgCount(args, 2, 2, "tableCellWithInfo");
        return fsMap(
            {
                value: expectTableValue(args[0], "The cell value"),
                info: expectTableValue(args[1], "The cell info"),
            },
            "TableCellWithInfo",
        );
    });

    std.fn("isTableValue", (args) => isTableValue(arg(args, 0, "isTableValue")));

    std.fn("templateString", (args) => {
        const value = expectMap(arg(args, 0, "templateString"), "templateString argument");
        expectString(value.field("template"), "The template");
        return new FsMap(value.pairs(), "TemplateString");
    });

    std.fn("valueWithUnitsAndPrecision", (args) => {
        expectArgCount(args, 2, 2, "valueWithUnitsAndPrecision");
        if (!(args[0] instanceof FsQuantity))
            fail(`The value must be a ValueWithUnits, got ${typeName(args[0])}`);
        if (typeof args[1] !== "number") fail(`The precision must be a number, got ${typeName(args[1])}`);
        return fsMap({ value: args[0], precision: args[1] }, "ValueWithUnitsAndPrecision");
    });

    // std's "individual parts" iteration; there are no composite parts here, so every
    // modifiable solid is its own part.
    std.fn("allSolidsAndClosedComposites", (args, site) => {
        const context = arg(args, 0, "allSolidsAndClosedComposites");
        const lookup = (name: string) => std.interpreter.std.lookup(name)?.value;
        const solids = site.call(lookup("qAllModifiableSolidBodies"), []);
        const parts = expectArray(site.call(lookup("evaluateQuery"), [context, solids]), "parts");
        return new FsArray(parts.items.map((part) => fsMap({ part, bodies: part })));
    });

    // `toString` of a TemplateString substitutes its fields, of a Table renders the grid —
    // as std's own overloads do; everything else keeps the core rendering.
    const base = std.interpreter.std.lookup("toString")?.value;
    std.fn("toString", (args, site) => {
        const value = arg(args, 0, "toString");
        if (value instanceof FsMap && value.tag === "TemplateString")
            return expandTemplate(value, toDisplayString);
        if (value instanceof FsMap && value.tag === "Table") return tableToString(value);
        return base === undefined ? toDisplayString(value) : site.call(base, args);
    });
}

/**
 * Expands a TemplateString: `#name` is the `name` field formatted by `format`, `##` is `#`,
 * and `# ` (number sign, space) is removed. Text after an unrecognized `#` stays as is.
 */
export function expandTemplate(template: FsMap, format: (value: FsValue) => string): string {
    const source = template.field("template");
    if (typeof source !== "string") return "";
    let result = "";
    let rest = source;
    while (true) {
        const match = /^([^#]*)#(#| |[a-zA-Z_][0-9a-zA-Z_]*)([\s\S]*)$/.exec(rest);
        if (match === null) return result + rest;
        result += match[1];
        if (match[2] === "#") result += "#";
        else if (match[2] !== " ") result += format(template.field(match[2]));
        rest = match[3];
    }
}

/** A cell (or title) as std's `toString` renders it — SI quantities, unformatted. */
function cellString(value: FsValue): string {
    if (value instanceof FsMap) {
        if (value.tag === "TemplateString") return expandTemplate(value, cellString);
        if (value.tag === "TableCellError" || value.tag === "TableCellWithInfo")
            return cellString(value.field("value"));
    }
    return toDisplayString(value);
}

/** std's `toString(table is Table)`: the title, then centered `|`-separated columns. */
function tableToString(table: FsMap): string {
    const columns = table.field("columnDefinitions");
    const rows = table.field("rows");
    const columnList = columns instanceof FsArray ? columns.items.filter((c) => c instanceof FsMap) : [];
    const ids = columnList.map((column) => String((column as FsMap).field("id")));
    const names = columnList.map((column) => cellString((column as FsMap).field("name")));
    const widths = names.map((name) => name.length);
    const texts = (rows instanceof FsArray ? rows.items : []).map((row) => {
        const cells = row instanceof FsMap ? row.field("columnIdToCell") : undefined;
        return ids.map((id, i) => {
            const text = cells instanceof FsMap ? cellString(cells.field(id)) : "undefined";
            widths[i] = Math.max(widths[i], text.length);
            return text;
        });
    });
    const pad = (text: string, width: number) => {
        const left = Math.floor((width - text.length) / 2);
        return text.length >= width ? text : " ".repeat(left) + text + " ".repeat(width - text.length - left);
    };
    const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1);
    const lines = [
        cellString(table.field("title")),
        names.map((name, i) => pad(name, widths[i])).join("|"),
        "-".repeat(total),
        ...texts.map((row) => row.map((text, i) => pad(text, widths[i])).join("|")),
    ];
    return lines.join("\n");
}
