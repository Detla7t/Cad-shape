// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EndCapParams, validateEndCap } from "../endcap/endCap";
import { formatFractionalInches, parseInches } from "../endcap/inches";
import { DUCT_SIZES, defaultWallHeight, ductSize } from "../endcap/sizes";

/**
 * The End Cap configuration as its form edits it — Onshape's configuration panel: the
 * "Endcap" checkbox (a plain cap; unchecked makes a reducing cap), OD and ID lists with a
 * Custom entry, and the "Wall Height" override. Text stays as typed until it parses.
 */
export interface EndCapFormValue {
    readonly endcap: boolean;
    /** A preset diameter (`String(inches)`) or `"custom"`. */
    readonly od: string;
    readonly customOd: string;
    readonly id: string;
    readonly customId: string;
    readonly customWallHeight: boolean;
    readonly wallHeight: string;
}

export const CUSTOM_SIZE = "custom";

export const DEFAULT_END_CAP_FORM: EndCapFormValue = {
    endcap: false,
    od: "9.625",
    customOd: '9 5/8"',
    id: "6.625",
    customId: '6 5/8"',
    customWallHeight: false,
    wallHeight: formatFractionalInches(defaultWallHeight(9.625)),
};

export const SIZE_OPTIONS = [
    ...DUCT_SIZES.map((size) => ({ value: String(size.inches), label: size.label })),
    { value: CUSTOM_SIZE, label: "Custom" },
];

export interface EndCapFormErrors {
    readonly od?: string;
    readonly id?: string;
    readonly wallHeight?: string;
    /** A problem of the combination (an ID not under the OD…). */
    readonly cap?: string;
}

export interface EndCapFormResult {
    /** The cap to draw; undefined while the form has errors. */
    readonly params?: EndCapParams;
    readonly errors: EndCapFormErrors;
}

function sizeOf(choice: string, custom: string): number | undefined {
    return choice === CUSTOM_SIZE ? parseInches(custom) : Number(choice);
}

/** What the form describes, or why it does not describe a cap yet. */
export function readEndCapForm(value: EndCapFormValue): EndCapFormResult {
    const od = sizeOf(value.od, value.customOd);
    const id = value.endcap ? undefined : sizeOf(value.id, value.customId);
    const wallHeight = value.customWallHeight ? parseInches(value.wallHeight) : undefined;
    const errors: { -readonly [K in keyof EndCapFormErrors]: string } = {};
    if (od === undefined) errors.od = 'Type a diameter in inches, like 9 5/8".';
    if (!value.endcap && id === undefined) errors.id = 'Type a diameter in inches, like 6 5/8".';
    if (value.customWallHeight && wallHeight === undefined)
        errors.wallHeight = 'Type a height in inches, like 2 7/8".';
    if (Object.keys(errors).length > 0 || od === undefined) return { errors };
    const params: EndCapParams = { reducing: !value.endcap, od, id, wallHeight };
    const problem = validateEndCap(params);
    return problem === undefined ? { params, errors } : { errors: { cap: problem } };
}

/** The form showing `params` (presets selected when the sizes are presets). */
export function endCapFormOf(params: EndCapParams): EndCapFormValue {
    const choice = (inches: number | undefined, fallback: string) =>
        inches === undefined ? fallback : ductSize(inches) === undefined ? CUSTOM_SIZE : String(inches);
    return {
        endcap: !params.reducing,
        od: choice(params.od, DEFAULT_END_CAP_FORM.od),
        customOd: formatFractionalInches(params.od),
        id: choice(params.id, DEFAULT_END_CAP_FORM.id),
        customId: params.id === undefined ? DEFAULT_END_CAP_FORM.customId : formatFractionalInches(params.id),
        customWallHeight: params.wallHeight !== undefined,
        wallHeight: formatFractionalInches(params.wallHeight ?? defaultWallHeight(params.od)),
    };
}

/**
 * The cap as URL search parameters (`od`, `id`, `wall` in inches) — how the configurator page
 * hands a cap to the CAD workbench (`/?endcap=1&od=9.625&id=6.625`).
 */
export function endCapSearchParams(params: EndCapParams): URLSearchParams {
    const search = new URLSearchParams({
        endcap: params.reducing ? "reducing" : "plain",
        od: String(params.od),
    });
    if (params.reducing && params.id !== undefined) search.set("id", String(params.id));
    if (params.wallHeight !== undefined) search.set("wall", String(params.wallHeight));
    return search;
}

export function endCapFromSearchParams(search: URLSearchParams): EndCapParams | undefined {
    const kind = search.get("endcap");
    const od = Number(search.get("od"));
    if ((kind !== "plain" && kind !== "reducing") || !(od > 0)) return undefined;
    const id = search.has("id") ? Number(search.get("id")) : undefined;
    const wall = search.has("wall") ? Number(search.get("wall")) : undefined;
    const params: EndCapParams = { reducing: kind === "reducing", od, id, wallHeight: wall };
    return validateEndCap(params) === undefined ? params : undefined;
}
