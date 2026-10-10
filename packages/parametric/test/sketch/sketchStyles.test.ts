// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, DisplayScale, Plane } from "@chili3d/core";
import { entityDisplayMesh } from "../../src/sketch/entityMesh";
import { sketchDrawing } from "../../src/sketch/sketchDrawing";
import { ConstraintKind, shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

test("construction, layers and colors survive solve, serialization, reset and deletion", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        solver.setLayers(
            [
                { id: "0", name: "0", color: "#4a9eff" },
                { id: "guide", name: "Guides", color: "#ff00ff" },
            ],
            "guide",
        );
        solver.constructionMode = true;
        const guide = solver.addLine(0, 0, 30, 5);
        solver.addConstraint({
            kind: ConstraintKind.Horizontal,
            refs: [
                { entityId: guide, pointIndex: 0 },
                { entityId: guide, pointIndex: 1 },
            ],
        });
        solver.constructionMode = false;
        const circle = solver.addCircle(40, 0, 8);
        solver.setEntityStyle(circle, { color: "#00ff00" });
        solver.solve(true);
        const data = solver.toData();
        solver.reset(JSON.parse(JSON.stringify(data)));
        expect(solver.entity(guide)).toMatchObject({ construction: true, layer: "guide" });
        expect(solver.entity(circle)).toMatchObject({ color: "#00ff00", layer: "guide" });
        expect(solver.sketchLayers()[1]).toMatchObject({ name: "Guides", color: "#ff00ff" });
        expect(solver.activeLayer).toBe("guide");
        expect(shapeEntityIds(solver.toData())).toEqual([circle]);
        const drawing = sketchDrawing(solver.toData());
        expect(drawing.layers.find((layer) => layer.name === "Guides_CONSTRUCTION")).toMatchObject({
            color: "#ff00ff",
            dashed: true,
        });
        solver.setLayers(solver.sketchLayers().map((layer) => ({ ...layer, visible: layer.id !== "guide" })));
        expect(solver.entityVisible(solver.entity(guide)!)).toBe(false);
        solver.removeEntity(guide);
        expect(solver.toData().entities.map((entity) => entity.id)).toEqual([circle]);
        expect(solver.toData().constraints).toEqual([]);
    } finally {
        solver.dispose();
    }
});

test("curve display gains segments when zoomed in and construction uses visible dash spacing", () => {
    const circle = { id: 1, type: "circle" as const, params: [0, 0, 50] };
    const coarse = entityDisplayMesh(Plane.XY, circle, 0x4a9eff, true, 1);
    const fine = entityDisplayMesh(Plane.XY, circle, 0x4a9eff, true, 0.01);
    expect(fine.position.length).toBeGreaterThan(coarse.position.length);
    expect(fine.lineType).toBe("solid"); // Gaps are geometry so the four-part pattern survives tessellation.
    const start = fine.position.slice(0, 3),
        end = fine.position.slice(3, 6);
    // The first dash is Graphics ▸ first dash, in pixels, at the 0.01 world-units-per-pixel
    // scale — the pattern's period snapped to a 1-2-5 step of model units.
    const g = Config.instance.graphics;
    const unit = DisplayScale.dashUnit(0.01, g.firstDash + g.firstGap + g.secondDash + g.secondGap);
    const firstDash = g.firstDash * unit;
    expect(Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2])).toBeCloseTo(firstDash, 4);
    expect(firstDash / (g.firstDash * 0.01)).toBeGreaterThan(0.6);
    expect(firstDash / (g.firstDash * 0.01)).toBeLessThan(1.7);
});

test("fixed entities remain solved beside flexible geometry, without changing live data", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const fixed = solver.addLine(0, 0, 20, 5);
        const free = solver.addLine(0, 10, 20, 10);
        for (const pointIndex of [0, 1]) {
            const ref = { entityId: fixed, pointIndex };
            solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref], datums: solver.pointOf(ref) });
        }
        solver.addConstraint({
            kind: ConstraintKind.Horizontal,
            refs: [
                { entityId: free, pointIndex: 0 },
                { entityId: free, pointIndex: 1 },
            ],
        });
        solver.solve(true);
        const data = solver.toData();
        expect(solver.fullyConstrainedEntities()).toEqual(new Set([fixed]));
        expect(solver.dofs()).toBe(3);
        expect(solver.toData()).toEqual(data);
    } finally {
        solver.dispose();
    }
});

test("redundant satisfied dimensions do not mark fixed geometry as movable", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const line = solver.addLine(-40, 20, 40, 20);
        solver.addCircle(0, 70, 15);
        for (const pointIndex of [0, 1]) {
            const ref = { entityId: line, pointIndex };
            solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref], datums: solver.pointOf(ref) });
        }
        const refs = [
            { entityId: line, pointIndex: 0 },
            { entityId: line, pointIndex: 1 },
        ];
        solver.addConstraint({ kind: ConstraintKind.Horizontal, refs });
        solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs, datum: 80 });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.fullyConstrainedEntities()).toEqual(new Set([line]));
    } finally {
        solver.dispose();
    }
});
