// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Content hashes and canonical JSON — the two primitives content addressing rests on. The
 * digest is the synchronous SHA-256 of `foundation/utils/sha256.ts`: `crypto.subtle.digest` is
 * async, and every object the version store writes is hashed on the capture path, inside the
 * same tick as the edit.
 *
 * Determinism is the whole point: the same JSON value hashes to the same id on every run and
 * every machine, which is what lets two branches share an unchanged feature, and two saves of
 * the same document dedupe their objects.
 */

import { sha256Hex } from "../foundation/utils/sha256";

/**
 * The id of a stored object: the first 128 bits of the SHA-256 of its canonical JSON. 128 bits
 * keep ids short (they are repeated in every list that references an object) with a collision
 * chance that is not a practical concern for one document's history.
 */
export function contentHash(text: string): string {
    return sha256Hex(text).slice(0, 32);
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
    [key: string]: JsonValue;
}

/**
 * JSON with sorted object keys and no whitespace — one spelling per value, so equal values hash
 * equally whatever order their keys were written in. `undefined` fields are dropped (as
 * `JSON.stringify` drops them), an `undefined` array slot and a non-finite number become `null`.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || value === undefined) return "null";
    switch (typeof value) {
        case "number":
            return Number.isFinite(value) ? JSON.stringify(value) : "null";
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "object":
            break;
        default:
            return "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map((x) => canonicalJson(x)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
        .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Canonical JSON equality — key order and `undefined` fields do not count. */
export function jsonEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    return canonicalJson(a) === canonicalJson(b);
}

/** A plain-JSON copy of `value` (drops `undefined` fields and functions). */
export function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(canonicalJson(value)) as JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
