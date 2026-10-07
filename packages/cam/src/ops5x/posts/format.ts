// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamProgram } from "../../model/post";
import type { ToolData } from "../../model/tool";
import type { ToolpathData } from "../../model/toolpath";
import { asciiCommentText } from "../../posts/gcodeWriter";

/**
 * The few formatting helpers the 5-axis posts share: number styles, modal word
 * suppression and option reading. (Self-contained; a shared G-code writer may replace it.)
 */

export interface NumberStyle {
    readonly decimals: number;
    /** "10." for whole numbers (Fanuc); otherwise "10". */
    readonly trailingDot?: boolean;
    /** Always write the decimals ("10.000"). */
    readonly fixed?: boolean;
    /** "+10.000" (Heidenhain). */
    readonly plusSign?: boolean;
}

export function formatNumber(value: number, style: NumberStyle): string {
    const factor = 10 ** style.decimals;
    let rounded = Math.round(value * factor) / factor;
    if (Object.is(rounded, -0) || Math.abs(rounded) < 0.5 / factor) rounded = 0;
    let text = rounded.toFixed(style.decimals);
    if (!style.fixed && style.decimals > 0) {
        text = text.replace(/0+$/, "");
        if (text.endsWith(".")) text = style.trailingDot ? text : text.slice(0, -1);
    }
    if (style.plusSign && rounded >= 0) text = `+${text}`;
    return text;
}

/** Remembers the last value of each address so unchanged (modal) words are left out. */
export class ModalWords {
    private readonly last = new Map<string, string>();

    /** `address + text` when it differs from the last one written (or `force`), else "". */
    word(address: string, text: string, force = false): string {
        if (!force && this.last.get(address) === text) return "";
        this.last.set(address, text);
        return `${address}${text}`;
    }

    /** Forgets addresses (all when none given), e.g. after a reference return. */
    reset(...addresses: string[]): void {
        if (addresses.length === 0) this.last.clear();
        for (const address of addresses) this.last.delete(address);
    }
}

/** Joins the non-empty words of a block with spaces. */
export function words(...parts: (string | undefined | false)[]): string {
    return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

export function option<T>(
    options: Readonly<Record<string, unknown>> | undefined,
    key: string,
    fallback: T,
): T {
    const value = options?.[key];
    return value === undefined ? fallback : (value as T);
}

/** Program number from the setup's program name when it is numeric. */
export function programNumber(program: CamProgram, fallback = 1000): number {
    const text = program.setup.programName ?? "";
    return /^\d+$/.test(text) ? Number(text) : fallback;
}

export function spindleRpm(path: ToolpathData, tool: ToolData): number | undefined {
    return path.spindleRpm ?? tool.cutting.spindleRpm;
}

export function coolantOf(path: ToolpathData, tool: ToolData): NonNullable<ToolData["cutting"]["coolant"]> {
    return path.coolant ?? tool.cutting.coolant ?? "off";
}

/** "D10 FLAT ENDMILL" style description. */
export function toolDescription(tool: ToolData): string {
    const kind = tool.kind.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
    const corner = tool.cornerRadius ? ` R${formatNumber(tool.cornerRadius, { decimals: 3 })}` : "";
    return `D${formatNumber(tool.diameter, { decimals: 3 })}${corner} ${kind} - ${tool.name}`;
}

/** Text safe inside a Fanuc-style ( ) comment. */
export function parenComment(text: string): string {
    return `(${asciiCommentText(text.replace(/[()]/g, "")).toUpperCase()})`;
}

/** A `; text` comment line (Heidenhain, Siemens), in the ASCII a control reads. */
export function semicolonComment(text: string): string {
    return `; ${asciiCommentText(text)}`;
}
