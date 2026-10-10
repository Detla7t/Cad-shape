// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { Drawing } from "@chili3d/parametric";

/**
 * DWG through `@node-projects/acad-ts` (MIT; a TypeScript port of ACadSharp): writing
 * drawings as AutoCAD 2004 DWG, and reading DWG files LibreDWG refuses. Its own lazily
 * loaded chunk.
 */

/** The part of acad-ts used here (its published .d.ts files do not pass strict checks). */
interface AcadPoint {
    readonly x: number;
}
interface AcadEntity {
    layer: unknown;
}
interface AcadDocument {
    header: { version: number; insUnits: number } | null;
    /** Drawing properties, when the port carries them. */
    summaryInfo?: {
        title?: string;
        subject?: string;
        comments?: string;
        properties?: Map<string, string>;
    } | null;
    layers: { tryGetValue(name: string): AcadLayer | undefined; add(layer: AcadLayer): void } | null;
    modelSpace: { entities: { add(entity: AcadEntity): void } } | null;
}
interface AcadLayer {
    color: unknown;
}
interface AcadTs {
    ACadVersion: { AC1018: number };
    UnitsType: { Millimeters: number; Inches: number };
    TextHorizontalAlignment: { Center: number };
    TextVerticalAlignmentType: { Middle: number };
    CadDocument: new () => AcadDocument;
    Layer: new (name: string) => AcadLayer;
    Color: new (index: number) => unknown;
    XYZ: new (x: number, y: number, z: number) => AcadPoint;
    Line: new () => AcadEntity & { startPoint: AcadPoint; endPoint: AcadPoint };
    Circle: new () => AcadEntity & { center: AcadPoint; radius: number };
    Arc: new () => AcadEntity & { center: AcadPoint; radius: number; startAngle: number; endAngle: number };
    TextEntity: new (
        value: string,
    ) => AcadEntity & {
        height: number;
        rotation: number;
        horizontalAlignment: number;
        verticalAlignment: number;
        insertPoint: AcadPoint;
        alignmentPoint: AcadPoint;
    };
    DwgReader: { readFromStream(stream: ArrayBuffer, notification?: () => void): AcadDocument };
    DwgWriter: { writeToBuffer(document: AcadDocument): Uint8Array };
    DxfWriter: { writeToStream(target: { write(value: string): void }, document: AcadDocument): void };
}

// A non-literal type keeps TypeScript out of the package's declarations; the bundler still
// sees the literal specifier.
const load = async () => (await import("@node-projects/acad-ts" as string)) as AcadTs;

export async function acadDwgToDxf(bytes: Uint8Array): Promise<Result<{ dxf: string }>> {
    const acad = await load();
    const document = acad.DwgReader.readFromStream(bytes.slice().buffer, () => {});
    const chunks: string[] = [];
    acad.DxfWriter.writeToStream({ write: (value: string) => chunks.push(value) }, document);
    const text = chunks.join("");
    return text.length === 0 ? Result.err("acad-ts wrote no DXF") : Result.ok({ dxf: text });
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

export interface DwgOptions {
    /** Drawing properties, stored in the file's summary info when the writer supports it. */
    readonly properties?: Readonly<Record<string, string>>;
}

/** `drawing` as an AutoCAD 2004 (AC1018) DWG in the drawing's units (millimetres unless `inch`). */
export async function drawingToDwg(drawing: Drawing, options: DwgOptions = {}): Promise<Uint8Array> {
    const acad = await load();
    const document = new acad.CadDocument();
    const properties = Object.entries(options.properties ?? {});
    if (properties.length > 0 && document.summaryInfo) {
        try {
            document.summaryInfo.comments = properties.map(([key, value]) => `${key}=${value}`).join("\n");
            document.summaryInfo.properties ??= new Map();
            for (const [key, value] of properties) document.summaryInfo.properties.set(key, value);
        } catch {
            // The port carries no custom properties: the comments line above is all it keeps.
        }
    }
    if (document.header !== null) {
        document.header.version = acad.ACadVersion.AC1018;
        document.header.insUnits =
            drawing.units === "inch" ? acad.UnitsType.Inches : acad.UnitsType.Millimeters;
    }
    const layers = new Map<string, AcadLayer>();
    for (const info of drawing.layers) {
        const existing = document.layers?.tryGetValue(info.name);
        const layer = existing ?? new acad.Layer(info.name);
        layer.color = new acad.Color(Math.min(255, Math.max(1, info.aci)));
        if (existing === undefined) document.layers?.add(layer);
        layers.set(info.name, layer);
    }
    const space = document.modelSpace;
    if (space === null) throw new Error("The DWG document has no model space");
    const point = (p: readonly [number, number]) => new acad.XYZ(p[0], p[1], 0);
    for (const entity of drawing.entities) {
        let item: AcadEntity;
        if (entity.kind === "line") {
            const line = new acad.Line();
            line.startPoint = point(entity.a);
            line.endPoint = point(entity.b);
            item = line;
        } else if (entity.kind === "circle") {
            const circle = new acad.Circle();
            circle.center = point(entity.center);
            circle.radius = entity.radius;
            item = circle;
        } else if (entity.kind === "arc") {
            const arc = new acad.Arc();
            arc.center = point(entity.center);
            arc.radius = entity.radius;
            arc.startAngle = radians(entity.startAngle);
            arc.endAngle = radians(entity.endAngle);
            item = arc;
        } else {
            const text = new acad.TextEntity(entity.text);
            text.height = entity.height;
            text.rotation = radians(entity.rotation);
            text.horizontalAlignment = acad.TextHorizontalAlignment.Center;
            text.verticalAlignment = acad.TextVerticalAlignmentType.Middle;
            text.insertPoint = point(entity.position);
            text.alignmentPoint = point(entity.position);
            item = text;
        }
        const layer = layers.get(entity.layer);
        if (layer !== undefined) item.layer = layer;
        space.entities.add(item);
    }
    return acad.DwgWriter.writeToBuffer(document);
}
