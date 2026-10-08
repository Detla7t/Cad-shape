// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IShape,
    type MeasurementMode,
    Result,
    registerSelectionMeasurementProvider,
    type SelectionMeasurement,
    ShapeNode,
} from "@chili3d/core";
import { VariableCommand } from "../commands/variableCommand";
import { captureMeasurement, type MeasurementReference, resolveMeasurementReference } from "./measurement";
import { measureShapes } from "./measurementGeometry";

const capturedSelections = new WeakMap<IDocument, { key: string; refs: MeasurementReference[] }>();

export function selectedMeasurementReferences(document: IDocument): Result<MeasurementReference[]> {
    const picks = document.selection.getSelectedShapes();
    if (picks.length) {
        const key = JSON.stringify(picks.map((pick) => [pick.owner.node.id, pick.shape.id, pick.indexes]));
        // Selection visuals can outlive their kernel sub-shapes after an upstream
        // rebuild. Resolve the captured identities against fresh geometry instead
        // of asking a disposed face/edge for its fingerprint again.
        const captured = capturedSelections.get(document);
        if (captured?.key === key) return Result.ok(captured.refs);
        const refs: MeasurementReference[] = [];
        for (const pick of picks) {
            const node = pick.owner.node;
            if (node instanceof ShapeNode && (node.evaluationError || !node.shape.isOk))
                return Result.err("Resolve the selected feature's error before measuring it.");
            const ref = captureMeasurement(pick);
            if (!ref.isOk) return Result.err(ref.error);
            refs.push(ref.value);
        }
        capturedSelections.set(document, { key, refs });
        return Result.ok(refs);
    }
    capturedSelections.delete(document);
    return Result.ok(
        document.selection
            .getSelectedNodes()
            .filter((node): node is ShapeNode => node instanceof ShapeNode)
            .map((node) => ({ kind: "node", nodeId: node.id, label: node.name })),
    );
}

export function measureSelection(
    document: IDocument,
    requested?: MeasurementMode,
): Result<SelectionMeasurement> {
    const shapes: IShape[] = [];
    try {
        const selected = selectedMeasurementReferences(document);
        if (!selected.isOk) return Result.err(selected.error);
        if (!selected.value.length) return Result.err("Select geometry to measure.");
        for (const ref of selected.value) {
            const resolved = resolveMeasurementReference(document, ref);
            if (!resolved.isOk) return Result.err(resolved.error);
            shapes.push(resolved.value);
        }
        const modes: MeasurementMode[] = [];
        if (shapes.length === 2) modes.push("distance", "maxDistance");
        const diameter = shapes.length === 1 ? measureShapes("diameter", shapes) : undefined;
        if (diameter?.isOk) modes.push("diameter", "radius");
        const length = measureShapes("length", shapes);
        if (length.isOk) modes.push("length");
        if (!modes.length) return Result.err("Select an edge, round face, boundary, or two entities.");
        const mode = requested && modes.includes(requested) ? requested : modes[0];
        const result =
            mode === "length" ? length : mode === "diameter" ? diameter! : measureShapes(mode, shapes);
        if (!result.isOk) return Result.err(result.error);
        const refs = selected.value;
        return Result.ok({
            key: JSON.stringify(refs),
            modes,
            measurement: result.value,
            createVariable: (mode) => VariableCommand.createMeasured(document, { mode, entities: refs }),
        });
    } catch (error) {
        return Result.err(`Measurement unavailable: ${String(error)}`);
    } finally {
        shapes.forEach((shape) => shape.dispose());
    }
}

registerSelectionMeasurementProvider({ evaluate: measureSelection });
