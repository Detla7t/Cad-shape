// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * FeatureScript custom tables (`defineTable`), on BOTH standard libraries: a table runs
 * against the Part Studio's parts as a fresh context, its precondition yields the same
 * parameter spec a feature's does, and its `Table` / `TableArray` output comes back as
 * plain display data — quantities in app units, template strings expanded, error cells
 * flagged — with every failure reported as data. Then the document side: the tables a
 * document's studios export, run over its visible parts in world space.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditableShapeNode, type IShape, Matrix4, Plane, Transaction } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import {
    customTableParameters,
    customTables,
    evaluateCustomTable,
    partStudioNodes,
} from "../../src/featurescript/customTables";
import { plainDefinition } from "../../src/featurescript/featureScriptFeature";
import { analyzeTable } from "../../src/featurescript/featureSpec";
import { FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import type { Interpreter, TableExport } from "../../src/featurescript/lang/interpreter";
import { FsMap, FsQuantity, LENGTH } from "../../src/featurescript/lang/values";
import { createNativeInterpreter } from "../../src/featurescript/nativeStd";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { provideOnshapeStd } from "../../src/featurescript/runtime";
import { runTable, type TableData, type TableHostBody } from "../../src/featurescript/tableRuntime";
import { TablesPanel } from "../../src/featurescript/ui/tablesPanel";
import style from "../../src/featurescript/ui/tablesPanel.module.css";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

const STDS = ["onshape", "native"] as const;
type Std = (typeof STDS)[number];
let interpreters: Record<Std, Interpreter>;

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    interpreters = {
        onshape: createOnshapeInterpreter({ std: ONSHAPE_STD }),
        native: createNativeInterpreter(),
    };
});

const HEADER = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
`;

/** Name, volume and a size check per part — Onshape's canonical parts table. */
const PART_VOLUMES = `${HEADER}
annotation { "Table Type Name" : "Part volumes" }
export const partVolumes = defineTable(function(context is Context, definition is map) returns Table
    precondition
    {
        annotation { "Name" : "Minimum size" }
        isLength(definition.minSize, NONNEGATIVE_LENGTH_BOUNDS);
    }
    {
        const columns = [
                tableColumnDefinition("name", "Part"),
                tableColumnDefinition("volume", "Volume", TableTextAlignment.RIGHT),
                tableColumnDefinition("check", "Check", TableTextAlignment.CENTER)
            ];
        const minimum = definition.minSize ^ 3;
        var rows = [];
        for (var part in evaluateQuery(context, qAllModifiableSolidBodies()))
        {
            const volume = evVolume(context, { "entities" : part });
            var check = "ok";
            if (volume < minimum)
            {
                check = tableCellError("too small", templateString({ "template" : "Under #minimum", "minimum" : minimum }));
            }
            rows = append(rows, tableRow({
                        "name" : getProperty(context, { "entity" : part, "propertyType" : PropertyType.NAME }),
                        "volume" : volume,
                        "check" : check
                    }));
        }
        return table(templateString({ "template" : "Parts (#count)", "count" : size(rows) }), columns, rows);
    });
`;

const PART_VOLUMES_DATA: TableData = {
    title: "Parts (2)",
    columns: [
        { id: "name", name: "Part" },
        { id: "volume", name: "Volume", alignment: "RIGHT" },
        { id: "check", name: "Check", alignment: "CENTER" },
    ],
    rows: [
        {
            cells: {
                name: { text: "Small" },
                volume: { text: "1000 mm³" },
                check: { text: "too small", error: "Under 8000 mm³" },
            },
        },
        { cells: { name: { text: "Large" }, volume: { text: "24000 mm³" }, check: { text: "ok" } } },
    ],
};

/** A precondition with a length, an enum, a boolean and a conditional string. */
const SETTINGS = `${HEADER}
export enum ReportUnit
{
    annotation { "Name" : "Millimeters" }
    MM,
    annotation { "Name" : "Inches" }
    IN
}

annotation { "Table Type Name" : "Settings" }
export const settings = defineTable(function(context is Context, definition is map) returns Table
    precondition
    {
        annotation { "Name" : "Clearance" }
        isLength(definition.clearance, LENGTH_BOUNDS);

        annotation { "Name" : "Unit" }
        definition.unit is ReportUnit;

        annotation { "Name" : "Show label", "Default" : true }
        definition.labelled is boolean;

        if (definition.labelled)
        {
            annotation { "Name" : "Label" }
            definition.label is string;
        }
    }
    {
        const columns = [tableColumnDefinition("key", "Key"), tableColumnDefinition("value", "Value")];
        return table("Settings", columns, [
                    tableRow({ "key" : "clearance", "value" : definition.clearance }),
                    tableRow({ "key" : "unit", "value" : toString(definition.unit) }),
                    tableRow({ "key" : "label", "value" : definition.labelled ? definition.label : "-" })
                ]);
    });
`;

const TWO_TABLES = `${HEADER}
annotation { "Table Type Name" : "Two tables" }
export const twoTables = defineTable(function(context is Context, definition is map) returns TableArray
    {
        const columns = [tableColumnDefinition("n", "N")];
        return tableArray([
                    table("Numbers", columns, [tableRow({ "n" : 1 }), tableRow({ "n" : 1.23456 }), tableRow({})]),
                    table("Quantities", columns, [
                                tableRow({ "n" : 45 * degree }),
                                tableRow({ "n" : (2 * millimeter) ^ 2 }),
                                tableRow({ "n" : tableCellWithInfo(2 * inch, "two inches") }),
                                tableRow({ "n" : templateString({ "template" : "w = #w ##1# !", "w" : valueWithUnitsAndPrecision(inch, 2) }) })
                            ])
                ]);
    });
`;

const FAILURES = `${HEADER}
annotation { "Table Type Name" : "Throws" }
export const throws = defineTable(function(context is Context, definition is map)
    {
        throw regenError("Nothing to list");
    });

annotation { "Table Type Name" : "Not a table" }
export const notATable = defineTable(function(context is Context, definition is map)
    {
        return 42;
    });

annotation { "Table Type Name" : "Needs a length" }
export const needsLength = defineTable(function(context is Context, definition is map)
    precondition
    {
        isLength(definition.size, LENGTH_BOUNDS);
    }
    {
        return table("Size", [], []);
    });
`;

let studioCount = 0;

function load(std: Std, source: string) {
    return interpreters[std].load({ path: `tableStudio${studioCount++}`, source });
}

function exportedTable(std: Std, source: string, name: string): TableExport {
    const table = load(std, source).table(name);
    if (table === undefined) throw new Error(`The studio exports no table "${name}"`);
    return table;
}

function box(dx: number, dy: number, dz: number): IShape {
    const shape = shapeFactory.box(Plane.XY, dx, dy, dz);
    expect(shape.isOk).toBe(true);
    return shape.value;
}

let parts: TableHostBody[];

beforeAll(() => {
    parts = [
        { shape: box(10, 10, 10), name: "Small" },
        { shape: box(20, 30, 40), name: "Large" },
    ];
});

afterAll(() => {
    for (const part of parts) part.shape.dispose();
});

const length = (mm: number) => new FsQuantity(mm / 1000, LENGTH);

describe.each(STDS)("custom tables on the %s std", (std) => {
    test("the studio exports its annotated table", () => {
        const module = load(std, PART_VOLUMES);
        expect(module.tables.map((table) => [table.name, table.displayName])).toEqual([
            ["partVolumes", "Part volumes"],
        ]);
        expect(module.features).toEqual([]);
    });

    test("a parts table lists names, volumes and an error cell", () => {
        const table = exportedTable(std, PART_VOLUMES, "partVolumes");
        const result = runTable({
            interpreter: interpreters[std],
            table,
            bodies: parts,
            definition: new FsMap([["minSize", length(20)]]),
        });
        expect(result.error).toBeUndefined();
        expect(result.tables).toEqual([PART_VOLUMES_DATA]);
    });

    test("the precondition yields the parameter spec a feature's would", () => {
        const table = exportedTable(std, SETTINGS, "settings");
        const spec = analyzeTable(interpreters[std], table);
        expect(spec.displayName).toBe("Settings");
        expect(spec.definitionName).toBe("definition");
        expect(
            spec.parameters.map((p) => ({
                key: p.key,
                kind: p.kind,
                label: p.label,
                defaultValue: p.defaultValue,
                conditions: p.conditions.length,
            })),
        ).toEqual([
            { key: "clearance", kind: "length", label: "Clearance", defaultValue: 25, conditions: 0 },
            { key: "unit", kind: "enum", label: "Unit", defaultValue: "MM", conditions: 0 },
            { key: "labelled", kind: "boolean", label: "Show label", defaultValue: true, conditions: 0 },
            { key: "label", kind: "string", label: "Label", defaultValue: "", conditions: 1 },
        ]);
        expect(spec.parameters[1].options).toEqual([
            { value: "MM", label: "Millimeters" },
            { value: "IN", label: "Inches" },
        ]);

        // The spec's own conversion builds the definition the table runs on.
        const definition = plainDefinition(spec, { clearance: 1.5, unit: "IN", label: "Fit" }, new Map());
        expect(definition.error).toBeUndefined();
        const result = runTable({
            interpreter: interpreters[std],
            table,
            bodies: [],
            definition: definition.value,
        });
        expect(result.error).toBeUndefined();
        // Cells come in column order: key, value.
        expect(result.tables[0].rows.map((row) => Object.values(row.cells).map((cell) => cell.text))).toEqual(
            [
                ["clearance", "1.5 mm"],
                ["unit", "IN"],
                ["label", "Fit"],
            ],
        );
    });

    test("a TableArray becomes one table each; cells format in app units", () => {
        const table = exportedTable(std, TWO_TABLES, "twoTables");
        const result = runTable({
            interpreter: interpreters[std],
            table,
            bodies: [],
            definition: new FsMap(),
        });
        expect(result.error).toBeUndefined();
        const columns = [{ id: "n", name: "N" }];
        expect(result.tables).toEqual([
            {
                title: "Numbers",
                columns,
                rows: [
                    { cells: { n: { text: "1" } } },
                    { cells: { n: { text: "1.235" } } },
                    { cells: { n: { text: "" } } },
                ],
            },
            {
                title: "Quantities",
                columns,
                rows: [
                    { cells: { n: { text: "45 deg" } } },
                    { cells: { n: { text: "4 mm²" } } },
                    { cells: { n: { text: "50.8 mm", info: "two inches" } } },
                    { cells: { n: { text: "w = 25.40 mm #1!" } } },
                ],
            },
        ]);
    });

    test("toString renders a table and a template string as std does", () => {
        const module = load(
            std,
            `${HEADER}
export function show() returns string
{
    const rows = [tableRow({ "a" : templateString({ "template" : "x#y", "y" : 1 }), "b" : "long text" })];
    return toString(table("T", [tableColumnDefinition("a", "A"), tableColumnDefinition("b", "B")], rows));
}
`,
        );
        const show = module.env.lookup("show")?.value;
        expect(interpreters[std].callFunction(show, [])).toBe("T\nA |    B    \n------------\nx1|long text");
    });

    test.each([
        ["throws", /^Nothing to list$/],
        ["notATable", /must return a Table or a TableArray, got number/],
        ["needsLength", /precondition/i],
    ])("a failing table (%s) reports its error as data", (name, message) => {
        const table = exportedTable(std, FAILURES, name);
        const result = runTable({
            interpreter: interpreters[std],
            table,
            bodies: parts,
            definition: new FsMap(),
        });
        expect(result.tables).toEqual([]);
        expect(result.error).toMatch(message);
    });
});

// ------------------------------------------------------------------ Document tables

const PART_POSITIONS = `${HEADER}
annotation { "Table Type Name" : "Part positions" }
export const partPositions = defineTable(function(context is Context, definition is map) returns Table
    precondition
    {
        annotation { "Name" : "Offset" }
        isLength(definition.offset, ZERO_DEFAULT_LENGTH_BOUNDS);
    }
    {
        var rows = [];
        for (var part in evaluateQuery(context, qAllModifiableSolidBodies()))
        {
            rows = append(rows, tableRow({
                        "name" : getProperty(context, { "entity" : part, "propertyType" : PropertyType.NAME }),
                        "x" : evApproximateCentroid(context, { "entities" : part })[0] + definition.offset
                    }));
        }
        return table("Positions", [tableColumnDefinition("name", "Part"), tableColumnDefinition("x", "Centroid X")], rows);
    });
`;

describe("custom tables in a document", () => {
    beforeAll(() => provideOnshapeStd(ONSHAPE_STD));
    afterAll(() => provideOnshapeStd(undefined));
    afterEach(() => {
        rs.useRealTimers();
    });

    function newDoc(): TestDocument {
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc);
        return doc;
    }

    function addPart(doc: TestDocument, name: string, shape: IShape): EditableShapeNode {
        const node = new EditableShapeNode({ document: doc, name, shape });
        doc.modelManager.addNode(node);
        return node;
    }

    function addStudio(doc: TestDocument, name: string, source: string): FeatureStudioNode {
        const studio = new FeatureStudioNode({ document: doc, name, source });
        doc.modelManager.addNode(studio);
        return studio;
    }

    test("customTables lists the tables every compiling studio exports", () => {
        const doc = newDoc();
        const volumes = addStudio(doc, "Volumes", PART_VOLUMES);
        const positions = addStudio(doc, "Positions", PART_POSITIONS);
        addStudio(doc, "Broken", `${HEADER}export const x = ;`);
        expect(customTables(doc).map((entry) => [entry.studio, entry.tableName, entry.displayName])).toEqual([
            [volumes, "partVolumes", "Part volumes"],
            [positions, "partPositions", "Part positions"],
        ]);
        expect(customTables(doc, positions).map((entry) => entry.tableName)).toEqual(["partPositions"]);
    });

    test("a table runs over the visible parts, in world space, with expression parameters", () => {
        const doc = newDoc();
        Transaction.execute(doc, "vars", () =>
            doc.variables.setItems([{ id: "v", name: "gap", type: "length", expression: "1" }]),
        );
        const studio = addStudio(doc, "Positions", PART_POSITIONS);
        const small = addPart(doc, "Small", box(10, 10, 10));
        const large = addPart(doc, "Large", box(20, 30, 40));
        const hidden = addPart(doc, "Hidden", box(5, 5, 5));
        large.transform = Matrix4.fromTranslation(100, 0, 0);
        hidden.visible = false;
        expect(partStudioNodes(doc)).toEqual([small, large]);

        expect(
            customTableParameters(doc, studio.id, "partPositions").map((p) => [p.key, p.label, p.value]),
        ).toEqual([["offset", "Offset", 0]]);
        const result = evaluateCustomTable(doc, studio.id, "partPositions", { offset: "gap * 2" });
        expect(result.error).toBeUndefined();
        expect(result.tables[0].rows).toEqual([
            { cells: { name: { text: "Small" }, x: { text: "7 mm" } } },
            { cells: { name: { text: "Large" }, x: { text: "112 mm" } } },
        ]);
        // The run leaves the parts' own shapes alive.
        expect(large.shape.value.volume()).toBeCloseTo(24000, 6);
    });

    test("the tables panel renders the selected table and follows the document", () => {
        rs.useFakeTimers();
        const doc = newDoc();
        addStudio(doc, "Volumes", PART_VOLUMES);
        addPart(doc, "Small", box(10, 10, 10));
        const large = addPart(doc, "Large", box(20, 30, 40));
        const panel = new TablesPanel(doc);
        try {
            const cells = () => [...panel.output.querySelectorAll("td")].map((td) => td.textContent);
            expect(panel.select.value).toBe(`${customTables(doc)[0].studio.id}\u0000partVolumes`);
            expect(panel.output.querySelector(`.${style.title}`)?.textContent).toBe("Parts (2)");
            expect([...panel.output.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
                "Part",
                "Volume",
                "Check",
            ]);
            // Minimum size defaults to 25 mm: only the small part fails the check.
            expect(cells()).toEqual(["Small", "1000 mm³", "too small", "Large", "24000 mm³", "ok"]);
            const errorCells = [...panel.output.querySelectorAll<HTMLElement>(`td.${style.errorCell}`)];
            expect(errorCells.map((cell) => [cell.textContent, cell.title])).toEqual([
                ["too small", "Under 15625 mm³"],
            ]);

            // A parameter edit recomputes at once.
            const inputs = [...panel.parameters.querySelectorAll("input")];
            expect(inputs.map((input) => input.value)).toEqual(["25"]);
            inputs[0].value = "30";
            inputs[0].dispatchEvent(new Event("change"));
            expect(cells()).toEqual(["Small", "1000 mm³", "too small", "Large", "24000 mm³", "too small"]);

            // A document change recomputes once the burst settles.
            large.visible = false;
            expect(cells()).toHaveLength(6);
            rs.advanceTimersByTime(500);
            expect(cells()).toEqual(["Small", "1000 mm³", "too small"]);
        } finally {
            panel.dispose();
        }
        // Once closed, the panel no longer follows the document.
        large.visible = true;
        rs.advanceTimersByTime(500);
        expect(panel.output.querySelectorAll("tr")).toHaveLength(2);
    });

    test("studio, parameter and lookup failures come back as errors", () => {
        const doc = newDoc();
        const studio = addStudio(doc, "Positions", PART_POSITIONS);
        const broken = addStudio(doc, "Broken", `${HEADER}export const x = ;`);
        expect(evaluateCustomTable(doc, studio.id, "partPositions", { offset: "nope * 2" }).error).toMatch(
            /Offset/,
        );
        expect(evaluateCustomTable(doc, studio.id, "missing").error).toMatch(
            /no longer exports the table "missing"/,
        );
        expect(evaluateCustomTable(doc, broken.id, "x").error).toMatch(
            /Feature Studio "Broken" has an error/,
        );
        expect(evaluateCustomTable(doc, "gone", "x").error).toMatch(/was deleted/);
    });
});
