// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    Id,
    type IVariableFeatureNode,
    Node,
    Transaction,
    type VariableData,
    VariableStudioNode,
} from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { PartStudioVariables } from "../src/property/variables/partStudioVariables";
import style from "../src/property/variables/variablesEditor.module.css";
import { VariableTablePanel } from "../src/sidebar/variableTablePanel";

/** A modeling feature contributing one variable, like `MeasuredVariableNode` does. */
class VariableFeature extends Node implements IVariableFeatureNode {
    readonly variableSource = true as const;
    constructor(
        document: IDocument,
        private row: Omit<VariableData, "id">,
    ) {
        super(document, `#${row.name}`, Id.generate());
    }
    get items(): readonly VariableData[] {
        return [{ id: this.id, ...this.row }];
    }
    get variablesJson(): string {
        return JSON.stringify(this.items);
    }
    get definitionJson(): string {
        return JSON.stringify(this.row);
    }
    set definitionJson(value: string) {
        this.setProperty("definitionJson", value, () => (this.row = JSON.parse(value)));
    }
    updateVariable(item: VariableData): void {
        this.definitionJson = JSON.stringify({ ...this.row, name: item.name, expression: item.expression });
    }
    protected onVisibleChanged(): void {}
    protected onParentVisibleChanged(): void {}
}

function fixture() {
    const doc = new TestDocument();
    doc.variables.setConfigurationInputs([
        {
            kind: "list",
            id: "od",
            name: "OD",
            options: [
                { id: "a", name: '4"' },
                { id: "b", name: '5"' },
            ],
            defaultOption: "a",
        },
    ]);
    const duct = new VariableFeature(doc, {
        name: "duct_od",
        type: "length",
        expression: 'configure(OD, "4\\"": 4 in, "5\\"": 5 in)',
    });
    const radius = new VariableFeature(doc, {
        name: "cap_radius",
        type: "length",
        expression: "duct_od / 2",
    });
    const measured = new VariableFeature(doc, {
        name: "Wall_Length",
        type: "length",
        expression: "271.2 mm",
        measured: true,
    });
    doc.modelManager.addNode(duct);
    doc.modelManager.addNode(radius);
    doc.modelManager.addNode(measured);
    doc.variables.setItems([{ id: "t1", name: "tab", type: "length", expression: "25.4 mm" }]);
    return { doc, duct, radius, measured };
}

/** The name column of every row but the empty new row. */
const rowsOf = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLInputElement>(`.${style.row} .${style.nameCell} input`)).map(
        (box) => box.value,
    );

describe("Part Studio variables", () => {
    test("lists variable features before the document table, in tree order", () => {
        const { doc } = fixture();
        const source = new PartStudioVariables(doc);
        try {
            expect(source.items.map((item) => item.name)).toEqual([
                "duct_od",
                "cap_radius",
                "Wall_Length",
                "tab",
            ]);
            expect(source.featureRow(source.items[0].id)).not.toBeUndefined();
            expect(source.featureRow("t1")).toBeUndefined();
        } finally {
            source.dispose();
            doc.dispose();
        }
    });

    test("writes feature rows into their feature, removes deleted features and keeps the table", () => {
        const { doc, duct, radius } = fixture();
        const source = new PartStudioVariables(doc);
        const changes: string[] = [];
        source.onPropertyChanged((property) => changes.push(property));
        try {
            const items = source.items;
            Transaction.execute(doc, "edit", () =>
                source.setItems([
                    { ...items[0], expression: 'configure(OD, "4\\"": 4.5 in, "5\\"": 5 in)' },
                    items[2],
                    items[3],
                    { id: "t2", name: "seam", type: "length", expression: "0" },
                ]),
            );
            expect(duct.items[0].expression).toBe('configure(OD, "4\\"": 4.5 in, "5\\"": 5 in)');
            expect(radius.parent).toBeUndefined();
            expect(doc.variables.items.map((item) => item.name)).toEqual(["tab", "seam"]);
            expect(changes).toContain("variablesJson");
            doc.history.undo();
            expect(radius.parent).not.toBeUndefined();
            expect(duct.items[0].expression).toBe('configure(OD, "4\\"": 4 in, "5\\"": 5 in)');
        } finally {
            source.dispose();
            doc.dispose();
        }
    });

    test("the configuration-dependent names follow configure() through other variables", () => {
        const { doc } = fixture();
        try {
            const names = doc.variables.configurationDependentNames();
            expect(names.has("OD")).toBe(true);
            expect(names.has("duct_od")).toBe(true);
            expect(names.has("cap_radius")).toBe(true);
            expect(names.has("tab")).toBe(false);
            expect(names.has("Wall_Length")).toBe(false);
        } finally {
            doc.dispose();
        }
    });
});

describe("Variable table panel", () => {
    test("shows the feature variables in the Part Studio group, measured ones read-only and configured ones outlined", () => {
        const { doc } = fixture();
        const panel = new VariableTablePanel(doc);
        document.body.append(panel.element);
        try {
            expect(rowsOf(panel.element)).toEqual(["duct_od", "cap_radius", "Wall_Length", "tab"]);
            const values = Array.from(
                panel.element.querySelectorAll<HTMLInputElement>("input[title]"),
            ).filter((box) => box.readOnly || box.title.length > 0);
            const wall = values.find((box) => box.title.includes("271.2"));
            expect(wall).not.toBeUndefined();
            expect(wall!.readOnly).toBe(true);
            const duct = values.find((box) => box.title.startsWith("configure(OD"));
            expect(duct).not.toBeUndefined();
            expect(duct!.className).toMatch(/configured/);
            const tab = values.find((box) => box.title === "25.4 mm");
            expect(tab).not.toBeUndefined();
            expect(tab!.className).not.toMatch(/configured/);
            expect(panel.element.textContent).toContain("variable.type.measured");
            expect(panel.element.textContent).toContain("variable.insertStudio");
        } finally {
            panel.dispose();
            panel.element.remove();
            doc.dispose();
        }
    });

    test("lists Variable Studios as their own groups before the Part Studio", () => {
        const { doc } = fixture();
        doc.modelManager.addNode(new VariableStudioNode({ document: doc, name: "Barcode" }));
        const panel = new VariableTablePanel(doc);
        try {
            const titles = Array.from(panel.element.querySelectorAll("button[aria-controls]")).map((button) =>
                button.textContent?.trim(),
            );
            expect(titles).toEqual(["▾Barcode", "▾elements.partStudio1"]);
        } finally {
            panel.dispose();
            doc.dispose();
        }
    });
});
