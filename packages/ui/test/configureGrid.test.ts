// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ConfigurationInputData,
    type DialogButton,
    type FeatureItem,
    type IFeatureListNode,
    type INode,
    LENGTH_UNITS,
    type Scope,
    UNITLESS,
} from "@chili3d/core";
import { afterEach, describe, expect, rs, test } from "@rstest/core";

// test-utils must load BEFORE the core-mock helper so the real core module is
// fully cached by the time `rs.mock("@chili3d/core")` registers.
import { createMockDocument } from "./_helpers/propertyTestHelpers";

import "./_helpers/cssMocks";
import "./_helpers/mockElement";
import "./_helpers/mockCoreProperty";

rs.mock("../src/property/featureListProperty.module.css", () => ({
    item: "fl-item",
    error: "fl-error",
    warning: "fl-warning",
    suppressed: "fl-suppressed",
    header: "fl-header",
    expander: "fl-expander",
    icon: "fl-icon",
    name: "fl-name",
    more: "fl-more",
    body: "fl-body",
    errorText: "fl-error-text",
    warningText: "fl-warning-text",
    param: "fl-param",
    reference: "fl-reference",
    select: "fl-select",
    pick: "fl-pick",
    pickSummary: "fl-pick-summary",
    pickButton: "fl-pick-button",
    menu: "fl-menu",
    menuItem: "fl-menu-item",
    menuIcon: "fl-menu-icon",
    dropBefore: "fl-drop-before",
    dropAfter: "fl-drop-after",
    configure: "fl-configure",
    configureOn: "fl-configure-on",
    configuredValue: "fl-configured-value",
}));

rs.mock("../src/property/configuration/configureGrid.module.css", () => ({
    root: "cg-root",
    inputRow: "cg-input-row",
    label: "cg-label",
    inputSelect: "cg-input-select",
    field: "cg-field",
    header: "cg-header",
    rows: "cg-rows",
    row: "cg-row",
    option: "cg-option",
    empty: "cg-empty",
}));

const { showDialogMock } = rs.hoisted(() => {
    const fn = (title: string, content: HTMLElement, buttons?: unknown) => {
        fn.calls.push([title, content, buttons]);
    };
    fn.calls = [] as [string, HTMLElement, unknown][];
    fn.clear = () => {
        fn.calls.length = 0;
    };
    return { showDialogMock: fn };
});

rs.mock("../src/dialog", () => ({
    showDialog: showDialogMock,
}));

import { ConfigureGrid } from "../src/property/configuration/configureGrid";
import { FeatureListProperty } from "../src/property/featureListProperty";
import { mustQuery } from "./_helpers/domHelpers";

const SIZE: ConfigurationInputData = {
    kind: "list",
    id: "c-size",
    name: "Size",
    options: [
        { id: "o-s", name: "S" },
        { id: "o-l", name: "L" },
    ],
};
const HOLES: ConfigurationInputData = { kind: "checkbox", id: "c-holes", name: "Holes", defaultValue: false };

/** A mock document whose configuration has `Size` (active `S`) and `Holes` (off). */
function configuredDocument(active = "S") {
    const scope: Scope = new Map([
        ["Size", { value: active === "S" ? 0 : 1, unit: UNITLESS, option: active }],
        ["Holes", { value: 0, unit: UNITLESS, option: "false" }],
    ]);
    return createMockDocument({
        variables: {
            configurationInputs: [SIZE, HOLES],
            scope,
            evaluate: () => ({ scope, errors: new Map(), warnings: new Map(), values: new Map() }),
        },
    });
}

function featureNode(parameters: FeatureItem["parameters"], item?: Partial<FeatureItem>) {
    return {
        featureItems: () => [{ id: "f1", display: "command.feature.extrude", parameters, ...item }],
        setFeatureParameter: rs.fn((_id: string, _key: string, _value: number | string | boolean) => {}),
        setFeatureSuppressed: rs.fn((_id: string, _suppressed: boolean | string) => {}),
        moveFeature: rs.fn(),
        moveFeatureTo: rs.fn(),
        renameFeature: rs.fn(),
        removeFeature: rs.fn(),
    } as unknown as INode & IFeatureListNode;
}

function expand(prop: FeatureListProperty) {
    click(mustQuery(prop, ".fl-header"), new MouseEvent("click"));
}

function click(element: Element, event: unknown = { stopPropagation: () => {} }) {
    (element as unknown as { _onclick: (e: unknown) => void })._onclick(event);
}

/** The last dialog the grid opened: its grid and its buttons. */
function lastDialog() {
    const call = showDialogMock.calls.at(-1);
    expect(call).not.toBeUndefined();
    const [title, content, buttons] = call!;
    expect(title).toBe("configuration.configureTitle");
    expect(content).toBeInstanceOf(ConfigureGrid);
    return { grid: content as ConfigureGrid, buttons: buttons as DialogButton[] };
}

function button(buttons: DialogButton[], content: string) {
    const found = buttons.find((x) => x.content === content);
    expect(found).not.toBeUndefined();
    return found!;
}

describe("the Configure grid on feature parameters", () => {
    afterEach(() => {
        showDialogMock.clear();
        document.body.querySelectorAll(".fl-menu").forEach((x) => {
            x.remove();
        });
    });

    test("a numeric parameter's Configure writes configure(…) through the apply path", () => {
        const node = featureNode([{ key: "depth", display: "common.name", value: 12, unit: LENGTH_UNITS }]);
        const prop = new FeatureListProperty(configuredDocument(), node);
        expand(prop);
        click(mustQuery(prop, ".fl-configure"));

        const { grid, buttons } = lastDialog();
        expect(grid.inputName).toBe("Size");
        const rows = grid.querySelectorAll(".cg-row");
        expect([...rows].map((row) => mustQuery(row, ".cg-option").textContent)).toEqual(["S", "L"]);
        // Every option starts at the current value.
        const fields = [...grid.querySelectorAll<HTMLInputElement>(".cg-row input")];
        expect(fields.map((x) => x.value)).toEqual(["12", "12"]);
        fields[1].value = "w * 2";

        button(buttons, "common.confirm").onclick?.();
        expect(node.setFeatureParameter).toHaveBeenCalledWith(
            "f1",
            "depth",
            'configure(Size, "S": 12, "L": w * 2)',
        );
    });

    test("switching the grid's input re-lists the options; a checkbox input has true and false", () => {
        const node = featureNode([{ key: "depth", display: "common.name", value: 5, unit: LENGTH_UNITS }]);
        const prop = new FeatureListProperty(configuredDocument(), node);
        expand(prop);
        click(mustQuery(prop, ".fl-configure"));
        const { grid, buttons } = lastDialog();
        const select = mustQuery<HTMLSelectElement>(grid, ".cg-input-select");
        select.value = "Holes";
        (select as unknown as { _onchange: () => void })._onchange();
        const fields = [...grid.querySelectorAll<HTMLInputElement>(".cg-row input")];
        expect([...grid.querySelectorAll(".cg-option")].map((x) => x.textContent)).toEqual(["true", "false"]);
        fields[0].value = "8";
        button(buttons, "common.confirm").onclick?.();
        expect(node.setFeatureParameter).toHaveBeenCalledWith(
            "f1",
            "depth",
            "configure(Holes, true: 8, false: 5)",
        );
    });

    test("a configured cell shows the active value with a marker, and edits only the active arm", () => {
        const configured = 'configure(Size, "S": 10, "L": 30)';
        const node = featureNode([
            { key: "depth", display: "common.name", value: configured, unit: LENGTH_UNITS },
        ]);
        const prop = new FeatureListProperty(configuredDocument("L"), node);
        expand(prop);
        const box = mustQuery<HTMLInputElement>(prop, ".fl-param input");
        expect(box.value).toBe("30");
        expect(box.className).toContain("fl-configured-value");
        expect(mustQuery(prop, ".fl-configure").className).toContain("fl-configure-on");

        box.value = "35";
        (box as unknown as { _onblur: (e: unknown) => void })._onblur({ target: box });
        expect(node.setFeatureParameter).toHaveBeenCalledWith(
            "f1",
            "depth",
            'configure(Size, "S": 10, "L": 35)',
        );
    });

    test("the grid edits an existing configuration, and can remove it", () => {
        const configured = 'configure(Size, "S": 10, "L": 30)';
        const node = featureNode([
            { key: "depth", display: "common.name", value: configured, unit: LENGTH_UNITS },
        ]);
        const prop = new FeatureListProperty(configuredDocument("L"), node);
        expand(prop);
        click(mustQuery(prop, ".fl-configure"));
        const { grid, buttons } = lastDialog();
        expect([...grid.querySelectorAll<HTMLInputElement>(".cg-row input")].map((x) => x.value)).toEqual([
            "10",
            "30",
        ]);
        // Removing keeps what the active configuration had.
        button(buttons, "configuration.unconfigure").onclick?.();
        expect(node.setFeatureParameter).toHaveBeenCalledWith("f1", "depth", 30);
    });

    test("a configurable checkbox gets a grid of checkboxes; built-in ones get no Configure", () => {
        const node = featureNode([
            { key: "double", display: "common.name", value: false, configurable: true },
            { key: "symmetric", display: "common.name", value: false },
        ]);
        const prop = new FeatureListProperty(configuredDocument(), node);
        expand(prop);
        const buttons = prop.querySelectorAll(".fl-configure");
        expect(buttons).toHaveLength(1);
        click(buttons[0]);
        const dialog = lastDialog();
        const boxes = [...dialog.grid.querySelectorAll<HTMLInputElement>(".cg-row input")];
        expect(boxes.map((x) => x.type)).toEqual(["checkbox", "checkbox"]);
        boxes[1].checked = true;
        button(dialog.buttons, "common.confirm").onclick?.();
        expect(node.setFeatureParameter).toHaveBeenCalledWith(
            "f1",
            "double",
            'configure(Size, "S": false, "L": true)',
        );
    });

    test("an enum parameter's grid stores quoted option values", () => {
        const node = featureNode([
            {
                key: "shape",
                display: "common.name",
                value: "CUBE",
                configurable: true,
                options: [
                    { value: "CUBE", label: "Cube" },
                    { value: "SLAB", label: "Slab" },
                ],
            },
        ]);
        const prop = new FeatureListProperty(configuredDocument(), node);
        expand(prop);
        click(mustQuery(prop, ".fl-configure"));
        const { grid, buttons } = lastDialog();
        const selects = [...grid.querySelectorAll<HTMLSelectElement>(".cg-row select")];
        selects[1].value = "SLAB";
        button(buttons, "common.confirm").onclick?.();
        expect(node.setFeatureParameter).toHaveBeenCalledWith(
            "f1",
            "shape",
            'configure(Size, "S": "CUBE", "L": "SLAB")',
        );
    });

    test("configure suppression from the feature menu", () => {
        const node = featureNode([], { suppressed: false });
        const prop = new FeatureListProperty(configuredDocument(), node);
        click(mustQuery(prop, ".fl-more"));
        // Edit, rename, suppress, configure suppression, delete, comment and where used.
        const entries = mustQuery(document.body, ".fl-menu").querySelectorAll(".fl-menu-item");
        expect(entries).toHaveLength(7);
        const configure = mustQuery(
            mustQuery(document.body, ".fl-menu"),
            'svg[icon="icon-layer-group"]',
        ).parentElement;
        expect(configure).not.toBeNull();
        click(configure!);
        const { grid, buttons } = lastDialog();
        const select = mustQuery<HTMLSelectElement>(grid, ".cg-input-select");
        select.value = "Holes";
        (select as unknown as { _onchange: () => void })._onchange();
        const boxes = [...grid.querySelectorAll<HTMLInputElement>(".cg-row input")];
        boxes[1].checked = true;
        button(buttons, "common.confirm").onclick?.();
        expect(node.setFeatureSuppressed).toHaveBeenCalledWith(
            "f1",
            "configure(Holes, true: false, false: true)",
        );
    });

    test("toggling a configured suppression changes the active configuration's arm only", () => {
        const node = featureNode([], {
            suppressed: true,
            suppressionConfigured: 'configure(Size, "S": true, "L": false)',
        });
        const prop = new FeatureListProperty(configuredDocument("S"), node);
        click(mustQuery(prop, ".fl-more"));
        const unsuppress = mustQuery(
            mustQuery(document.body, ".fl-menu"),
            'svg[icon="icon-eye"]',
        ).parentElement;
        expect(unsuppress).not.toBeNull();
        click(unsuppress!);
        expect(node.setFeatureSuppressed).toHaveBeenCalledWith(
            "f1",
            'configure(Size, "S": false, "L": false)',
        );
    });

    test("without a list or checkbox input, the grid points to the Configuration panel", () => {
        const node = featureNode([{ key: "depth", display: "common.name", value: 12, unit: LENGTH_UNITS }]);
        const prop = new FeatureListProperty(createMockDocument(), node);
        expand(prop);
        click(mustQuery(prop, ".fl-configure"));
        const { grid, buttons } = lastDialog();
        expect(grid.inputName).toBeUndefined();
        expect(grid.querySelector(".cg-rows")).toBeNull();
        expect(mustQuery(grid, ".cg-empty")).not.toBeNull();
        expect(buttons.map((x) => x.content)).toEqual(["command.configuration.edit", "common.cancel"]);
    });
});
