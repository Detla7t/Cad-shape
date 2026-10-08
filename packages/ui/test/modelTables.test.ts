// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    GeometryNode,
    type IShapeMeshData,
    LENGTH_UNITS,
    parseConfiguredValue,
    Result,
    registerModelParameters,
    Transaction,
    UNITLESS,
} from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { ConfigurationTablePanel } from "../src/sidebar/configurationTablePanel";
import { InspectionPanel } from "../src/sidebar/inspectionPanel";

class ParameterNode extends GeometryNode {
    display() {
        return "body.meshNode" as const;
    }
    protected createMesh(): IShapeMeshData {
        return { edges: undefined, faces: undefined, vertexs: undefined };
    }
    get value(): number | string {
        return this.getPrivateValue("value", 20);
    }
    set value(value: number | string) {
        this.setProperty("value", value);
    }
    unit = LENGTH_UNITS;
}
registerModelParameters((doc) =>
    doc.modelManager
        .findNodes()
        .filter((n) => n instanceof ParameterNode)
        .map((node) => ({
            id: `${node.id}:depth`,
            node,
            label: "Depth",
            value: node.value,
            unit: node.unit,
            apply(value) {
                Transaction.execute(doc, "Edit depth", () => (node.value = value));
                return Result.ok(undefined);
            },
        })),
);
function fixture() {
    const doc = new TestDocument();
    const node = new ParameterNode({ document: doc, name: "Extrude" });
    doc.modelManager.addNode(node);
    doc.variables.setConfigurationInputs([
        {
            kind: "list",
            id: "size",
            name: "Size",
            options: [
                { id: "s", name: "Small" },
                { id: "l", name: "Large" },
            ],
            defaultOption: "s",
        },
    ]);
    return { doc, node };
}
function field(root: HTMLElement, label: string): HTMLInputElement {
    const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    expect(input).not.toBeNull();
    return input!;
}
function change(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
}
test("configuration grid edits separate arms without losing other cells; undo refreshes the table", async () => {
    const { doc, node } = fixture();
    node.value = 'configure(Size, "Small": 20, "Large": 40)';
    const panel = new ConfigurationTablePanel(doc);
    try {
        change(field(panel.element, "Small: Extrude / Depth"), "25 mm");
        change(field(panel.element, "Large: Extrude / Depth"), "50 mm");
        expect(parseConfiguredValue(String(node.value)).value.arms).toEqual(
            expect.arrayContaining([
                { option: "Small", value: "25 mm" },
                { option: "Large", value: "50 mm" },
            ]),
        );
        doc.history.undo();
        await Promise.resolve();
        expect(field(panel.element, "Small: Extrude / Depth").value).toBe("25 mm");
        expect(field(panel.element, "Large: Extrude / Depth").value).toBe("40");
        const activate = Array.from(panel.element.querySelectorAll("button")).find(
            (b) => b.textContent === "Large",
        );
        expect(activate).not.toBeUndefined();
        activate!.click();
        expect(doc.variables.activeConfiguration).toEqual({ Size: "Large" });
    } finally {
        panel.dispose();
        doc.dispose();
    }
});
test("inspection tolerance edits update limits and undo restores both data and displayed values", async () => {
    const { doc, node } = fixture();
    const panel = new InspectionPanel(doc);
    try {
        change(field(panel.element, "Depth: minus tolerance"), "0.2");
        expect(JSON.parse(node.inspectionJson)[`${node.id}:depth`]).toEqual({ minus: 0.2, plus: 0 });
        expect(panel.element.textContent).toContain("19.8 mm");
        doc.history.undo();
        await Promise.resolve();
        expect(field(panel.element, "Depth: minus tolerance").value).toBe("0");
        expect(panel.element.textContent).not.toContain("19.8 mm");
    } finally {
        panel.dispose();
        doc.dispose();
    }
});
test("inspection displays a unitless parameter without millimeter units", () => {
    const { doc, node } = fixture();
    node.unit = UNITLESS;
    const panel = new InspectionPanel(doc);
    try {
        expect(panel.element.querySelectorAll("tr")).toHaveLength(2);
        expect(panel.element.querySelectorAll("tr")[1].cells[1].textContent).toBe("20");
    } finally {
        panel.dispose();
        doc.dispose();
    }
});

test("the add-input menu creates independent lists, checkboxes and variables without a combination table", async () => {
    const { doc } = fixture();
    const panel = new ConfigurationTablePanel(doc);
    document.body.append(panel.element);
    try {
        for (const kind of ["list", "checkbox", "variable"]) {
            const add = panel.element.querySelector<HTMLButtonElement>(
                "[aria-label='Add configuration input']",
            );
            expect(add).not.toBeNull();
            add!.click();
            const choices = panel.element.querySelectorAll<HTMLButtonElement>("[role=menuitem]");
            expect(Array.from(choices).map((b) => b.textContent)).toEqual([
                "List",
                "Checkbox",
                "Configuration variable",
            ]);
            panel.element.querySelector<HTMLButtonElement>(`[data-input-kind='${kind}']`)!.click();
            expect(doc.variables.configurationInputs.at(-1)!.kind).toBe(kind);
            expect(panel.element.querySelector("[role=menu]")).toBeNull();
            panel.element.querySelector<HTMLButtonElement>("[role=tab]")!.click();
            await Promise.resolve();
        }
        expect(panel.element.querySelectorAll("details[data-input-id]")).toHaveLength(4);
        expect(panel.element.querySelectorAll("details table")).toHaveLength(3);
        expect(panel.element.querySelectorAll("details tr")).toHaveLength(8); // (2 + 1 + 2) choices + 3 headers
        const box = panel.element.querySelector<HTMLInputElement>(
            "details input[aria-label='Variable1 value']",
        );
        expect(box).not.toBeNull();
        box!.value = "35 mm";
        box!.dispatchEvent(new FocusEvent("blur"));
        expect(doc.variables.activeConfiguration).toEqual({ Variable1: "35 mm" });
        expect(doc.variables.scope.get("Variable1")?.value).toBe(35);
    } finally {
        panel.dispose();
        panel.element.remove();
        doc.dispose();
    }
});
