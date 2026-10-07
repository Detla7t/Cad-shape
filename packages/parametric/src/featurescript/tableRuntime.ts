// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IShape } from "@chili3d/core";
import { FsContext } from "./context/fsContext";
import { FsThrow } from "./lang/errors";
import type { Interpreter, TableExport } from "./lang/interpreter";
import {
    ANGLE,
    AREA,
    FsArray,
    FsEnumValue,
    FsMap,
    FsQuantity,
    type FsValue,
    LENGTH,
    toDisplayString,
    typeName,
    type Units,
    unitsEqual,
    unitsLabel,
    VOLUME,
} from "./lang/values";
import { describeError } from "./runtime";
import { expandTemplate } from "./std/table";

/**
 * Runs a custom table (Onshape's `defineTable`) against the Part Studio — the
 * document's parts as the bodies of a fresh context — and turns the `Table` or
 * `TableArray` it returns into plain data a panel renders: every cell is display text,
 * quantities in app units (mm, deg, mm², mm³), `TemplateString`s expanded. A failure
 * of any kind (a precondition, a regen error, a malformed table) comes back as the
 * result's `error`, never thrown.
 */

export type TableAlignment = "LEFT" | "CENTER" | "RIGHT";

export interface TableColumnData {
    readonly id: string;
    readonly name: string;
    /** Absent for the default (left) alignment. */
    readonly alignment?: TableAlignment;
}

export interface TableCellData {
    readonly text: string;
    /** Set for a `TableCellError`: the message its tooltip shows. */
    readonly error?: string;
    /** Set for a `TableCellWithInfo`. */
    readonly info?: string;
}

export interface TableRowData {
    /** One cell per column id (an empty text for a column the row does not fill). */
    readonly cells: Readonly<Record<string, TableCellData>>;
}

export interface TableData {
    readonly title: string;
    readonly columns: readonly TableColumnData[];
    readonly rows: readonly TableRowData[];
}

export interface TableRunResult {
    /** One table, or several for a `TableArray`; empty when the run failed. */
    readonly tables: readonly TableData[];
    readonly error?: string;
    readonly line?: number;
    readonly column?: number;
}

/** A part of the Part Studio as a table sees it: world-space geometry and its name. */
export interface TableHostBody {
    readonly shape: IShape;
    readonly name: string;
}

export interface TableFormatOptions {
    /** Decimal places of numbers and quantities (trailing zeros dropped). Default 3. */
    readonly precision?: number;
}

export interface TableRun {
    readonly interpreter: Interpreter;
    readonly table: TableExport;
    /** The Part Studio's parts, in order; the run never disposes them. */
    readonly bodies: readonly TableHostBody[];
    /** The table's `definition`, in native values (`adaptHostValue` converts for Onshape's std). */
    readonly definition: FsMap;
    readonly variables?: ReadonlyMap<string, FsValue>;
    /** Which of `variables` are configuration variables. */
    readonly configurationVariables?: ReadonlySet<string>;
    readonly format?: TableFormatOptions;
}

export function runTable(run: TableRun): TableRunResult {
    const context = new FsContext();
    try {
        for (const body of run.bodies) context.addHostBody(body.shape).name = body.name;
        for (const [name, value] of run.variables ?? []) context.variables.set(name, value);
        for (const name of run.configurationVariables ?? []) context.configurationVariables.add(name);
        run.interpreter.resetBudget();
        const definition = run.interpreter.adaptHostValue(run.definition);
        const callable =
            run.table.module.exports.get(run.table.name) ??
            run.table.module.env.lookup(run.table.name)?.value;
        const output = run.interpreter.callFunction(callable, [context.value, definition]);
        return { tables: tableData(output, new TableFormatter(run.format?.precision ?? 3)) };
    } catch (error) {
        return { tables: [], ...describeFailure(error) };
    } finally {
        context.dispose();
    }
}

/** A thrown `regenError` reads as its message (custom text, else the error enum in words). */
function describeFailure(error: unknown): { error: string; line?: number; column?: number } {
    const described = describeError(error);
    if (!(error instanceof FsThrow) || !(error.value instanceof FsMap)) return described;
    const custom = error.value.field("customMessage");
    if (typeof custom === "string" && custom !== "") return { ...described, error: custom };
    const message = error.value.field("message");
    if (typeof message === "string" && message !== "") return { ...described, error: message };
    if (message instanceof FsEnumValue) {
        const words = message.name.toLowerCase().replace(/_/g, " ");
        return { ...described, error: words.charAt(0).toUpperCase() + words.slice(1) };
    }
    return described;
}

// ------------------------------------------------------------------ Normalizing the output

/** A Table map: `{ title, columnDefinitions, rows }` — tagged by std's constructors, or built by hand. */
function isTable(value: FsValue): value is FsMap {
    return (
        value instanceof FsMap &&
        value.field("columnDefinitions") instanceof FsArray &&
        value.field("rows") instanceof FsArray
    );
}

function tableData(output: FsValue, format: TableFormatter): TableData[] {
    if (isTable(output)) return [format.table(output)];
    if (output instanceof FsArray) {
        return output.items.map((item, i) => {
            if (!isTable(item)) throw new Error(`Table ${i + 1} of the TableArray is a ${typeName(item)}`);
            return format.table(item);
        });
    }
    throw new Error(`The table function must return a Table or a TableArray, got ${typeName(output)}`);
}

const ALIGNMENTS = new Set<string>(["LEFT", "CENTER", "RIGHT"]);

class TableFormatter {
    constructor(private readonly precision: number) {}

    table(table: FsMap): TableData {
        const columns = (table.field("columnDefinitions") as FsArray).items.map((column, i) =>
            this.column(column, i),
        );
        const rows = (table.field("rows") as FsArray).items.map((row, i) => {
            const cells = row instanceof FsMap ? row.field("columnIdToCell") : undefined;
            if (!(cells instanceof FsMap))
                throw new Error(`Row ${i + 1} of the table has no columnIdToCell map`);
            const record: Record<string, TableCellData> = {};
            for (const column of columns) record[column.id] = this.cell(cells.field(column.id));
            return { cells: record };
        });
        return { title: this.text(table.field("title")), columns, rows };
    }

    private column(column: FsValue, index: number): TableColumnData {
        const id = column instanceof FsMap ? column.field("id") : undefined;
        if (typeof id !== "string") throw new Error(`Column ${index + 1} of the table has no string id`);
        const name = this.text((column as FsMap).field("name"));
        const value = (column as FsMap).field("alignment");
        const alignment = value instanceof FsEnumValue ? value.name : value;
        return typeof alignment === "string" && ALIGNMENTS.has(alignment) && alignment !== "LEFT"
            ? { id, name, alignment: alignment as TableAlignment }
            : { id, name };
    }

    private cell(value: FsValue): TableCellData {
        if (value instanceof FsMap && value.has("value") && !value.has("template")) {
            if (value.tag === "TableCellError" || (value.has("error") && value.tag === undefined))
                return { text: this.text(value.field("value")), error: this.text(value.field("error")) };
            if (value.tag === "TableCellWithInfo" || (value.has("info") && value.tag === undefined))
                return { text: this.text(value.field("value")), info: this.text(value.field("info")) };
        }
        return { text: this.text(value) };
    }

    /** A table value as display text. */
    text(value: FsValue): string {
        if (value === undefined) return "";
        if (typeof value === "string") return value;
        if (typeof value === "number") return decimal(value, this.precision, false);
        if (typeof value === "boolean") return String(value);
        if (value instanceof FsEnumValue) return value.name;
        const quantity = quantityOf(value);
        if (quantity !== undefined) return formatQuantity(quantity, this.precision, false);
        if (value instanceof FsMap) {
            if (typeof value.field("template") === "string")
                return expandTemplate(value, (field) => this.text(field));
            const precision = value.field("precision");
            const inner = quantityOf(value.field("value"));
            if (typeof precision === "number" && inner !== undefined)
                return formatQuantity(inner, Math.max(0, Math.round(precision)), true);
            const components = value.field("components");
            if (components instanceof FsArray) return components.items.map((c) => this.component(c)).join("");
        }
        if (value instanceof FsArray) return value.items.map((item) => this.text(item)).join(", ");
        return toDisplayString(value);
    }

    /** One part of a `StringWithTolerances`, as std's `toString` renders it. */
    private component(value: FsValue): string {
        if (!(value instanceof FsMap) || !value.has("upper")) return this.text(value);
        const upper = this.text(value.field("upper"));
        const lower = this.text(value.field("lower"));
        const tolerance = [upper === "" ? [] : [`upper: ${upper}`], lower === "" ? [] : [`lower: ${lower}`]]
            .flat()
            .join(", ");
        const text = this.text(value.field("value"));
        return tolerance === "" ? text : `${text} [${tolerance}]`;
    }
}

/** A quantity in either std: a native one, or Onshape's std `ValueWithUnits` map. */
function quantityOf(value: FsValue): { value: number; units: Units } | undefined {
    if (value instanceof FsQuantity) return value;
    if (!(value instanceof FsMap)) return undefined;
    const magnitude = value.field("value");
    const unit = value.field("unit");
    if (typeof magnitude !== "number" || !(unit instanceof FsMap)) return undefined;
    const exponent = (key: string) => {
        const e = unit.field(key);
        return typeof e === "number" ? e : 0;
    };
    return {
        value: magnitude,
        units: {
            meter: exponent("meter"),
            radian: exponent("radian"),
            kilogram: exponent("kilogram"),
            second: exponent("second"),
        },
    };
}

/** App display units: lengths, areas and volumes in millimetres, angles in degrees; the rest in SI. */
const APP_UNITS: readonly { units: Units; scale: number; symbol: string }[] = [
    { units: LENGTH, scale: 1e3, symbol: "mm" },
    { units: AREA, scale: 1e6, symbol: "mm²" },
    { units: VOLUME, scale: 1e9, symbol: "mm³" },
    { units: ANGLE, scale: 180 / Math.PI, symbol: "deg" },
];

export function formatQuantity(
    quantity: { value: number; units: Units },
    precision: number,
    keepZeros: boolean,
): string {
    const unit = APP_UNITS.find((candidate) => unitsEqual(candidate.units, quantity.units));
    if (unit === undefined)
        return `${decimal(quantity.value, precision, keepZeros)} ${unitsLabel(quantity.units)}`;
    return `${decimal(quantity.value * unit.scale, precision, keepZeros)} ${unit.symbol}`;
}

/** `value` to `precision` decimals; trailing zeros dropped unless kept; never "-0". */
function decimal(value: number, precision: number, keepZeros: boolean): string {
    if (!Number.isFinite(value)) return String(value);
    let text = value.toFixed(Math.min(Math.max(precision, 0), 20));
    if (!keepZeros && text.includes(".")) text = text.replace(/\.?0+$/, "");
    if (/^-0(\.0*)?$/.test(text)) text = text.slice(1);
    return text;
}
