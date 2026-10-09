// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ConfigurationInputData,
    type ConfigurationVisibility,
    type IDocument,
    LENGTH_UNITS,
    type ParameterValue,
    quoteConfiguredString,
    Result,
    resolveUnitSpec,
    type Scope,
    selectConfiguredBoolean,
    UNITLESS,
} from "@chili3d/core";
import type { EndCapParams } from "../endcap/endCap";
import { DUCT_SIZES } from "../endcap/sizes";

/**
 * The End Cap Configurator's configuration, as Onshape's Part Studio had it — inputs in the
 * document's Configurations panel that the end cap sketch follows:
 *
 * - **Endcap** (checkbox): a plain cap; off makes a reducing cap.
 * - **OD**, **ID** (lists of the preset sizes plus Custom), with **Custom_OD** / **Custom_ID**
 *   shown while Custom is picked. ID shows only for a reducing cap.
 * - **Wall_Height** (checkbox) with **Finish_Wall_Height**, for a reducer's collar.
 *
 * List option ids are Onshape's (`_9_5_8_`), so a configuration string from the Onshape
 * document names the same options here.
 */

const ID = {
    endcap: "endcap-endcap",
    od: "endcap-od",
    customOd: "endcap-custom-od",
    id: "endcap-id",
    customId: "endcap-custom-id",
    wall: "endcap-wall-height",
    finishWall: "endcap-finish-wall-height",
} as const;

export const END_CAP_INPUT_NAMES = {
    endcap: "Endcap",
    od: "OD",
    customOd: "Custom_OD",
    id: "ID",
    customId: "Custom_ID",
    wall: "Wall_Height",
    finishWall: "Finish_Wall_Height",
} as const;

const CUSTOM = "Custom";

const when = (...conditions: ConfigurationVisibility["conditions"]): ConfigurationVisibility => ({
    match: "all",
    conditions,
});
const reducing = { inputId: ID.endcap, operator: "is", values: [false] } as const;

function sizeList(
    id: string,
    name: string,
    option: "odOption" | "idOption",
    defaultInches: number,
): ConfigurationInputData {
    const options = [
        ...DUCT_SIZES.map((size) => ({ id: size[option], name: size.label })),
        { id: CUSTOM, name: CUSTOM },
    ];
    const fallback = DUCT_SIZES.find((size) => size.inches === defaultInches) ?? DUCT_SIZES[0];
    return { kind: "list", id, name, options, defaultOption: fallback[option] };
}

/** The inputs, in panel order, defaulting to the Onshape document's 9 5/8" × 6 5/8" reducer. */
export function endCapConfigurationInputs(): ConfigurationInputData[] {
    const n = END_CAP_INPUT_NAMES;
    return [
        { kind: "checkbox", id: ID.endcap, name: n.endcap, defaultValue: false },
        sizeList(ID.od, n.od, "odOption", 9.625),
        {
            kind: "variable",
            id: ID.customOd,
            name: n.customOd,
            type: "length",
            defaultExpression: "9.625 in",
            visibility: when({ inputId: ID.od, operator: "is", values: [CUSTOM] }),
        },
        { ...sizeList(ID.id, n.id, "idOption", 6.625), visibility: when(reducing) },
        {
            kind: "variable",
            id: ID.customId,
            name: n.customId,
            type: "length",
            defaultExpression: "6.625 in",
            visibility: when(reducing, { inputId: ID.id, operator: "is", values: [CUSTOM] }),
        },
        { kind: "checkbox", id: ID.wall, name: n.wall, defaultValue: false, visibility: when(reducing) },
        {
            kind: "variable",
            id: ID.finishWall,
            name: n.finishWall,
            type: "length",
            defaultExpression: "2.875 in",
            visibility: when(reducing, { inputId: ID.wall, operator: "is", values: [true] }),
        },
    ];
}

/** `configure(OD, "4\"": 4 in, …, "Custom": Custom_OD)`: the list's size, or the custom value. */
function sizeExpression(list: string, custom: string): string {
    const arms = DUCT_SIZES.map((size) => `${quoteConfiguredString(size.label)}: ${size.inches} in`);
    return `configure(${list}, ${[...arms, `${quoteConfiguredString(CUSTOM)}: ${custom}`].join(", ")})`;
}

/** The values an end cap holds: each a parameter expression, configured by the inputs above. */
export interface EndCapValues {
    /** A plain cap (true / 1) or a reducing one. */
    readonly endcap: ParameterValue;
    /** Lengths, millimetres when a number. */
    readonly od: ParameterValue;
    readonly id: ParameterValue;
    /** The collar's finish wall height; 0 picks the default for the OD. */
    readonly wallHeight: ParameterValue;
}

export function configuredEndCapValues(): EndCapValues {
    const n = END_CAP_INPUT_NAMES;
    return {
        endcap: n.endcap,
        od: sizeExpression(n.od, n.customOd),
        id: sizeExpression(n.id, n.customId),
        wallHeight: `configure(${n.wall}, true: ${n.finishWall}, false: 0)`,
    };
}

/**
 * Adds the inputs `document` lacks (matched by name, so a second end cap — or a user's own
 * OD input — is reused, not duplicated). Records an edit when anything was added.
 */
export function ensureEndCapConfiguration(document: IDocument): void {
    const existing = document.variables.configurationInputs;
    const names = new Set(existing.map((input) => input.name));
    const missing = endCapConfigurationInputs().filter((input) => !names.has(input.name));
    if (missing.length > 0) document.variables.setConfigurationInputs([...existing, ...missing]);
}

function flag(value: ParameterValue, scope: Scope): Result<boolean> {
    const selected = selectConfiguredBoolean(value, scope);
    if (selected.isOk) return selected;
    const number = resolveUnitSpec(value, scope, UNITLESS);
    return number.isOk ? Result.ok(number.value !== 0) : Result.err(number.error);
}

const MM_PER_INCH = 25.4;

/** The cap `values` describe in `scope` (the document's variables and active configuration). */
export function resolveEndCapValues(values: EndCapValues, scope: Scope): Result<EndCapParams> {
    const endcap = flag(values.endcap, scope);
    if (!endcap.isOk) return Result.err(`Endcap: ${endcap.error}`);
    const length = (name: string, value: ParameterValue): Result<number> => {
        const resolved = resolveUnitSpec(value, scope, LENGTH_UNITS);
        // Back to inches, rounded so `6.625 in` is 6.625 again after the trip through millimetres.
        return resolved.isOk
            ? Result.ok(Math.round((resolved.value / MM_PER_INCH) * 1e9) / 1e9)
            : Result.err(`${name}: ${resolved.error}`);
    };
    const od = length("OD", values.od);
    if (!od.isOk) return Result.err(od.error);
    if (endcap.value) return Result.ok({ reducing: false, od: od.value });
    const id = length("ID", values.id);
    if (!id.isOk) return Result.err(id.error);
    const wall = length("Wall height", values.wallHeight);
    if (!wall.isOk) return Result.err(wall.error);
    return Result.ok({
        reducing: true,
        od: od.value,
        id: id.value,
        wallHeight: wall.value > 0 ? wall.value : undefined,
    });
}
