// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FloatPanelOptions,
    I18n,
    PubSub,
    setDocumentUnits,
    type VariableData,
    VariableStudioNode,
    type VariableType,
} from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { mustQuery } from "./_helpers/domHelpers";

// Must load before the module under test — see the helpers' own comments.
import "./_helpers/cssMocks";
import "./_helpers/mockElement";

rs.mock("../src/property/variables/variablesEditor.module.css", () => ({
    root: "v-root",
    sectionToggle: "v-section-toggle",
    table: "v-table",
    toolbar: "v-toolbar",
    addButton: "v-add-button",
    rows: "v-rows",
    row: "v-row",
    newRow: "v-new-row",
    header: "v-header",
    cell: "v-cell",
    field: "v-field",
    value: "v-value",
    nameCell: "v-name-cell",
    marker: "v-marker",
    hasNote: "v-has-note",
    notePopup: "v-note-popup",
    noteInput: "v-note-input",
    error: "v-error",
    errorRow: "v-error-row",
    empty: "v-empty",
    actions: "v-actions",
    iconButton: "v-icon-button",
    danger: "v-danger",
}));

import { VariablesEditor } from "../src/property/variables/variablesEditor";
import { showVariablesPanel } from "../src/property/variables/variablesPanel";
import { VariableTablePanel } from "../src/sidebar/variableTablePanel";

function variable(id: string, name: string, expression: string, type: VariableType = "length"): VariableData {
    return { id, name, expression, type };
}

function documentWith(items: VariableData[]): TestDocument {
    const document = new TestDocument();
    document.history.disabled = true;
    document.variables.setItems(items);
    document.history.disabled = false;
    return document;
}

test("variable table sections fold independently, preserve draft cells and track studio names", () => {
    const doc = documentWith([variable("w", "width", "10")]);
    const studio = new VariableStudioNode({ document: doc, name: "Stock" });
    studio.setItems([variable("t", "thickness", "2")]);
    doc.modelManager.addNode(studio);
    const panel = new VariableTablePanel(doc);
    window.document.body.append(panel.element);
    try {
        // Onshape's order: the Variable Studios, then the Part Studio's own variables.
        const sections = panel.element.querySelectorAll<HTMLButtonElement>(".v-section-toggle");
        expect(sections).toHaveLength(2);
        expect(sections[0].textContent).toContain("Stock");
        expect(sections[1].textContent).toContain(I18n.translate("elements.partStudio{0}", 1));
        const tables = panel.element.querySelectorAll<HTMLElement>(".v-table");
        expect(tables).toHaveLength(2);
        const draft = mustQuery<HTMLInputElement>(tables[1], ".v-value");
        draft.value = "width *";
        sections[1].click();
        expect(sections[1].getAttribute("aria-expanded")).toBe("false");
        expect(tables[1].hidden).toBe(true);
        expect(tables[0].hidden).toBe(false);
        sections[1].click();
        expect(tables[1].hidden).toBe(false);
        expect(mustQuery<HTMLInputElement>(tables[1], ".v-value")).toBe(draft);
        expect(draft.value).toBe("width *");
        draft.focus();
        studio.name = "Material";
        expect(sections[0].textContent).toContain("Material");
        sections[0].click();
        doc.modelManager.addNode(new VariableStudioNode({ document: doc, name: "Dimensions" }));
        expect(panel.element.querySelectorAll(".v-section-toggle")).toHaveLength(3);
        expect(tables[1].querySelector(".v-value")).toBe(draft);
        expect(draft.value).toBe("width *");
        expect(tables[0].hidden).toBe(true);
    } finally {
        panel.dispose();
        panel.element.remove();
    }
    const reopened = new VariableTablePanel(doc);
    try {
        const tables = reopened.element.querySelectorAll<HTMLElement>(".v-table");
        expect(tables).toHaveLength(3);
        expect(tables[0].hidden).toBe(true);
        expect(tables[2].hidden).toBe(false);
        expect(doc.variables.items[0].expression).toBe("10");
    } finally {
        reopened.dispose();
    }
});

describe("showVariablesPanel", () => {
    const opened: FloatPanelOptions[] = [];
    const capture = (options: FloatPanelOptions) => {
        opened.push(options);
    };

    afterEach(() => {
        PubSub.default.remove("showFloatPanel", capture);
        opened.length = 0;
    });

    /** The panel is opened through PubSub, exactly as the editor does it. */
    function open(document: TestDocument, applied = rs.fn()) {
        PubSub.default.sub("showFloatPanel", capture);
        showVariablesPanel(document, applied);
        return { editor: opened[0]?.content as VariablesEditor, applied };
    }

    test("opens a floating panel holding the parameters table", () => {
        open(documentWith([variable("v1", "w", "50"), variable("v2", "h", "w / 2")]));

        expect(opened).toHaveLength(1);
        expect(opened[0].title).toBe("variables.title");
        expect(opened[0].content).toBeInstanceOf(VariablesEditor);
        expect((opened[0].content as VariablesEditor).querySelectorAll(".v-row")).toHaveLength(2);
    });

    test("an edit lands in the document as it is made — no confirm step", () => {
        const document = documentWith([variable("v1", "w", "50")]);
        const { editor, applied } = open(document);

        const row = editor.querySelectorAll(".v-row")[0];
        const expression = row.querySelectorAll<HTMLInputElement>(".v-cell")[2];
        expression.value = "w * 3";
        (expression as any)._onblur({ target: expression });

        expect(document.variables.items[0].expression).toBe("w * 3");
        expect(applied).toHaveBeenCalledTimes(1);
    });

    test("a half-typed value never reaches the document", () => {
        const document = documentWith([variable("v1", "w", "50")]);
        const { editor } = open(document);

        const row = editor.querySelectorAll(".v-row")[0];
        const expression = row.querySelectorAll<HTMLInputElement>(".v-cell")[2];
        // Typing does nothing on its own: the write happens when the field is left.
        expression.value = "w *";
        expect(document.variables.items[0].expression).toBe("50");
    });

    test("the description lives behind the row's marker, not in a column", () => {
        const document = documentWith([variable("v1", "w", "50")]);
        const { editor } = open(document);

        const row = editor.querySelectorAll(".v-row")[0];
        const marker = mustQuery<HTMLElement>(row, ".v-marker");
        // No note yet: the marker exists (that is how one is added) but stays quiet.
        expect(marker.classList.contains("v-has-note")).toBe(false);

        (marker as any)._onclick({ stopPropagation: () => {}, target: marker });

        const box = window.document.body.querySelector(".v-note-input") as HTMLInputElement;
        expect(box).not.toBeNull();
        box.value = "总宽";
        (box as any)._onblur({ target: box });

        expect(document.variables.items[0].description).toBe("总宽");
        expect(window.document.body.querySelector(".v-note-input")).toBeNull();
    });

    test("a row with a description keeps its marker visible", () => {
        const document = documentWith([{ ...variable("v1", "w", "50"), description: "总宽" }]);
        const { editor } = open(document);

        const marker = mustQuery<HTMLElement>(editor.querySelectorAll(".v-row")[0], ".v-marker");

        expect(marker.classList.contains("v-has-note")).toBe(true);
        expect(marker.getAttribute("title")).toBe("总宽");
    });

    test("naming the empty bottom row is how a parameter is added", () => {
        const document = documentWith([]);
        const { editor } = open(document);

        const newRow = mustQuery<HTMLInputElement>(editor, ".v-new-row input");
        newRow.value = "w";
        (newRow as any)._onblur({ target: newRow });

        expect(document.variables.items).toHaveLength(1);
        expect(document.variables.items[0]).toMatchObject({ name: "w", expression: "0", type: "length" });
    });

    test("the value column reads the value, and the expression while focused", () => {
        const document = documentWith([
            variable("v1", "w", "50"),
            variable("v2", "h", "w / 2"),
            variable("v3", "a", "45", "angle"),
        ]);
        const { editor } = open(document);

        const rows = editor.querySelectorAll(".v-row");
        const width = mustQuery<HTMLInputElement>(rows[0], ".v-value");
        const height = mustQuery<HTMLInputElement>(rows[1], ".v-value");
        const angle = mustQuery<HTMLInputElement>(rows[2], ".v-value");
        expect(width.value).toBe("50.00 mm");
        expect(height.value).toBe("25.00 mm");
        expect(angle.value).toBe("45.0°");
        // The cell shows what the expression came to; hovering reveals the expression itself.
        expect(height.title).toBe("w / 2");

        // Focused, the same box shows what to edit rather than what it came to.
        (width as any)._onfocus({ target: width });
        expect(width.value).toBe("50 mm");
    });

    test("re-focusing a value offers the current expression, not the row's snapshot", () => {
        const document = documentWith([variable("v1", "w", "50")]);
        const { editor } = open(document);
        const box = mustQuery<HTMLInputElement>(editor.querySelectorAll(".v-row")[0], ".v-value");

        box.value = "w * 2";
        (box as any)._onblur({ target: box });
        expect(document.variables.items[0].expression).toBe("w * 2");

        // The row is not rebuilt by an edit (only the value column is refreshed), so the
        // control has to read the table rather than the item it was built with.
        (box as any)._onfocus({ target: box });

        expect(box.value).toBe("w * 2");
    });

    test("unit changes convert values and precision without altering expressions or geometry", () => {
        const model = documentWith([
            variable("v1", "width", "25.4 mm"),
            variable("v2", "angle", "180 deg", "angle"),
            variable("v3", "count", "3", "unitless"),
        ]);
        const { editor } = open(model);
        const values = [...editor.querySelectorAll<HTMLInputElement>(".v-value")];
        expect(values.map((c) => c.value)).toEqual(["25.40 mm", "180.0°", "3"]);
        setDocumentUnits(model, { length: "in", angle: "rad", lengthPrecision: 3, anglePrecision: 4 });
        expect(values.map((c) => c.value)).toEqual(["1.000 in", "3.1416 rad", "3"]);
        expect(model.variables.items.map((v) => v.expression)).toEqual(["25.4 mm", "180 deg", "3"]);
        (values[0] as any)._onfocus({ target: values[0] });
        values[0].value = "2";
        (values[0] as any)._onblur({ target: values[0] });
        expect(model.variables.evaluate().values.get("v1")?.value).toBeCloseTo(50.8, 8);
        expect(values[0].value).toBe("2.000 in");
        setDocumentUnits(model, { length: "mm", angle: "deg", lengthPrecision: 1, anglePrecision: 1 });
        expect(values[0].value).toBe("50.8 mm");
        editor.dispose();
    });

    test("an undo behind the panel's back rebuilds the rows from the table", async () => {
        const document = documentWith([variable("v1", "w", "50")]);
        const { editor } = open(document);

        const newRow = mustQuery<HTMLInputElement>(editor, ".v-new-row input");
        newRow.value = "depth";
        (newRow as any)._onblur({ target: newRow });
        expect(editor.querySelectorAll(".v-row")).toHaveLength(2);

        await document.history.undo();

        // The row is gone from the table, so it has to go from the panel too — a stale row
        // is a dead control: its id no longer exists, so its edits write nothing.
        expect(document.variables.items).toHaveLength(1);
        expect(editor.querySelectorAll(".v-row")).toHaveLength(1);
    });

    test("a write from elsewhere — another panel — rebuilds the rows", () => {
        const document = documentWith([variable("v1", "w", "50")]);
        const { editor } = open(document);

        document.variables.setItems([variable("v1", "w", "50"), variable("v2", "h", "10")]);

        expect(editor.querySelectorAll(".v-row")).toHaveLength(2);
    });

    test("the panel's own write does not rebuild the rows it just changed", () => {
        const document = documentWith([variable("v1", "w", "50")]);
        const { editor } = open(document);
        const row = editor.querySelectorAll(".v-row")[0];

        const expression = row.querySelectorAll<HTMLInputElement>(".v-cell")[2];
        expression.value = "w * 3";
        (expression as any)._onblur({ target: expression });

        // Same element: rebuilding would take the focus out of the field being edited.
        expect(editor.querySelectorAll(".v-row")[0]).toBe(row);
    });

    test("leaving a field unchanged writes nothing", () => {
        const document = documentWith([variable("v1", "w", "50")]);
        const { editor, applied } = open(document);

        const row = editor.querySelectorAll(".v-row")[0];
        const name = row.querySelectorAll<HTMLInputElement>(".v-cell")[0];
        (name as any)._onblur({ target: name });

        expect(document.history.undoCount()).toBe(0);
        expect(applied).not.toHaveBeenCalled();
    });
});
