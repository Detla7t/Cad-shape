// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type INode,
    type IView,
    MEASUREMENT_LABELS,
    type MeasurementFrame,
    type MeasurementMode,
    type MeasurementResult,
    Plane,
    PubSub,
    Result,
    registerSelectionMeasurementProvider,
    type VisualShapeData,
} from "@chili3d/core";
import { createMockApplication, createMockDocument, createMockView } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { filterRows, MeasurePanel, measureRows, planeFrame } from "../src/review/measurePanel";

/** Two vertices: every value a pair measures, components read along the frame when one is given. */
function pairProvider(create: (mode: MeasurementMode) => Promise<void>, picks: () => readonly unknown[]) {
    const values: Partial<Record<MeasurementMode, number>> = {
        distance: 13,
        maxDistance: 20,
        centerDistance: 15,
        deltaX: 3,
        deltaY: 4,
        deltaZ: 12,
        angle: 90,
        tangentAngle: 45,
    };
    const frames: MeasurementFrame[] = [];
    registerSelectionMeasurementProvider({
        evaluate: (_doc, mode = "distance", frame) => {
            if (!picks().length) return Result.err("Select geometry to measure.");
            if (frame) frames.push(frame);
            const measurement = (m: MeasurementMode): MeasurementResult => ({
                mode: m,
                label: MEASUREMENT_LABELS[m],
                value: (values[m] ?? 0) * (frame && m === "deltaX" ? 2 : 1),
                segments: [
                    [
                        { x: 0, y: 0, z: 0 },
                        { x: 3, y: 4, z: 12 },
                    ],
                ],
            });
            return Result.ok({
                key: "pair",
                modes: Object.keys(values) as MeasurementMode[],
                measurement: measurement(mode),
                details: [],
                entities: [
                    { label: "Vertex of Reducing End Cap", nodeId: "a" },
                    { label: "Vertex of Reducing End Cap", nodeId: "a" },
                ],
                createVariable: create,
            });
        },
    });
    return frames;
}

function setup(picks: () => readonly unknown[]) {
    const setSelectedShapes = rs.fn(
        (_shapes: readonly VisualShapeData[], _state: number, _toggle: boolean) => 0,
    );
    const clearSelection = rs.fn(() => {});
    const selected: INode[] = [];
    const doc = createMockDocument({
        application: createMockApplication(),
        selection: {
            getSelectedShapes: () => picks() as VisualShapeData[],
            getSelectedNodes: () => selected,
            setSelectedShapes,
            clearSelection,
        },
        history: { onChanged: () => {}, removeChanged: () => {} },
        modelManager: { addNodeObserver: () => {}, removeNodeObserver: () => {}, findNodes: () => [] },
    });
    const view = createMockView({ document: doc, workplane: Plane.XY });
    return { doc, view, setSelectedShapes, clearSelection };
}

const option = (root: HTMLElement, label: string, value: string) => {
    const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    expect(select).not.toBeNull();
    select!.value = value;
    select!.dispatchEvent(new Event("change"));
};
const rowsOf = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>("[data-mode]")].map((row) => [
        row.dataset["mode"],
        row.dataset["axis"] ?? null,
        row.querySelector("span:nth-child(2)")?.textContent,
        row.querySelector("span:nth-child(3)")?.textContent,
    ]);

describe("Measure panel", () => {
    let panel: MeasurePanel | undefined;
    const previews: (MeasurementResult | null | undefined)[] = [];
    const onPreview = (_doc: unknown, result?: MeasurementResult | null) => {
        previews.push(result);
    };
    beforeEach(() => {
        previews.length = 0;
        PubSub.default.sub("measurementPreview", onPreview);
    });
    afterEach(() => {
        panel?.dispose();
        panel = undefined;
        PubSub.default.remove("measurementPreview", onPreview);
    });

    test("lists the entities, every value in Onshape's order with a (x) button, and filters by measure type", async () => {
        let picks: unknown[] = [];
        const create = rs.fn(async (_mode: MeasurementMode) => {});
        pairProvider(create, () => picks);
        const { doc, view, setSelectedShapes, clearSelection } = setup(() => picks);
        panel = new MeasurePanel(view);
        const root = panel.element;
        expect(root.querySelector('[role="listbox"]')?.textContent).toBe("Select entities to measure");
        expect(root.textContent).toContain("Select geometry to measure.");

        picks = [{ owner: { node: {} } }, { owner: { node: {} } }];
        doc.selection.onShapeChanged.emit([]);
        await Promise.resolve();
        const entities = [...root.querySelectorAll('[role="option"]')].map((row) => row.textContent);
        expect(entities).toEqual(["Vertex of Reducing End Cap×", "Vertex of Reducing End Cap×"]);
        expect(rowsOf(root)).toEqual([
            ["distance", null, "13.00", "mm"],
            ["deltaX", "x", "3.00", "mm"],
            ["deltaY", "y", "4.00", "mm"],
            ["deltaZ", "z", "12.00", "mm"],
            ["maxDistance", null, "20.00", "mm"],
            ["centerDistance", null, "15.00", "mm"],
            ["angle", null, "90.000", "°"],
            ["tangentAngle", null, "45.000", "°"],
        ]);
        expect(root.querySelector('[data-mode="distance"] span')?.textContent).toBe("Min dist:");
        expect(root.querySelector('[data-mode="deltaX"] span')?.textContent).toBe("X ≑");
        // (x) makes a variable of that one value
        const make = root.querySelector<HTMLButtonElement>('[aria-label="Create variable from ΔY"]');
        expect(make).not.toBeNull();
        make!.click();
        await Promise.resolve();
        expect(create).toHaveBeenCalledWith("deltaY");
        expect(doc.application.activeView).toBe(view);

        // units
        option(root, "Length unit", "in");
        expect(rowsOf(root)[0]).toEqual(["distance", null, "0.51", "in"]);
        option(root, "Angle unit", "rad");
        expect(rowsOf(root).find((row) => row[0] === "angle")).toEqual(["angle", null, "1.570796", "rad"]);

        // a measure type keeps its rows and previews the first in the viewport
        option(root, "Measure type", "maxDistance");
        expect(rowsOf(root).map((row) => row[0])).toEqual(["maxDistance"]);
        expect(previews.at(-1)?.mode).toBe("maxDistance");
        option(root, "Measure type", "distance");
        expect(rowsOf(root).map((row) => row[0])).toEqual(["distance", "deltaX", "deltaY", "deltaZ"]);
        option(root, "Measure type", "radius");
        expect(root.textContent).toContain("does not apply");
        option(root, "Measure type", "all");
        expect(previews.at(-1)).toBeUndefined();
        expect(root.querySelector<HTMLOptionElement>('option[value="curvature"]')?.disabled).toBe(true);

        // × drops one entity from the selection
        const remove = root.querySelectorAll<HTMLButtonElement>('[aria-label^="Remove "]');
        expect(remove).toHaveLength(2);
        remove[1].click();
        expect(clearSelection).toHaveBeenCalledTimes(1);
        expect(setSelectedShapes.mock.calls[0][0]).toEqual([picks[0]]);
    });

    test("the reference coordinate system reads components along the chosen plane", async () => {
        const picks: unknown[] = [{ owner: { node: {} } }, { owner: { node: {} } }];
        const frames = pairProvider(
            async () => {},
            () => picks,
        );
        const { view } = setup(() => picks);
        panel = new MeasurePanel(view);
        const root = panel.element;
        const frame = root.querySelector<HTMLSelectElement>('select[aria-label="Coordinate system"]');
        expect(frame).not.toBeNull();
        expect(frame!.hidden).toBe(true);
        const check = root.querySelector<HTMLInputElement>('input[aria-label="Reference coordinate system"]');
        expect(check).not.toBeNull();
        check!.checked = true;
        check!.dispatchEvent(new Event("change"));
        expect(frame!.hidden).toBe(false);
        expect([...frame!.options].map((o) => o.textContent)).toEqual(["View workplane"]);
        expect(frames.at(-1)).toEqual(planeFrame(Plane.XY));
        expect(rowsOf(root).find((row) => row[0] === "deltaX")).toEqual(["deltaX", "x", "6.00", "mm"]);
        check!.checked = false;
        check!.dispatchEvent(new Event("change"));
        expect(rowsOf(root).find((row) => row[0] === "deltaX")).toEqual(["deltaX", "x", "3.00", "mm"]);
    });
});

test("filterRows tells a point's position from a circle's center, and measureRows orders Onshape's way", () => {
    const row = (mode: MeasurementMode, label: string) => ({
        mode,
        label,
        value: 1,
        quantity: "length" as const,
        result: { mode, label, value: 1, segments: [] },
    });
    const rows = [row("positionX", "X"), row("positionX", "Center X"), row("length", "Length")];
    expect(filterRows(rows, "position").map((r) => r.label)).toEqual(["X"]);
    expect(filterRows(rows, "centerPosition").map((r) => r.label)).toEqual(["Center X"]);
    expect(filterRows(rows, "curvature")).toEqual([]);
    registerSelectionMeasurementProvider({
        evaluate: (_doc, mode = "length") =>
            Result.ok({
                key: "k",
                modes: ["length", "area", "positionX"],
                measurement: { mode, label: mode, value: 2, segments: [] },
                createVariable: async () => {},
            }),
    });
    const doc = createMockDocument();
    const measured = measureRows(doc);
    expect(measured.isOk).toBe(true);
    expect(measured.value.rows.map((r) => r.mode)).toEqual(["length", "positionX", "area"]);
    expect(measured.value.rows.map((r) => r.quantity)).toEqual(["length", "length", "area"]);
});

test("planeFrame takes a plane's origin and axes", () => {
    const frame = planeFrame(Plane.YZ);
    expect(frame.origin).toEqual(Plane.YZ.origin);
    expect(frame.zvec).toEqual(Plane.YZ.normal);
    const view: IView = createMockView({ workplane: Plane.YZ });
    expect(planeFrame(view.workplane)).toEqual(frame);
});
