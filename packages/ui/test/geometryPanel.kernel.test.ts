// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Matrix4, Plane, type VisualShapeData } from "@chili3d/core";
import { createMockDocument, createMockView } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import "../../parametric/src/measurement/shapeProperties";
import { analysisMenu } from "../src/review/analysisMenu";
import { GeometryPanel } from "../src/review/geometryPanel";

const originalFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        configurable: true,
        writable: true,
    });
});
afterAll(() => {
    if (originalFactory) Object.defineProperty(globalThis, "shapeFactory", originalFactory);
});

const owned: IShape[] = [];
const panels: GeometryPanel[] = [];
afterEach(() => {
    for (const panel of panels.splice(0)) panel.dispose();
    for (const shape of owned.splice(0)) shape.dispose();
});
function box() {
    const result = shapeFactory.box(Plane.XY, 25.4, 10, 10);
    expect(result.isOk).toBe(true);
    if (!result.isOk) throw new Error(result.error);
    owned.push(result.value);
    return result.value;
}
function inspector(
    shapes: IShape[],
    kind: "mass" | "analysis",
    tool: "geometry" | "interference" = "geometry",
    userData?: Record<string, unknown>,
) {
    const doc = createMockDocument({
        history: { onChanged: () => {}, removeChanged: () => {} },
        selection: {
            getSelectedShapes: () =>
                shapes.map(
                    (shape) =>
                        ({
                            shape,
                            transform: Matrix4.identity(),
                            owner: { node: {} },
                        }) as unknown as VisualShapeData,
                ),
        },
    });
    if (userData) doc.userData = userData;
    const panel = new GeometryPanel(createMockView({ document: doc }), kind, tool);
    panels.push(panel);
    return panel.element;
}
function row(root: HTMLElement, label: string): string | undefined {
    return (
        [...root.querySelectorAll("tr")].find((tr) => tr.cells[0]?.textContent === label)?.cells[1]
            ?.textContent ?? undefined
    );
}
test("part mass and all nine moments apply density with correct dimensions", () => {
    // The document shows mass in kg to six decimals (the default is three), so the density maths is visible.
    const root = inspector([box()], "mass", "geometry", {
        quantityUnits: { mass: { unit: "kg", precision: 6 } },
    });
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Density in g/cm³"]');
    expect(input).not.toBeNull();
    input!.value = "1";
    input!.dispatchEvent(new Event("input"));
    expect(row(root, "Mass")).toBe("0.002540 kg");
    expect(row(root, "Ixx (centroid)")).toBe("0.04 kg·mm²");
    expect(row(root, "Ixy (centroid)")).toBe(row(root, "Iyx (centroid)"));
    expect(
        [...root.querySelectorAll("tr")].filter((tr) => /^I[xyz][xyz] /.test(tr.cells[0]?.textContent ?? "")),
    ).toHaveLength(9);
    expect(row(root, "Surface area")).toBe("1216.00 mm²");
});

test("Face mode requires planar faces and reports section area with fourth-power moments", () => {
    const result = shapeFactory.rect(Plane.XY, 20, 10);
    expect(result.isOk).toBe(true);
    if (!result.isOk) throw new Error(result.error);
    owned.push(result.value);
    const root = inspector([result.value], "mass");
    expect(root.textContent).toContain("Select solid parts");
    const faceTab = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (tab) => tab.textContent === "Face",
    );
    expect(faceTab).not.toBeUndefined();
    faceTab!.click();
    expect(row(root, "Section / surface area")).toBe("200.00 mm²");
    expect(row(root, "Ixx (centroid)")).toBe("1666.67 mm⁴");
    expect(row(root, "Perimeter (sum of face boundaries)")).toBe("60.00 mm");
});

test("interference measures the common solid, including touching and separated cases", () => {
    const first = box();
    for (const [offset, expected, label] of [
        [20.4, "500.00 mm³", "Interference detected"],
        [25.4, "0.00 mm³", "No volumetric interference"],
        [30, "0.00 mm³", "No volumetric interference"],
    ] as const) {
        const second = first.transformed(Matrix4.fromTranslation(offset, 0, 0));
        owned.push(second);
        const root = inspector([first, second], "analysis", "interference");
        expect(row(root, "Common volume")).toBe(expected);
        expect(row(root, "Result")).toBe(label);
    }
});

test("analysis menu preserves all ten requested choices and routes supported tools distinctly", () => {
    const opened: string[] = [];
    const menu = analysisMenu((tool) => opened.push(tool));
    const choices = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(choices).toHaveLength(10);
    for (const choice of choices) choice.click();
    expect(opened).toEqual(["geometry", "interference"]);
    expect(choices.find((choice) => choice.textContent?.startsWith("Zebra stripes"))?.disabled).toBe(true);
});
