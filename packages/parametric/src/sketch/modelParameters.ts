// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ModelParameter, Result, registerModelParameters, Transaction, UNITLESS } from "@chili3d/core";
import { SketchEditor } from "./editor/sketchEditor";
import { ConstraintKind, datumUnitSpec, toDisplayDatum } from "./sketchModel";
import { SketchNode } from "./sketchNode";
import { SketchSolver } from "./solver";

registerModelParameters((document) => {
    const slots: ModelParameter[] = [];
    for (const node of document.modelManager.findNodes()) {
        if (!(node instanceof SketchNode)) continue;
        slots.push({
            id: `${node.id}:suppressed`,
            node,
            label: "Unsuppressed",
            value: String(node.suppression),
            unit: UNITLESS,
            boolean: true,
            inverted: true,
            apply(value) {
                Transaction.execute(document, "Configure sketch suppression", () => {
                    node.suppression = value === "true" ? true : value === "false" ? false : String(value);
                });
                return Result.ok(undefined);
            },
        });
        for (const constraint of node.data.constraints) {
            if (constraint.datum === undefined) continue;
            slots.push({
                id: `${node.id}:dimension:${constraint.id}`,
                node,
                label: `${ConstraintKind[constraint.kind]} ${constraint.id}`,
                value:
                    typeof constraint.datum === "number"
                        ? toDisplayDatum(constraint.kind, constraint.datum)
                        : constraint.datum,
                unit: datumUnitSpec(constraint.kind),
                apply(value) {
                    const active = SketchEditor.getActive();
                    if (active?.node === node) return active.setDimension(constraint.id, value);
                    const solver = new SketchSolver(
                        node.plane,
                        node.data,
                        document.variables.evaluate().scope,
                    );
                    try {
                        const set = solver.setDatumSource(constraint.id, value);
                        if (!set.isOk) return set;
                        if (!solver.solve(true).result.startsWith("Ok") || solver.datumErrors.size) {
                            return Result.err("This value conflicts with the sketch constraints.");
                        }
                        Transaction.execute(
                            document,
                            "Edit sketch dimension",
                            () => (node.dataJson = JSON.stringify({ ...node.data, ...solver.toData() })),
                        );
                        return Result.ok(undefined);
                    } finally {
                        solver.dispose();
                    }
                },
            });
        }
    }
    return slots;
});
