// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { I18n } from "../i18n";
import { GeometryNode } from "../model/geometryNode";
import { formatDocumentValue } from "../parameters/documentUnits";
import { resolveUnitSpec } from "../parameters/expression";
import { type ModelParameter, modelParameters } from "../parameters/modelParameters";

/** A characteristic's tolerance band, in the slot's unit (mm, degrees, or none). */
export interface InspectionTolerance {
    readonly minus: number;
    readonly plus: number;
}

export type InspectionSlot = ModelParameter & { node: GeometryNode };

/** One toleranced characteristic — Onshape's inspection item — with its nominal and limits. */
export interface InspectionCharacteristic {
    readonly slot: InspectionSlot;
    readonly value: number;
    readonly tolerance: InspectionTolerance;
    /** The row as the panel and the CSV print it: characteristic, nominal, −, +, lower, upper. */
    readonly texts: readonly string[];
}

/** The tolerances a geometry node stores, by slot id. */
export function inspectionTolerances(node: GeometryNode): Record<string, InspectionTolerance> {
    try {
        return JSON.parse(node.inspectionJson);
    } catch {
        return {};
    }
}

/** The numeric slots of geometry nodes — what can be toleranced. */
export function inspectionSlots(document: IDocument): InspectionSlot[] {
    return modelParameters(document).filter(
        (slot): slot is InspectionSlot =>
            !slot.boolean && !slot.options && !slot.text && slot.node instanceof GeometryNode,
    );
}

export function inspectionHeaders(): string[] {
    return [
        I18n.translate("inspection.characteristic"),
        I18n.translate("inspection.nominal"),
        I18n.translate("inspection.minusTolerance"),
        I18n.translate("inspection.plusTolerance"),
        I18n.translate("inspection.lower"),
        I18n.translate("inspection.upper"),
    ];
}

/** Every toleranced characteristic of the document (or of one model), in model-tree order. */
export function inspectionCharacteristics(document: IDocument, modelId?: string): InspectionCharacteristic[] {
    const scope = document.variables.evaluate().scope;
    const items: InspectionCharacteristic[] = [];
    for (const slot of inspectionSlots(document)) {
        if (modelId && slot.node.id !== modelId) continue;
        const tolerance = inspectionTolerances(slot.node)[slot.id];
        if (tolerance === undefined) continue;
        const resolved = resolveUnitSpec(slot.value, scope, slot.unit);
        if (!resolved.isOk) continue;
        const value = resolved.value;
        const formatted = (v: number) =>
            slot.unit.angle || slot.unit.length
                ? formatDocumentValue(v, document, slot.unit)
                : String(Number(v.toFixed(5)));
        items.push({
            slot,
            value,
            tolerance,
            texts: [
                `${slot.node.name} / ${slot.label}`,
                formatted(value),
                String(tolerance.minus),
                String(tolerance.plus),
                formatted(value - tolerance.minus),
                formatted(value + tolerance.plus),
            ],
        });
    }
    return items;
}

/** Onshape's "Inspection list" export: the characteristics as CSV, headers first. */
export function inspectionCsv(document: IDocument, modelId?: string): string {
    const rows = [
        inspectionHeaders(),
        ...inspectionCharacteristics(document, modelId).map((item) => item.texts),
    ];
    return rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n");
}
