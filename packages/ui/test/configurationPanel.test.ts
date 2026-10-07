// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ConfigurationInputData, type FloatPanelOptions, type IView, PubSub } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { mustQuery } from "./_helpers/domHelpers";

// Must load before the module under test — see the helpers' own comments.
import "./_helpers/cssMocks";
import "./_helpers/mockElement";

rs.mock("../src/property/configuration/configurationEditor.module.css", () => ({
    root: "ce-root",
    sectionTitle: "ce-section-title",
    empty: "ce-empty",
    activeList: "ce-active-list",
    activeRow: "ce-active-row",
    activeName: "ce-active-name",
    activeControl: "ce-active-control",
    activeValue: "ce-active-value",
    valueError: "ce-value-error",
    cards: "ce-cards",
    card: "ce-card",
    cardError: "ce-card-error",
    cardHead: "ce-card-head",
    kind: "ce-kind",
    nameBox: "ce-name-box",
    options: "ce-options",
    optionRow: "ce-option-row",
    radio: "ce-radio",
    optionName: "ce-option-name",
    addOption: "ce-add-option",
    addButton: "ce-add-button",
    fieldRow: "ce-field-row",
    field: "ce-field",
    fieldLabel: "ce-field-label",
    expressionBox: "ce-expression-box",
    boundBox: "ce-bound-box",
    status: "ce-status",
    addBar: "ce-add-bar",
    iconButton: "ce-icon-button",
    danger: "ce-danger",
}));

rs.mock("../src/property/configuration/configurationBar.module.css", () => ({
    bar: "cb-bar",
    icon: "cb-icon",
    title: "cb-title",
    item: "cb-item",
    name: "cb-name",
    control: "cb-control",
    edit: "cb-edit",
}));

import { ConfigurationBar } from "../src/property/configuration/configurationBar";
import { ConfigurationDataContent } from "../src/property/configuration/configurationDataContent";
import { ConfigurationEditor } from "../src/property/configuration/configurationEditor";
import { showConfigurationPanel } from "../src/property/configuration/configurationPanel";

const SIZE: ConfigurationInputData = {
    kind: "list",
    id: "c-size",
    name: "Size",
    options: [
        { id: "o-s", name: "S" },
        { id: "o-l", name: "L" },
    ],
    defaultOption: "o-s",
};
const HOLES: ConfigurationInputData = { kind: "checkbox", id: "c-holes", name: "Holes", defaultValue: false };
const LENGTH: ConfigurationInputData = {
    kind: "variable",
    id: "c-length",
    name: "Length",
    type: "length",
    defaultExpression: "120",
    max: 500,
};

function documentWith(inputs: ConfigurationInputData[]): TestDocument {
    const document = new TestDocument();
    document.history.disabled = true;
    document.variables.setConfigurationInputs(inputs);
    document.history.disabled = false;
    return document;
}

type Handlers = {
    _onchange?: (e: unknown) => void;
    _onclick?: (e: unknown) => void;
    _onblur?: (e: unknown) => void;
};

const handlers = (element: Element) => element as unknown as Handlers;

function editorFor(document: TestDocument) {
    return new ConfigurationEditor(new ConfigurationDataContent(document));
}

describe("showConfigurationPanel", () => {
    const opened: FloatPanelOptions[] = [];
    const capture = (options: FloatPanelOptions) => {
        opened.push(options);
    };

    afterEach(() => {
        PubSub.default.remove("showFloatPanel", capture);
        opened.length = 0;
    });

    test("opens a floating panel bound to its document", () => {
        PubSub.default.sub("showFloatPanel", capture);
        const document = documentWith([SIZE]);
        showConfigurationPanel(document);
        expect(opened).toHaveLength(1);
        expect(opened[0].title).toBe("configuration.title");
        expect(opened[0].document).toBe(document);
        expect(opened[0].content).toBeInstanceOf(ConfigurationEditor);
    });
});

describe("ConfigurationEditor", () => {
    test("renders the active configuration on top: one control per input", () => {
        const editor = editorFor(documentWith([SIZE, HOLES, LENGTH]));
        const rows = editor.querySelectorAll(".ce-active-row");
        expect(rows).toHaveLength(3);
        expect([...rows].map((row) => mustQuery(row, ".ce-active-name").textContent)).toEqual([
            "Size",
            "Holes",
            "Length",
        ]);
        expect(rows[0].querySelector("select")).not.toBeNull();
        expect(mustQuery<HTMLInputElement>(rows[1], "input").type).toBe("checkbox");
        // A configuration variable shows what it resolves to next to its value box.
        expect(mustQuery(rows[2], ".ce-active-value").textContent).toBe("120");
        // ...and below, one card per input.
        expect(editor.querySelectorAll(".ce-card")).toHaveLength(3);
    });

    test("switching an input is not recorded, but re-scopes the document", () => {
        const document = documentWith([SIZE, HOLES, LENGTH]);
        const editor = editorFor(document);
        const [size, holes, length] = editor.querySelectorAll(".ce-active-row");

        handlers(mustQuery(size, "select"))._onchange?.({ target: { value: "L" } });
        handlers(mustQuery(holes, "input"))._onclick?.({ target: { checked: true } });
        handlers(mustQuery(length, "input"))._onblur?.({ target: { value: "200" } });

        expect(document.variables.activeConfiguration).toEqual({ Size: "L", Holes: true, Length: "200" });
        expect(document.variables.scope.get("Size")?.option).toBe("L");
        expect(document.variables.scope.get("Length")?.value).toBe(200);
        expect(document.history.undoCount()).toBe(0);
        // The value cell follows the scope.
        expect(mustQuery(length, ".ce-active-value").textContent).toBe("200");
    });

    test("a configuration variable out of bounds shows its error on its card and value", () => {
        const document = documentWith([LENGTH]);
        const editor = editorFor(document);
        handlers(mustQuery(editor, ".ce-active-row input"))._onblur?.({ target: { value: "600" } });
        expect(mustQuery(editor, ".ce-status").textContent).toBe("Length must be at most 500");
        expect(mustQuery(editor, ".ce-card").className).toContain("ce-card-error");
        expect(mustQuery(editor, ".ce-active-value").textContent).toBe("Length must be at most 500");
    });

    test("adding an input is one undo step, and undo re-renders the panel", async () => {
        const document = documentWith([]);
        const editor = editorFor(document);
        expect(mustQuery(editor, ".ce-empty")).not.toBeNull();

        const [list] = editor.querySelectorAll(".ce-add-button");
        handlers(list)._onclick?.({});

        expect(document.variables.configurationInputs).toMatchObject([
            { kind: "list", name: "List1", options: [{ name: "Default" }] },
        ]);
        expect(document.history.undoCount()).toBe(1);
        expect(editor.querySelectorAll(".ce-card")).toHaveLength(1);
        expect(editor.querySelectorAll(".ce-active-row")).toHaveLength(1);

        await document.history.undo();
        expect(editor.querySelectorAll(".ce-card")).toHaveLength(0);
        expect(mustQuery(editor, ".ce-empty")).not.toBeNull();
    });

    test("renaming the active option keeps the active choice on it", () => {
        const document = documentWith([SIZE]);
        document.variables.setActiveConfiguration({ Size: "L" });
        const editor = editorFor(document);
        const names = editor.querySelectorAll(".ce-option-name");
        expect(names).toHaveLength(2);

        handlers(names[1])._onblur?.({ target: { value: "Large" } });

        expect(document.variables.configurationInputs).toMatchObject([
            { options: [{ name: "S" }, { name: "Large" }] },
        ]);
        expect(document.variables.activeConfiguration).toEqual({ Size: "Large" });
        expect(document.variables.scope.get("Size")?.option).toBe("Large");
        // The active section names the renamed option.
        const select = mustQuery<HTMLSelectElement>(editor, ".ce-active-row select");
        expect([...select.options].map((x) => x.value)).toEqual(["S", "Large"]);
    });

    test("adding an option and choosing it as the default", () => {
        const document = documentWith([SIZE]);
        const editor = editorFor(document);
        handlers(mustQuery(editor, ".ce-add-option"))._onclick?.({});
        const radios = editor.querySelectorAll(".ce-radio");
        expect(radios).toHaveLength(3);
        handlers(radios[2])._onclick?.({});
        expect(document.variables.scope.get("Size")?.option).toBe("Option1");
        expect(document.history.undoCount()).toBe(2);
    });
});

describe("ConfigurationBar", () => {
    test("is absent for a document without inputs, and one click switches otherwise", () => {
        const document = documentWith([]);
        const view = { document } as unknown as IView;
        const bar = new ConfigurationBar({ activeView: view } as never);
        bar.setDocument(document);
        expect(bar.style.display).toBe("none");

        document.variables.setConfigurationInputs([SIZE, HOLES]);
        expect(bar.style.display).toBe("");
        expect(bar.querySelectorAll(".cb-item")).toHaveLength(2);
        const undoSteps = document.history.undoCount();

        handlers(mustQuery(bar, "select"))._onchange?.({ target: { value: "L" } });
        expect(document.variables.activeConfiguration).toEqual({ Size: "L" });
        expect(document.history.undoCount()).toBe(undoSteps);
    });

    test("follows switches made elsewhere and opens the panel from its button", () => {
        const document = documentWith([SIZE]);
        const bar = new ConfigurationBar({ activeView: undefined } as never);
        bar.setDocument(document);
        document.variables.setActiveConfiguration({ Size: "L" });
        const option = [...mustQuery<HTMLSelectElement>(bar, "select").options].find((x) => x.value === "L");
        expect((option as unknown as { _selected: boolean })._selected).toBe(true);

        const edited: unknown[] = [];
        const onEdit = (doc: unknown) => edited.push(doc);
        PubSub.default.sub("editConfiguration", onEdit);
        try {
            handlers(mustQuery(bar, ".cb-edit"))._onclick?.({});
            expect(edited).toEqual([document]);
        } finally {
            PubSub.default.remove("editConfiguration", onEdit);
        }
    });

    test("follows the active view's document", () => {
        const first = documentWith([SIZE]);
        const second = documentWith([]);
        const bar = new ConfigurationBar({ activeView: { document: first } } as never);
        window.document.body.append(bar);
        try {
            expect(bar.document).toBe(first);
            expect(bar.style.display).toBe("");
            PubSub.default.pub("activeViewChanged", { document: second } as unknown as IView);
            expect(bar.document).toBe(second);
            expect(bar.style.display).toBe("none");
        } finally {
            bar.remove();
        }
    });
});
