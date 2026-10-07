// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamParameterSpec } from "../model/operation";

/** Typed reads of an operation's `params`, each falling back when missing or invalid. */
export class ParamReader {
    constructor(private readonly params: Readonly<Record<string, unknown>>) {}

    has(key: string): boolean {
        return this.params[key] !== undefined && this.params[key] !== null && this.params[key] !== "";
    }

    num(key: string, fallback: number): number {
        const value = this.params[key];
        const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
        return typeof n === "number" && Number.isFinite(n) ? n : fallback;
    }

    /** A number, or undefined when the parameter is unset. */
    optionalNum(key: string): number | undefined {
        if (!this.has(key)) return undefined;
        const n = this.num(key, Number.NaN);
        return Number.isFinite(n) ? n : undefined;
    }

    int(key: string, fallback: number): number {
        return Math.round(this.num(key, fallback));
    }

    bool(key: string, fallback: boolean): boolean {
        const value = this.params[key];
        if (typeof value === "boolean") return value;
        if (value === "true") return true;
        if (value === "false") return false;
        return fallback;
    }

    pick<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
        const value = this.params[key];
        return typeof value === "string" && (allowed as readonly string[]).includes(value)
            ? (value as T)
            : fallback;
    }

    str(key: string, fallback: string): string {
        const value = this.params[key];
        return typeof value === "string" ? value : fallback;
    }
}

/** Option rows for an enum parameter from value → label pairs. */
export function options(entries: Record<string, string>): { value: string; label: string }[] {
    return Object.entries(entries).map(([value, label]) => ({ value, label }));
}

/** Shown only while `key` has one of `values`. */
export function when(key: string, ...values: unknown[]): CamParameterSpec["visibleWhen"] {
    return { key, values };
}
