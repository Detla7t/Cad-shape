// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import { showConfigurationVisibility } from "../src/property/configuration/visibilityEditor";

function setup() {
    const model = new TestDocument();
    model.variables.setConfigurationInputs([
        { kind: "checkbox", id: "switch", name: "Enabled", defaultValue: false },
        {
            kind: "variable",
            id: "size",
            name: "Size",
            type: "length",
            defaultExpression: "20",
            visibility: { match: "all", conditions: [{ inputId: "switch", operator: "is", values: [true] }] },
        },
    ]);
    return model;
}
afterEach(() => document.querySelectorAll("dialog").forEach((dialog) => dialog.remove()));

test("preview changes are isolated, including hidden inputs; Cancel keeps the document unchanged", () => {
    const model = setup();
    const original = model.variables.configurationJson;
    const dialog = showConfigurationVisibility(model);
    expect(dialog.querySelectorAll('aside [data-visible="false"]')).toHaveLength(1);
    const checkbox = dialog.querySelector<HTMLInputElement>('aside input[title="Enabled"]');
    expect(checkbox).not.toBeNull();
    checkbox!.click();
    expect(dialog.querySelectorAll('aside [data-visible="false"]')).toHaveLength(0);
    expect(model.variables.activeConfiguration).toEqual({});
    expect(model.variables.configurationJson).toBe(original);
    const cancel = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
    expect(cancel).not.toBeUndefined();
    cancel!.click();
    expect(dialog.isConnected).toBe(false);
    expect(model.variables.configurationJson).toBe(original);
});

test("saving rules is one undoable change; clearing a condition makes the input always visible", () => {
    const model = setup();
    const original = model.variables.configurationJson;
    const dialog = showConfigurationVisibility(model);
    const remove = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove condition",
    );
    expect(remove).not.toBeUndefined();
    remove!.click();
    expect(dialog.querySelectorAll('aside [data-visible="false"]')).toHaveLength(0);
    const save = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Save");
    expect(save).not.toBeUndefined();
    save!.click();
    expect(model.variables.configurationInputs[1].visibility).toBeUndefined();
    model.history.undo();
    expect(model.variables.configurationJson).toBe(original);
});
