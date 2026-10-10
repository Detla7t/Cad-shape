// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IShape,
    type MeasurementFrame,
    type MeasurementMode,
    Result,
    registerSelectionMeasurementProvider,
    type SelectionMeasurement,
    ShapeNode,
} from "@chili3d/core";
import { VariableCommand } from "../commands/variableCommand";
import { captureMeasurement, type MeasurementReference, resolveMeasurementReference } from "./measurement";
import { centerOf, measurementDetails, measureShapes } from "./measurementGeometry";

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

const POSITION_MODES: readonly MeasurementMode[] = ["positionX", "positionY", "positionZ"];

/** The modes the shapes support — the main values first (what the readout offers), then the rest of the panel's rows. */
function availableModes(shapes: readonly IShape[], hasDistance: boolean): MeasurementMode[] {
    const modes: MeasurementMode[] = [];
    const ok = (mode: MeasurementMode) => measureShapes(mode, shapes).isOk;
    if (shapes.length === 2 && hasDistance) {
        modes.push("distance", "maxDistance");
        if (shapes.every((shape) => centerOf(shape) !== undefined)) modes.push("centerDistance");
    }
    if (shapes.length === 1 && ok("diameter")) modes.push("diameter", "radius");
    if (ok("length")) modes.push("length");
    if (ok("area")) modes.push("area");
    if (shapes.length === 2) {
        if (hasDistance) modes.push("deltaX", "deltaY", "deltaZ");
        if (ok("angle")) modes.push("angle");
        if (ok("tangentAngle")) modes.push("tangentAngle");
    }
    if (shapes.length === 1 && centerOf(shapes[0]) !== undefined) modes.push(...POSITION_MODES);
    return modes;
}

export function measureSelection(
    document: IDocument,
    requested?: MeasurementMode,
    frame?: MeasurementFrame,
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
        const refs = selected.value;
        const key = JSON.stringify([refs, frame ?? null]);
        const entities = refs.map((ref) => ({ label: ref.label, nodeId: ref.nodeId }));
        const createVariable = (mode: MeasurementMode) =>
            VariableCommand.createMeasured(document, { mode, entities: refs, ...(frame ? { frame } : {}) });
        const distance = shapes.length === 2 ? measureShapes("distance", shapes, frame) : undefined;
        const witness = distance?.isOk ? distance.value : undefined;
        const modes = availableModes(shapes, witness !== undefined);
        if (!modes.length) return Result.err("Select an edge, round face, boundary, point, or two entities.");
        const main = modes.filter((mode) => !POSITION_MODES.includes(mode));
        const mode = requested && modes.includes(requested) ? requested : main[0];
        if (mode === undefined) {
            // a lone point: Onshape shows its coordinates, not one value
            return Result.ok({
                key,
                modes,
                details: measurementDetails(shapes, undefined, frame),
                entities,
                createVariable,
            });
        }
        const result =
            mode === "distance" && witness !== undefined
                ? Result.ok(witness)
                : measureShapes(mode, shapes, frame);
        if (!result.isOk) return Result.err(result.error);
        const isDistance = mode === "distance" || mode === "maxDistance" || mode === "centerDistance";
        return Result.ok({
            key,
            modes,
            measurement: result.value,
            details: measurementDetails(shapes, isDistance ? result.value : witness, frame),
            entities,
            createVariable,
        });
    } catch (error) {
        return Result.err(`Measurement unavailable: ${String(error)}`);
    } finally {
        for (const shape of shapes) shape.dispose();
    }
}

registerSelectionMeasurementProvider({ evaluate: measureSelection });
