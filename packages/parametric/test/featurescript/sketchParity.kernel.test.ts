// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsContext } from "../../src/featurescript/context/fsContext";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { createInterpreter } from "../../src/featurescript/runtime";
import { sketchEntityEdge } from "../../src/sketch/sketchEntityEdge";
import { ConstraintKind, type SketchData } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

// This compares Chili3D's UI model against both local FeatureScript execution paths.
// It does not certify equivalence to Onshape's proprietary server-side solver.
const interpreters = {
    native: createInterpreter({}),
    onshape: createOnshapeInterpreter({ std: ONSHAPE_STD }),
};
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
let serial = 0;
function build(std: keyof typeof interpreters, plane: Plane, source: string): FsContext {
    const xyz = (v: XYZ) => `vector(${v.x},${v.y},${v.z})`,
        context = new FsContext(),
        interpreter = interpreters[std];
    const module = interpreter.load({
        path: `sketchParity${serial++}`,
        source: `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
export function build(context is Context) {
    const s = newSketchOnPlane(context,newId(),{"sketchPlane":plane(${xyz(plane.origin)} * millimeter,${xyz(plane.normal)},${xyz(plane.xvec)})});
    ${source}
    skSolve(s);
}`,
    });
    try {
        interpreter.callFunction(module.env.lookup("build")?.value, [context.value]);
        return context;
    } catch (error) {
        context.dispose();
        throw error;
    }
}
const ref = (entityId: number, pointIndex: number) => ({ entityId, pointIndex });
const cases: { name: string; data: SketchData; source: string }[] = [
    {
        name: "line length and horizontal constraint move the initial endpoints",
        data: {
            entities: [{ id: 1, type: "line", params: [0, 0, 8, 6] }],
            constraints: [
                { id: 1, kind: ConstraintKind.Fix, refs: [ref(1, 0)], datums: [0, 0] },
                { id: 2, kind: ConstraintKind.Horizontal, refs: [ref(1, 0), ref(1, 1)] },
                { id: 3, kind: ConstraintKind.P2PDistance, refs: [ref(1, 0), ref(1, 1)], datum: 50.8 },
            ],
        },
        source: `skLineSegment(s,"line",{"start":vector(0,0)*inch,"end":vector(8,6)*millimeter});
    skConstraint(s,"fix",{"constraintType":ConstraintType.FIX,"localFirst":"line.start"});
    skConstraint(s,"h",{"constraintType":ConstraintType.HORIZONTAL,"localFirst":"line"});
    skConstraint(s,"size",{"constraintType":ConstraintType.LENGTH,"localFirst":"line","length":2*inch});`,
    },
    {
        name: "circle diameter changes the radius while its center stays fixed",
        data: {
            entities: [{ id: 1, type: "circle", params: [3, 7, 2] }],
            constraints: [
                { id: 1, kind: ConstraintKind.Fix, refs: [ref(1, 0)], datums: [3, 7] },
                { id: 2, kind: ConstraintKind.Radius, refs: [ref(1, 0)], datum: 5 },
            ],
        },
        source: `skCircle(s,"circle",{"center":vector(3,7)*millimeter,"radius":2*millimeter});
    skConstraint(s,"fix",{"constraintType":ConstraintType.FIX,"localFirst":"circle.center"});
    skConstraint(s,"size",{"constraintType":ConstraintType.DIAMETER,"localFirst":"circle","length":10*millimeter});`,
    },
    {
        name: "Bezier control points produce the same exact curve",
        data: {
            entities: [{ id: 1, type: "bezier", params: [0, 0, 3, 10, 10, 10, 20, 0] }],
            constraints: [],
        },
        source: `skBezier(s,"curve",{"points":[vector(0,0)*millimeter,vector(3,10)*millimeter,vector(10,10)*millimeter,vector(20,0)*millimeter]});`,
    },
    {
        name: "arc uses the same sweep and plane orientation",
        data: { entities: [{ id: 1, type: "arc", params: [0, 0, 10, 0, 0, 10] }], constraints: [] },
        source: `skArc(s,"arc",{"start":vector(10,0)*millimeter,"mid":vector(7.0710678118654755,7.0710678118654755)*millimeter,"end":vector(0,10)*millimeter});`,
    },
];
for (const std of ["native", "onshape"] as const)
    for (const plane of [
        Plane.XY,
        Plane.ZX,
        new Plane({ origin: new XYZ(12, 20, 30), normal: new XYZ(0, 1, 1), xvec: XYZ.unitX }),
    ]) {
        describe(`${std} / normal ${plane.normal.x},${plane.normal.y},${plane.normal.z}`, () => {
            test.each(cases)("$name", ({ data, source }) => {
                const solver = new SketchSolver(plane, structuredClone(data)),
                    context = build(std, plane, source);
                try {
                    expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
                    const wire = context.bodies.filter((b) => b.kind === "WIRE" && !b.flags.construction);
                    expect(wire).toHaveLength(1);
                    const edges = wire[0].shape.findSubShapes(ShapeTypes.edge) as IEdge[];
                    expect(edges).toHaveLength(1);
                    const edge = sketchEntityEdge(plane, solver.entities()[0]);
                    expect(edge.isOk).toBe(true);
                    try {
                        expect(edges[0].length()).toBeCloseTo(edge.value.length(), 6);
                        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
                            const p = edge.value.pointAt(
                                edge.value.firstParameter() +
                                    t * (edge.value.lastParameter() - edge.value.firstParameter()),
                            );
                            expect(edges[0].curve.nearestFromPoint(p).distance).toBeLessThan(1e-5);
                        }
                    } finally {
                        edge.value.dispose();
                        edges.forEach((e) => e.dispose());
                    }
                } finally {
                    solver.dispose();
                    context.dispose();
                }
            });
        });
        test(`${std}: conflicting dimensions fail instead of publishing unsolved geometry`, () => {
            expect(() =>
                build(
                    std,
                    plane,
                    `skCircle(s,"c",{"center":vector(0,0)*millimeter,"radius":2*millimeter});
        skConstraint(s,"r1",{"constraintType":ConstraintType.RADIUS,"localFirst":"c","length":5*millimeter});
        skConstraint(s,"r2",{"constraintType":ConstraintType.RADIUS,"localFirst":"c","length":8*millimeter});`,
                ),
            ).toThrow(/skSolve/);
        });
    }
