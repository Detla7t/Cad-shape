// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "../config";
import type { IDocument } from "../document";
import { PubSub } from "../foundation/pubsub";
import { Result } from "../foundation/result";
import { Transaction } from "../foundation/transaction";
import {
    defaultUserPreferences,
    QUANTITY_UNITS,
    type QuantityKind,
    type QuantityPreferences,
} from "../userPreferences";
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

export function initializeDocumentPreferences(document: IDocument): void {
    const preferences = Config.instance.preferences;
    document.userData = {
        ...document.userData,
        displayUnits: { ...preferences.defaultUnits },
        quantityUnits: structuredClone(preferences.quantities),
    };
}

export function documentQuantityUnits(document: IDocument): QuantityPreferences {
    return {
        ...defaultUserPreferences().quantities,
        ...(document.userData?.["quantityUnits"] as Partial<QuantityPreferences>),
    };
}

export function setDocumentQuantityUnits(document: IDocument, units: QuantityPreferences): void {
    const before = documentQuantityUnits(document);
    const after = structuredClone(units);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const apply = (value: QuantityPreferences) => {
        document.userData = { ...document.userData, quantityUnits: structuredClone(value) };
        PubSub.default.pub("documentUnitsChanged", document);
        document.visual.update();
    };
    Transaction.execute(document, "Change physical quantity units", () => {
        apply(after);
        Transaction.add(document, {
            name: "Physical quantity units",
            undo: () => apply(before),
            redo: () => apply(after),
            dispose() {},
        });
    });
}

export function documentQuantityUnit(document: IDocument, kind: QuantityKind) {
    const settings = documentQuantityUnits(document)[kind];
    const unit =
        QUANTITY_UNITS[kind].units.find(([id]) => id === settings.unit) ?? QUANTITY_UNITS[kind].units[0];
    return { suffix: unit[0], factor: unit[2], precision: Math.max(0, Math.min(8, settings.precision)) };
}

export function formatPreferenceNumber(value: number, precision: number): string {
    const text = value.toFixed(precision);
    return Config.instance.preferences.decimalComma ? text.replace(".", ",") : text;
}

export function formatDocumentQuantity(valueSI: number, document: IDocument, kind: QuantityKind): string {
    const unit = documentQuantityUnit(document, kind);
    return `${formatPreferenceNumber(valueSI / unit.factor, unit.precision)} ${unit.suffix}`;
}

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
    const text = formatPreferenceNumber(value / display.factor, display.precision);
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
    // Only a single quantity literal is localized; commas separating expression arguments are untouched.
    const trimmed =
        Config.instance.preferences.decimalComma &&
        /^\s*[+-]?\d+,\d+(?:[eE][+-]?\d+)?\s*[a-zA-Z°]*\s*$/.test(text)
            ? text.trim().replace(",", ".")
            : text.trim();
    const value = evaluateExpression(trimmed, scope);
    if (!value.isOk) return Result.err(value.error);
    if (!unitSpecEquals(value.value.unit, UNITLESS)) return Result.ok(trimmed);
    const { factor, suffix } = documentUnit(document, unit);
    const numeric = Number(trimmed);
    if (trimmed && Number.isFinite(numeric)) return Result.ok(numeric * factor);
    return Result.ok(factor === 1 ? trimmed : `(${trimmed}) * 1 ${suffix}`);
}
