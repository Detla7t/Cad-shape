// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Transaction } from "@chili3d/core";
import { div, input, label, option, select, span } from "@chili3d/element";
import type { AssemblyNode } from "../model/assemblyNode";
import type { MateData } from "../model/assemblyTypes";
import { solveAssembly } from "../model/solve";
import { MATE_TYPES, type MateType } from "../solver/mateSolver";
import style from "./assembly.module.css";
import { t } from "./linkUi";

/** Mate types with a free coordinate a limit can bound, and its unit. */
const LIMIT_UNITS: Partial<Record<MateType, string>> = { revolute: "°", slider: "mm", cylindrical: "mm" };

const numberOrUndefined = (text: string): number | undefined => {
    const value = Number.parseFloat(text);
    return text.trim() === "" || !Number.isFinite(value) ? undefined : value;
};

/**
 * The selected mate's settings: type, offset (along and about the first connector's Z),
 * limits of its free coordinate and suppression. Each change is one undo step and re-solves.
 */
export function createMateEditor(assembly: AssemblyNode, mate: MateData): HTMLElement {
    const apply = (patch: Partial<MateData>) => {
        Transaction.execute(assembly.document, "edit mate", () => {
            assembly.updateMate(mate.id, patch);
            solveAssembly(assembly);
        });
    };
    const field = (key: Parameters<typeof t>[0], control: HTMLElement, unit = "") =>
        label(
            { className: style.field },
            span({ textContent: t(key) }),
            control,
            unit === "" ? "" : span({ textContent: unit }),
        );
    const numeric = (value: number | undefined, onchange: (value: number | undefined) => void) => {
        const element = input({
            type: "number",
            step: "any",
            className: style.select,
            value: value === undefined ? "" : String(value),
        });
        element.onchange = () => onchange(numberOrUndefined(element.value));
        element.onkeydown = (e) => e.stopPropagation();
        return element;
    };

    const type = select({ className: style.select });
    for (const each of MATE_TYPES) {
        type.append(
            option({
                value: each,
                textContent: t(`assembly.mateType.${each}`),
                selected: each === mate.type,
            }),
        );
    }
    type.onchange = () => apply({ type: type.value as MateType, limits: undefined });

    const offset = mate.offset ?? {};
    const suppressed = input({ type: "checkbox", checked: mate.suppressed === true });
    suppressed.onchange = () => apply({ suppressed: suppressed.checked });
    const unit = LIMIT_UNITS[mate.type];
    const limits = mate.limits ?? {};
    return div(
        { className: style.mateEditor },
        field("assembly.mateType", type),
        field(
            "assembly.offset",
            numeric(offset.z, (z) => apply({ offset: { ...offset, z } })),
            "mm",
        ),
        field(
            "assembly.rotation",
            numeric(offset.angle, (angle) => apply({ offset: { ...offset, angle } })),
            "°",
        ),
        unit === undefined
            ? ""
            : div(
                  { className: style.limits },
                  field(
                      "assembly.limitMin",
                      numeric(limits.min, (min) => apply({ limits: { ...limits, min } })),
                      unit,
                  ),
                  field(
                      "assembly.limitMax",
                      numeric(limits.max, (max) => apply({ limits: { ...limits, max } })),
                      unit,
                  ),
              ),
        label({ className: style.field }, suppressed, span({ textContent: t("assembly.suppressed") })),
    );
}
