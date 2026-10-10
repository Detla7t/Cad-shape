// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Drawing, type DrawingEntity, drawingBounds, formatNumber } from "./drawing";

/**
 * ASCII DXF R12 (AC1009) — the dialect every CAD, CAM, laser and plasma package reads —
 * with only LINE, ARC, CIRCLE and TEXT entities. Units are the drawing's: millimetres
 * (`$INSUNITS` 4, `$MEASUREMENT` 1) or inches (`$INSUNITS` 1, `$MEASUREMENT` 0);
 * coordinates keep nine decimals. Dashed layers use a DASHED line type defined in the file,
 * its pattern scaled to the units (6 mm, or ¼ in).
 */

type Group = readonly [code: number, value: string | number];

const pairs = (groups: readonly Group[]) =>
    groups
        .map(
            ([code, value]) =>
                `${String(code).padStart(3, " ")}\n${typeof value === "number" ? formatNumber(value) : value}`,
        )
        .join("\n");

/** DXF text is ASCII: the degree, diameter and plus-minus signs have control codes. */
export function dxfText(text: string): string {
    return text
        .replace(/°/g, "%%d")
        .replace(/[Øø⌀]/g, "%%c")
        .replace(/±/g, "%%p")
        .replace(/[^\x20-\x7e]/g, "?");
}

function entityGroups(entity: DrawingEntity): Group[] {
    switch (entity.kind) {
        case "line":
            return [
                [0, "LINE"],
                [8, entity.layer],
                [10, entity.a[0]],
                [20, entity.a[1]],
                [30, 0],
                [11, entity.b[0]],
                [21, entity.b[1]],
                [31, 0],
            ];
        case "arc":
            return [
                [0, "ARC"],
                [8, entity.layer],
                [10, entity.center[0]],
                [20, entity.center[1]],
                [30, 0],
                [40, entity.radius],
                [50, entity.startAngle],
                [51, entity.endAngle],
            ];
        case "circle":
            return [
                [0, "CIRCLE"],
                [8, entity.layer],
                [10, entity.center[0]],
                [20, entity.center[1]],
                [30, 0],
                [40, entity.radius],
            ];
        case "text":
            return [
                [0, "TEXT"],
                [8, entity.layer],
                [10, entity.position[0]],
                [20, entity.position[1]],
                [30, 0],
                [40, entity.height],
                [1, dxfText(entity.text)],
                [50, entity.rotation],
                // Centered (72 = 1) on the middle (73 = 2) of the alignment point 11/21.
                [72, 1],
                [73, 2],
                [11, entity.position[0]],
                [21, entity.position[1]],
                [31, 0],
            ];
    }
}

export interface DxfOptions {
    /**
     * Properties to travel with the file: as `999` comments at its head (which every DXF
     * reader skips and a person reads), and as `$CUSTOMPROPERTYTAG`/`$CUSTOMPROPERTY` header
     * pairs (AutoCAD's custom drawing properties).
     */
    readonly properties?: Readonly<Record<string, string>>;
}

/** The file's DXF release, as AutoCAD names it: Release 11-12 (`AC1009`), the one this writer produces. */
export const DXF_VERSIONS = [{ id: "AC1009", name: "Release 11-12" }] as const;

export function writeDxf(drawing: Drawing, options: DxfOptions = {}): string {
    const bounds = drawingBounds(drawing) ?? { min: [0, 0], max: [0, 0] };
    const inch = drawing.units === "inch";
    // The dash pattern is 6 mm (4 on, 2 off) in millimetre files and its nearest ¼ in in inch ones.
    const dash = inch ? 0.25 : 6;
    const properties = Object.entries(options.properties ?? {}).filter(([key]) => key.trim() !== "");
    const comments: Group[] = properties.map(([key, value]) => [
        999,
        `${key}=${value}`.replace(/[\r\n]+/g, " "),
    ]);
    const header: Group[] = [
        ...comments,
        [0, "SECTION"],
        [2, "HEADER"],
        [9, "$ACADVER"],
        [1, "AC1009"],
        ...properties.flatMap(([key, value]): Group[] => [
            [9, "$CUSTOMPROPERTYTAG"],
            [1, key],
            [9, "$CUSTOMPROPERTY"],
            [1, value.replace(/[\r\n]+/g, " ")],
        ]),
        [9, "$INSUNITS"],
        [70, inch ? 1 : 4],
        [9, "$MEASUREMENT"],
        [70, inch ? 0 : 1],
        [9, "$EXTMIN"],
        [10, bounds.min[0]],
        [20, bounds.min[1]],
        [30, 0],
        [9, "$EXTMAX"],
        [10, bounds.max[0]],
        [20, bounds.max[1]],
        [30, 0],
        [0, "ENDSEC"],
    ];
    const lineTypes: Group[] = [
        [0, "TABLE"],
        [2, "LTYPE"],
        [70, 2],
        [0, "LTYPE"],
        [2, "CONTINUOUS"],
        [70, 0],
        [3, "Solid line"],
        [72, 65],
        [73, 0],
        [40, 0],
        [0, "LTYPE"],
        [2, "DASHED"],
        [70, 0],
        [3, "Dashed __ __ __"],
        [72, 65],
        [73, 2],
        [40, dash],
        [49, (dash * 2) / 3],
        [49, -dash / 3],
        [0, "ENDTAB"],
    ];
    const layers = [{ name: "0", aci: 7, color: "#000000", dashed: false }, ...drawing.layers];
    const layerTable: Group[] = [
        [0, "TABLE"],
        [2, "LAYER"],
        [70, layers.length],
        ...layers.flatMap((layer): Group[] => [
            [0, "LAYER"],
            [2, layer.name],
            [70, 0],
            [62, layer.aci],
            [6, layer.dashed === true ? "DASHED" : "CONTINUOUS"],
        ]),
        [0, "ENDTAB"],
    ];
    const tables: Group[] = [[0, "SECTION"], [2, "TABLES"], ...lineTypes, ...layerTable, [0, "ENDSEC"]];
    const entities: Group[] = [
        [0, "SECTION"],
        [2, "ENTITIES"],
        ...drawing.entities.flatMap(entityGroups),
        [0, "ENDSEC"],
    ];
    return `${pairs([...header, ...tables, ...entities, [0, "EOF"]])}\n`;
}

// ------------------------------------------------------------------ Reading back

export interface DxfEntity {
    readonly type: string;
    readonly layer: string;
    /** First value of each group code; numeric codes (10–59, 62, 70–79) as numbers. */
    readonly values: Readonly<Record<number, string | number>>;
}

export interface DxfContent {
    readonly header: Readonly<Record<string, string | number>>;
    readonly layers: readonly string[];
    readonly entities: readonly DxfEntity[];
}

const isNumericCode = (code: number) =>
    (code >= 10 && code <= 59) || code === 62 || (code >= 70 && code <= 79);

/** Reads the header variables, layer names and entities of an ASCII DXF (enough to check a written file). */
export function readDxf(text: string): DxfContent {
    const lines = text.split(/\r?\n/);
    const groups: [number, string][] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
        groups.push([Number.parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
    }
    const header: Record<string, string | number> = {};
    const layers: string[] = [];
    const entities: DxfEntity[] = [];
    let section = "";
    let current: { type: string; values: Record<number, string | number> } | undefined;
    let variable: string | undefined;
    const flush = () => {
        if (current !== undefined && section === "ENTITIES") {
            entities.push({
                type: current.type,
                layer: String(current.values[8] ?? "0"),
                values: current.values,
            });
        }
        if (current?.type === "LAYER" && typeof current.values[2] === "string")
            layers.push(current.values[2]);
        current = undefined;
    };
    for (let i = 0; i < groups.length; i++) {
        const [code, value] = groups[i];
        if (code === 0) {
            flush();
            if (value === "SECTION") {
                section = groups[i + 1]?.[0] === 2 ? groups[i + 1][1] : "";
                i++;
                continue;
            }
            if (value === "ENDSEC" || value === "EOF") {
                section = "";
                continue;
            }
            current = { type: value, values: {} };
            continue;
        }
        if (section === "HEADER") {
            if (code === 9) variable = value;
            else if (variable !== undefined && header[variable] === undefined) {
                header[variable] = isNumericCode(code) ? Number(value) : value;
            }
            continue;
        }
        if (current !== undefined && current.values[code] === undefined) {
            current.values[code] = isNumericCode(code) ? Number(value) : value;
        }
    }
    flush();
    return { header, layers, entities };
}
