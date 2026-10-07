// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";

/**
 * The structure of a DXF file — header variables, layers, blocks and model-space
 * entities as group-code records — read from ASCII or binary (R13+) DXF. No geometry is
 * interpreted here (`dxfToDrawing.ts` does that); POLYLINE/VERTEX/SEQEND and
 * INSERT/ATTRIB/SEQEND sequences are folded into their owner record.
 */

export type DxfValue = string | number;
export type DxfGroup = readonly [code: number, value: DxfValue];

export interface DxfRecord {
    readonly type: string;
    readonly groups: readonly DxfGroup[];
    /** VERTEX records of a POLYLINE, ATTRIB records of an INSERT. */
    readonly children: readonly DxfRecord[];
}

export interface DxfLayerInfo {
    readonly name: string;
    /** AutoCAD color index; negative when the layer is off. */
    readonly color: number;
    readonly lineType: string;
    readonly frozen: boolean;
}

export interface DxfBlock {
    readonly name: string;
    readonly base: readonly [number, number, number];
    readonly flags: number;
    readonly entities: readonly DxfRecord[];
}

export interface DxfFile {
    readonly header: ReadonlyMap<string, DxfValue | readonly DxfValue[]>;
    readonly layers: ReadonlyMap<string, DxfLayerInfo>;
    readonly blocks: ReadonlyMap<string, DxfBlock>;
    readonly entities: readonly DxfRecord[];
}

const BINARY_SENTINEL = "AutoCAD Binary DXF\r\n\x1a\0";

/** Group codes whose values are numbers (everything else is text). */
export function isNumericCode(code: number): boolean {
    return (
        (code >= 10 && code <= 99) ||
        (code >= 110 && code <= 179) ||
        (code >= 210 && code <= 299) ||
        (code >= 370 && code <= 389) ||
        (code >= 400 && code <= 409) ||
        (code >= 420 && code <= 429) ||
        (code >= 440 && code <= 459) ||
        (code >= 460 && code <= 469) ||
        (code >= 1010 && code <= 1071)
    );
}

// ------------------------------------------------------------------ Groups

function decodeText(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        // Pre-2007 DXF is written in the drawing's code page; Windows-1252 is by far the most common.
        return new TextDecoder("windows-1252").decode(bytes);
    }
}

function asciiGroups(text: string): Result<DxfGroup[]> {
    const lines = text.split(/\r?\n/);
    const groups: DxfGroup[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const codeText = lines[i].trim();
        if (codeText === "" && i + 2 >= lines.length) break;
        const code = Number.parseInt(codeText, 10);
        if (!Number.isFinite(code) || !/^-?\d+$/.test(codeText)) {
            return Result.err(`Not a DXF file: line ${i + 1} should hold a group code, not "${codeText}"`);
        }
        const raw = lines[i + 1].replace(/\r$/, "");
        if (isNumericCode(code)) {
            const value = Number.parseFloat(raw.trim());
            groups.push([code, Number.isFinite(value) ? value : 0]);
        } else {
            // Text content (1, 3) keeps its spaces; names and handles are trimmed.
            groups.push([code, code === 1 || code === 3 ? raw : raw.trim()]);
        }
    }
    return Result.ok(groups);
}

function binaryGroups(bytes: Uint8Array): Result<DxfGroup[]> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const groups: DxfGroup[] = [];
    let at = BINARY_SENTINEL.length;
    const decoder = new TextDecoder("utf-8");
    const readString = () => {
        const end = bytes.indexOf(0, at);
        if (end < 0) throw new Error("unterminated string");
        const value = decoder.decode(bytes.subarray(at, end));
        at = end + 1;
        return value;
    };
    try {
        while (at + 2 <= bytes.length) {
            const code = view.getInt16(at, true);
            at += 2;
            let value: DxfValue;
            if (code >= 310 && code <= 319) {
                const length = bytes[at];
                value = Array.from(bytes.subarray(at + 1, at + 1 + length), (b) =>
                    b.toString(16).padStart(2, "0"),
                ).join("");
                at += 1 + length;
            } else if (
                (code >= 10 && code <= 59) ||
                (code >= 110 && code <= 149) ||
                (code >= 210 && code <= 239) ||
                (code >= 460 && code <= 469) ||
                (code >= 1010 && code <= 1059)
            ) {
                value = view.getFloat64(at, true);
                at += 8;
            } else if (
                (code >= 60 && code <= 79) ||
                (code >= 170 && code <= 179) ||
                (code >= 270 && code <= 289) ||
                (code >= 370 && code <= 389) ||
                (code >= 400 && code <= 409) ||
                (code >= 1060 && code <= 1070)
            ) {
                value = view.getInt16(at, true);
                at += 2;
            } else if (
                (code >= 90 && code <= 99) ||
                (code >= 420 && code <= 429) ||
                (code >= 440 && code <= 449) ||
                code === 1071
            ) {
                value = view.getInt32(at, true);
                at += 4;
            } else if (code >= 160 && code <= 169) {
                value = Number(view.getBigInt64(at, true));
                at += 8;
            } else if (code >= 290 && code <= 299) {
                value = bytes[at];
                at += 1;
            } else {
                value = readString();
            }
            groups.push([code, value]);
            if (code === 0 && value === "EOF") break;
        }
    } catch {
        return Result.err("The binary DXF file is truncated or damaged");
    }
    return Result.ok(groups);
}

/** The group codes of a DXF file (ASCII, or binary R13 and later). */
export function readDxfGroups(input: Uint8Array | string): Result<DxfGroup[]> {
    if (typeof input !== "string") {
        let sentinel = "";
        for (let i = 0; i < BINARY_SENTINEL.length && i < input.length; i++) {
            sentinel += String.fromCharCode(input[i]);
        }
        if (sentinel === BINARY_SENTINEL) return binaryGroups(input);
        return asciiGroups(decodeText(input));
    }
    return asciiGroups(input.replace(/^﻿/, ""));
}

// ------------------------------------------------------------------ Structure

const num = (record: DxfRecord | readonly DxfGroup[], code: number, fallback = 0): number => {
    const groups = "groups" in record ? record.groups : record;
    const group = groups.find(([c]) => c === code);
    return group !== undefined && typeof group[1] === "number" ? group[1] : fallback;
};

const str = (record: DxfRecord | readonly DxfGroup[], code: number, fallback = ""): string => {
    const groups = "groups" in record ? record.groups : record;
    const group = groups.find(([c]) => c === code);
    return group === undefined ? fallback : String(group[1]);
};

export const dxfNumber = num;
export const dxfString = str;

/** All values of `code`, in order (vertex lists, knots, weights). */
export function dxfAll(record: DxfRecord, code: number): DxfValue[] {
    return record.groups.filter(([c]) => c === code).map(([, value]) => value);
}

/** Splits groups into records at each code 0. */
function records(groups: readonly DxfGroup[], start: number, end: number): DxfRecord[] {
    const result: { type: string; groups: DxfGroup[]; children: DxfRecord[] }[] = [];
    for (let i = start; i < end; i++) {
        const [code, value] = groups[i];
        if (code === 0) result.push({ type: String(value), groups: [], children: [] });
        else result.at(-1)?.groups.push(groups[i]);
    }
    return result;
}

/** Folds VERTEX…SEQEND into POLYLINE and ATTRIB…SEQEND into INSERT. */
function foldSequences(list: readonly DxfRecord[]): DxfRecord[] {
    const result: DxfRecord[] = [];
    let owner: { type: string; groups: readonly DxfGroup[]; children: DxfRecord[] } | undefined;
    for (const record of list) {
        if (owner !== undefined) {
            if (record.type === "SEQEND") {
                owner = undefined;
                continue;
            }
            if (record.type === "VERTEX" || record.type === "ATTRIB") {
                owner.children.push(record);
                continue;
            }
            owner = undefined;
        }
        if (record.type === "POLYLINE" || (record.type === "INSERT" && num(record, 66) === 1)) {
            owner = { type: record.type, groups: record.groups, children: [] };
            result.push(owner);
            continue;
        }
        result.push(record);
    }
    return result;
}

interface Section {
    readonly name: string;
    readonly start: number;
    readonly end: number;
}

function sections(groups: readonly DxfGroup[]): Section[] {
    const found: Section[] = [];
    for (let i = 0; i < groups.length; i++) {
        if (groups[i][0] !== 0 || groups[i][1] !== "SECTION") continue;
        const name = groups[i + 1]?.[0] === 2 ? String(groups[i + 1][1]) : "";
        let end = i + 2;
        while (end < groups.length && !(groups[end][0] === 0 && groups[end][1] === "ENDSEC")) end++;
        found.push({ name, start: i + 2, end });
        i = end;
    }
    return found;
}

function readHeader(groups: readonly DxfGroup[], section: Section): Map<string, DxfValue | DxfValue[]> {
    const header = new Map<string, DxfValue | DxfValue[]>();
    let name: string | undefined;
    let values: DxfValue[] = [];
    const flush = () => {
        if (name !== undefined) header.set(name, values.length === 1 ? values[0] : values);
    };
    for (let i = section.start; i < section.end; i++) {
        const [code, value] = groups[i];
        if (code === 9) {
            flush();
            name = String(value);
            values = [];
        } else if (name !== undefined) {
            values.push(value);
        }
    }
    flush();
    return header;
}

function readLayers(groups: readonly DxfGroup[], section: Section): Map<string, DxfLayerInfo> {
    const layers = new Map<string, DxfLayerInfo>();
    for (const record of records(groups, section.start, section.end)) {
        if (record.type !== "LAYER") continue;
        const name = str(record, 2);
        if (name === "") continue;
        layers.set(name, {
            name,
            color: num(record, 62, 7),
            lineType: str(record, 6, "CONTINUOUS"),
            frozen: (num(record, 70) & 1) !== 0,
        });
    }
    return layers;
}

function readBlocks(groups: readonly DxfGroup[], section: Section): Map<string, DxfBlock> {
    const blocks = new Map<string, DxfBlock>();
    let current:
        | { name: string; base: [number, number, number]; flags: number; list: DxfRecord[] }
        | undefined;
    for (const record of records(groups, section.start, section.end)) {
        if (record.type === "BLOCK") {
            current = {
                name: str(record, 2),
                base: [num(record, 10), num(record, 20), num(record, 30)],
                flags: num(record, 70),
                list: [],
            };
        } else if (record.type === "ENDBLK") {
            if (current !== undefined) {
                blocks.set(current.name, {
                    name: current.name,
                    base: current.base,
                    flags: current.flags,
                    entities: foldSequences(current.list),
                });
            }
            current = undefined;
        } else {
            current?.list.push(record);
        }
    }
    return blocks;
}

/** Reads a DXF file's header, layers, blocks and entities. */
export function readDxfFile(input: Uint8Array | string): Result<DxfFile> {
    const groups = readDxfGroups(input);
    if (!groups.isOk) return Result.err(groups.error);
    const found = sections(groups.value);
    if (found.length === 0) return Result.err("Not a DXF file: it has no SECTION");
    let header = new Map<string, DxfValue | DxfValue[]>();
    let layers = new Map<string, DxfLayerInfo>();
    let blocks = new Map<string, DxfBlock>();
    let entities: DxfRecord[] = [];
    for (const section of found) {
        if (section.name === "HEADER") header = readHeader(groups.value, section);
        else if (section.name === "TABLES") layers = readLayers(groups.value, section);
        else if (section.name === "BLOCKS") blocks = readBlocks(groups.value, section);
        else if (section.name === "ENTITIES") {
            entities = foldSequences(records(groups.value, section.start, section.end));
        }
    }
    return Result.ok({ header, layers, blocks, entities });
}
