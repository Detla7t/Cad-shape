// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { PubSub } from "../foundation/pubsub";
import { Result } from "../foundation/result";
import { Transaction } from "../foundation/transaction";
import { evaluateExpression, type ParameterValue, type Scope } from "./expression";
import { UNITLESS, type UnitSpec, unitSpecEquals } from "./unitSpec";
import { unitSuffix } from "./unitSuffix";

export interface DocumentUnits {
    length: "mm" | "cm" | "m" | "in" | "ft";
    angle: "deg" | "rad";
    lengthPrecision: number;
    anglePrecision: number;
}
const defaults: DocumentUnits = { length: "mm", angle: "deg", lengthPrecision: 2, anglePrecision: 1 };

export function documentUnits(document: IDocument): DocumentUnits {
    const value = document.userData?.["displayUnits"] as Partial<DocumentUnits> | undefined;
    const precision = (value: unknown, fallback: number) =>
        typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 8 ? value : fallback;
    return {
        length: ["mm", "cm", "m", "in", "ft"].includes(value?.length ?? "")
            ? value!.length!
            : defaults.length,
        angle: value?.angle === "rad" ? "rad" : "deg",
        lengthPrecision: precision(value?.lengthPrecision, defaults.lengthPrecision),
        anglePrecision: precision(value?.anglePrecision, defaults.anglePrecision),
    };
}

/** Document metadata is serialized with the project and recorded alongside model changes. */
export function setDocumentUnits(document: IDocument, units: DocumentUnits): void {
    const before = documentUnits(document);
    const after = { ...units };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const apply = (value: DocumentUnits) => {
        document.userData = { ...document.userData, displayUnits: { ...value } };
        PubSub.default.pub("documentUnitsChanged", document);
        document.visual.update();
    };
    Transaction.execute(document, "Change document units and precision", () => {
        apply(after);
        Transaction.add(document, {
            name: "Document units",
            undo: () => apply(before),
            redo: () => apply(after),
            dispose() {},
        });
    });
}

export function documentUnit(
    document: IDocument,
    unit: UnitSpec,
): { suffix: string; factor: number; precision: number } {
    const settings = documentUnits(document);
    if (unitSpecEquals(unit, UNITLESS)) return { suffix: "", factor: 1, precision: settings.lengthPrecision };
    const angle = unit.angle !== 0;
    const suffix = angle ? settings.angle : settings.length;
    return {
        suffix,
        factor: unitSuffix(suffix)!.factor,
        precision: angle ? settings.anglePrecision : settings.lengthPrecision,
    };
}

/** Input/output boundary only: model lengths remain millimetres, angles remain degrees. */
export function formatDocumentValue(
    value: number,
    document: IDocument,
    unit: UnitSpec,
    suffix = true,
): string {
    const display = documentUnit(document, unit);
    const text = (value / display.factor).toFixed(display.precision);
    return suffix && display.suffix
        ? `${text}${display.suffix === "deg" ? "°" : ` ${display.suffix}`}`
        : text;
}

/** Bare input adopts the document unit; quantities and named expressions retain their own units. */
export function documentParameterInput(
    text: string,
    document: IDocument,
    unit: UnitSpec,
    scope: Scope,
): Result<ParameterValue> {
    const trimmed = text.trim();
    const value = evaluateExpression(trimmed, scope);
    if (!value.isOk) return Result.err(value.error);
    if (!unitSpecEquals(value.value.unit, UNITLESS)) return Result.ok(trimmed);
    const { factor, suffix } = documentUnit(document, unit);
    const numeric = Number(trimmed);
    if (trimmed && Number.isFinite(numeric)) return Result.ok(numeric * factor);
    return Result.ok(factor === 1 ? trimmed : `(${trimmed}) * 1 ${suffix}`);
}
