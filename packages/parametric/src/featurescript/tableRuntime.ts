// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    documentQuantityUnit,
    documentUnits,
    type IDocument,
    type IShape,
    type QuantityKind,
    unitSuffix,
} from "@chili3d/core";
import {
    ANGLE,
    AREA,
    describeError,
    expandTemplate,
    FsArray,
    FsContext,
    type FsDataTableSource,
    FsEnumValue,
    FsMap,
    FsQuantity,
    FsThrow,
    type FsValue,
    type Interpreter,
    LENGTH,
    type TableExport,
    toDisplayString,
    typeName,
    type Units,
    unitsEqual,
    unitsLabel,
    VOLUME,
} from "@chili3d/featurescript";
// The engine runs here with parametric's history completion, sketch solver and loop rules.
import "./modelingHost";

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
    readonly document?: IDocument;
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
    /** The document's data tables, for `getDataTable`. */
    readonly dataTables?: FsDataTableSource;
    readonly format?: TableFormatOptions;
}

export function runTable(run: TableRun): TableRunResult {
    const context = new FsContext();
    try {
        for (const body of run.bodies) {
            for (const part of context.addHostBody(body.shape)) part.name = body.name;
        }
        for (const [name, value] of run.variables ?? []) context.variables.set(name, value);
        for (const name of run.configurationVariables ?? []) context.configurationVariables.add(name);
        context.dataTables = run.dataTables;
        run.interpreter.resetBudget();
        const definition = run.interpreter.adaptHostValue(run.definition);
        const callable =
            run.table.module.exports.get(run.table.name) ??
            run.table.module.env.lookup(run.table.name)?.value;
        const output = run.interpreter.callFunction(callable, [context.value, definition]);
        return {
            tables: tableData(output, new TableFormatter(run.format?.precision ?? 3, run.format?.document)),
        };
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
    constructor(
        private readonly precision: number,
        private readonly document?: IDocument,
    ) {}

    private quantity(value: { value: number; units: Units }, precision?: number, keepZeros = false): string {
        return this.document
            ? formatDocumentTableQuantity(value, this.document, precision, keepZeros)
            : formatQuantity(value, precision ?? this.precision, keepZeros);
    }

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
        if (quantity !== undefined) return this.quantity(quantity);
        if (value instanceof FsMap) {
            if (typeof value.field("template") === "string")
                return expandTemplate(value, (field) => this.text(field));
            const precision = value.field("precision");
            const inner = quantityOf(value.field("value"));
            if (typeof precision === "number" && inner !== undefined)
                return this.quantity(inner, Math.max(0, Math.round(precision)), true);
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

/** Custom-table display is localized at the boundary; FeatureScript values remain in SI. */
export function formatDocumentTableQuantity(
    quantity: { value: number; units: Units },
    document: IDocument,
    precision?: number,
    keepZeros = false,
): string {
    const { meter, radian, kilogram, second } = quantity.units;
    const settings = documentUnits(document);
    let suffix: string | undefined;
    let factor = 1;
    let decimals = precision ?? settings.lengthPrecision;
    if (!kilogram && !second && !radian && meter >= 1 && meter <= 3) {
        suffix = settings.length + (meter === 2 ? "²" : meter === 3 ? "³" : "");
        factor = (unitSuffix(settings.length)!.factor / 1000) ** meter;
    } else if (!kilogram && !second && !meter && radian === 1) {
        suffix = settings.angle;
        factor = settings.angle === "deg" ? Math.PI / 180 : 1;
        decimals = precision ?? settings.anglePrecision;
    } else {
        const key = `${meter},${radian},${kilogram},${second}`;
        const kind = (
            {
                "1,0,0,-2": "acceleration",
                "0,1,0,-1": "angularVelocity",
                "0,0,1,0": "mass",
                "-3,0,1,0": "density",
                "1,0,1,-2": "force",
                "0,0,0,-1": "frequency",
                "2,-1,1,-2": "moment",
                "-1,0,1,-2": "pressure",
                "2,0,1,-2": "energy",
            } as Record<string, QuantityKind>
        )[key];
        if (kind) {
            const unit = documentQuantityUnit(document, kind);
            suffix = unit.suffix;
            factor = unit.factor;
            decimals = precision ?? unit.precision;
        }
    }
    if (suffix === undefined) return formatQuantity(quantity, precision ?? 3, keepZeros);
    let text = decimal(quantity.value / factor, decimals, keepZeros);
    if (Config.instance.preferences.decimalComma) text = text.replace(".", ",");
    return `${text} ${suffix}`;
}

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
