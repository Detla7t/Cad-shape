// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    type DialogButton,
    documentExportNameResolver,
    documentUnit,
    download,
    exportFileName,
    formatDocumentValue,
    I18n,
    type I18nKeys,
    type IDocument,
    Localize,
    PubSub,
    UNITLESS,
    unitSpecEquals,
    unitSpecOfType,
} from "@chili3d/core";
import {
    convertDrawing,
    type Drawing,
    type DrawingSelection,
    type DrawingUnits,
    DXF_VERSIONS,
    drawingColors,
    filterDrawing,
    writeDxf,
    writePdf,
    writeSvg,
} from "@chili3d/drawing";
import { button, div, input, label, option, select, span, textarea } from "@chili3d/element";
import { writeDwg } from "../cad/dwg";
import style from "./documents.module.css";

/**
 * Onshape's "Export as DXF/DWG" dialog for a 2D drawing (a sketch, a flat pattern, a part's
 * views, a drawing element): the file name from the export rules — every placeholder of the
 * rules editor, the user may still change it —, the format (DXF, DWG, SVG) and its version,
 * the units (the workspace's, or a fixed one), the options the writers honour (splines are
 * sampled as polylines; the sheet is flat, z at zero), and the properties written into the
 * file — free `key = value` lines, the document's variables and the active configuration.
 */

export type ExportDrawingFormat = ".dxf" | ".dwg" | ".svg" | ".pdf" | ".png";

export interface ExportDrawingOptions {
    readonly document: IDocument;
    /** The name the rules start from: the sketch's, the part's, the drawing's. */
    readonly name: string;
    /** The drawing, in millimetres. */
    readonly drawing: () => Drawing;
    readonly format?: ExportDrawingFormat;
}

interface ExportSettings {
    readonly fileName: string;
    readonly format: ExportDrawingFormat;
    readonly units: DrawingUnits;
    readonly properties: Record<string, string>;
    /** Which layers and colours go into the file; everything when absent. */
    readonly selection?: DrawingSelection;
}

/** The resolution a drawing is rasterised at. */
export const PNG_DPI = 300;

const FORMATS: readonly { id: ExportDrawingFormat; name: string; versions: readonly string[] }[] = [
    { id: ".dxf", name: "DXF", versions: DXF_VERSIONS.map((version) => version.name) },
    { id: ".dwg", name: "DWG", versions: ["AutoCAD 2004 (AC1018)"] },
    { id: ".svg", name: "SVG", versions: ["SVG 1.1"] },
    { id: ".pdf", name: "PDF", versions: ["PDF 1.4"] },
    { id: ".png", name: "PNG", versions: [`${PNG_DPI} dpi`] },
];

/**
 * The drawing as a PNG at `dpi`: its SVG drawn onto a canvas (browser only — a drawing is
 * laid out by the SVG renderer, so text and dashes come out exactly as the SVG shows them).
 */
export async function rasterizeDrawing(drawing: Drawing, dpi = PNG_DPI): Promise<Blob> {
    const svg = writeSvg(drawing);
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("The drawing could not be rasterised."));
            image.src = url;
        });
        // the SVG's width and height are physical units, which the browser lays out at 96 dpi
        const scale = dpi / 96;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(image.width * scale));
        canvas.height = Math.max(1, Math.ceil(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("The drawing could not be rasterised.");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
                (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))),
                "image/png",
            ),
        );
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** `key = value` lines as properties; blank lines and lines without `=` are skipped. */
export function parseProperties(text: string): Record<string, string> {
    const properties: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const at = line.indexOf("=");
        if (at <= 0) continue;
        const key = line.slice(0, at).trim();
        if (key) properties[key] = line.slice(at + 1).trim();
    }
    return properties;
}

/** The document's variables as `name = value` properties, in the document's units. */
export function variableProperties(document: IDocument): Record<string, string> {
    const properties: Record<string, string> = {};
    for (const [name, entry] of document.variables.evaluate().scope) {
        if (entry.option !== undefined || !Number.isFinite(entry.value)) continue;
        properties[name] = unitSpecEquals(entry.unit, UNITLESS)
            ? String(Math.round(entry.value * 1e6) / 1e6)
            : formatDocumentValue(entry.value, document, entry.unit);
    }
    return properties;
}

/** The active configuration as `Input = option` properties. */
export function configurationProperties(document: IDocument): Record<string, string> {
    const properties: Record<string, string> = {};
    const resolver = documentExportNameResolver(document);
    for (const input of document.variables.configurationInputs)
        properties[input.name] = resolver(`config:${input.name}`) ?? "";
    return properties;
}

/**
 * Writes the drawing in the chosen format and hands the file out: only the selected layers
 * and colours (`filterDrawing`, before the units change), in every format.
 */
export async function exportDrawingFile(
    drawing: Drawing,
    settings: Omit<ExportSettings, "fileName"> & { fileName: string },
    rasterize: (drawing: Drawing, dpi?: number) => Promise<Blob> = rasterizeDrawing,
): Promise<void> {
    const selected = settings.selection === undefined ? drawing : filterDrawing(drawing, settings.selection);
    const converted = selected.units === settings.units ? selected : convertDrawing(selected, settings.units);
    if (settings.format === ".dwg") {
        const bytes = await writeDwg(converted, { properties: settings.properties });
        if (!bytes.isOk) throw new Error(bytes.error);
        download([bytes.value as BlobPart], settings.fileName);
    } else if (settings.format === ".svg") {
        download([writeSvg(converted, { title: settings.fileName })], settings.fileName);
    } else if (settings.format === ".pdf") {
        download(
            [writePdf(converted, { title: settings.fileName.replace(/\.pdf$/i, "") }) as BlobPart],
            settings.fileName,
        );
    } else if (settings.format === ".png") {
        download([await rasterize(converted, PNG_DPI)], settings.fileName);
    } else download([writeDxf(converted, { properties: settings.properties })], settings.fileName);
}

interface SelectionRow {
    readonly row: HTMLElement;
    readonly box: HTMLInputElement;
}

/**
 * A checkbox row (all ticked) per layer that has entities and per colour drawn, each with its
 * swatch, name and entity count; `selection()` is undefined while everything stays ticked.
 */
export function selectionControls(drawing: Drawing): {
    layers: SelectionRow[];
    colors: SelectionRow[];
    selection: () => DrawingSelection | undefined;
} {
    const counts = new Map<string, number>();
    for (const entity of drawing.entities) counts.set(entity.layer, (counts.get(entity.layer) ?? 0) + 1);
    const row = (
        value: string,
        swatch: string,
        text: string,
        count: number,
        kind: I18nKeys,
    ): SelectionRow => {
        const box = input({ type: "checkbox", checked: true, value });
        box.setAttribute("aria-label", `${I18n.translate(kind)}: ${text}`);
        return {
            box,
            row: label(
                { className: style.exportCheck },
                box,
                span({ className: style.layerSwatch, style: `background-color: ${swatch}` }),
                span({ textContent: text }),
                span({ className: style.muted, textContent: `(${count})` }),
            ),
        };
    };
    const layers = drawing.layers
        .filter((layer) => counts.has(layer.name))
        .map((layer) =>
            row(
                layer.name,
                layer.color,
                layer.name,
                counts.get(layer.name) ?? 0,
                "documents.exportDialog.layers",
            ),
        );
    const colors = drawingColors(drawing).map(({ color, count }) =>
        row(color, color, color, count, "documents.exportDialog.colors"),
    );
    const ticked = (rows: SelectionRow[]) =>
        rows.every((entry) => entry.box.checked)
            ? undefined
            : rows.filter((entry) => entry.box.checked).map((entry) => entry.box.value);
    return {
        layers,
        colors,
        selection: () => {
            const chosen = { layers: ticked(layers), colors: ticked(colors) };
            return chosen.layers === undefined && chosen.colors === undefined ? undefined : chosen;
        },
    };
}

export function showExportDrawingDialog(options: ExportDrawingOptions): void {
    const { document } = options;
    const workspaceUnits: DrawingUnits =
        documentUnit(document, unitSpecOfType("length")).suffix === "in" ? "inch" : "mm";
    const resolver = documentExportNameResolver(document);
    const suggested = (format: ExportDrawingFormat) =>
        exportFileName(options.name, format, Config.instance.preferences.exportRules, new Date(), resolver);
    let format = options.format ?? ".dxf";
    let nameEdited = false;

    const name = input({ className: style.exportName, value: suggested(format) });
    name.setAttribute("aria-label", I18n.translate("documents.exportDialog.fileName"));
    name.oninput = () => {
        nameEdited = true;
    };
    const rulesLink = button({
        className: style.link,
        textContent: new Localize("documents.exportDialog.viewRules"),
        onclick: () => PubSub.default.pub("openPreferences", document, "export"),
    });
    const version = select({ className: style.select, disabled: true });
    version.setAttribute("aria-label", I18n.translate("documents.exportDialog.version"));
    const formatSelect = select(
        { className: style.select },
        ...FORMATS.map((entry) =>
            option({ value: entry.id, textContent: entry.name, selected: entry.id === format }),
        ),
    );
    formatSelect.setAttribute("aria-label", I18n.translate("documents.exportDialog.format"));
    const refreshVersions = () => {
        const entry = FORMATS.find((candidate) => candidate.id === format) ?? FORMATS[0];
        version.replaceChildren(...entry.versions.map((text) => option({ value: text, textContent: text })));
    };
    formatSelect.onchange = () => {
        format = formatSelect.value as ExportDrawingFormat;
        refreshVersions();
        if (!nameEdited) name.value = suggested(format);
        else name.value = name.value.replace(/\.(dxf|dwg|svg|pdf|png)$/i, "") + format;
    };
    refreshVersions();

    const useWorkspace = input({ type: "checkbox", checked: true });
    useWorkspace.setAttribute("aria-label", I18n.translate("documents.exportDialog.workspaceUnits"));
    const units = select(
        { className: style.select, disabled: true },
        option({ value: "mm", textContent: "Millimeter", selected: workspaceUnits === "mm" }),
        option({ value: "inch", textContent: "Inch", selected: workspaceUnits === "inch" }),
    );
    units.setAttribute("aria-label", I18n.translate("documents.exportDialog.units"));
    useWorkspace.onchange = () => {
        units.disabled = useWorkspace.checked;
        if (useWorkspace.checked) units.value = workspaceUnits;
    };

    const delivery = select(
        { className: style.select, disabled: true },
        option({ textContent: I18n.translate("documents.exportDialog.download") }),
    );
    const splines = input({ type: "checkbox", checked: true, disabled: true });
    const zHeight = input({ type: "checkbox", checked: true, disabled: true });

    const properties = textarea({ className: style.exportProperties, rows: 3 });
    properties.value = `document = ${document.name}\nname = ${options.name}`;
    properties.setAttribute("aria-label", I18n.translate("documents.exportDialog.properties"));
    const includeVariables = input({ type: "checkbox" });
    includeVariables.setAttribute("aria-label", I18n.translate("documents.exportDialog.includeVariables"));
    const includeConfiguration = input({ type: "checkbox" });
    includeConfiguration.setAttribute(
        "aria-label",
        I18n.translate("documents.exportDialog.includeConfiguration"),
    );

    const selection = selectionControls(options.drawing());

    const field = (title: string, ...controls: Node[]) =>
        div(
            { className: style.exportField },
            span({ className: style.exportLabel, textContent: title }),
            ...controls,
        );
    const content = div(
        { className: style.exportDialog },
        field(
            I18n.translate("documents.exportDialog.fileName"),
            div({ className: style.exportRow }, name, rulesLink),
        ),
        span({ className: style.muted, textContent: new Localize("documents.exportDialog.nameHint") }),
        field(I18n.translate("documents.exportDialog.format"), formatSelect),
        field(I18n.translate("documents.exportDialog.version"), version),
        ...(selection.layers.length > 1
            ? [
                  field(
                      I18n.translate("documents.exportDialog.layers"),
                      ...selection.layers.map((row) => row.row),
                  ),
              ]
            : []),
        ...(selection.colors.length > 1
            ? [
                  field(
                      I18n.translate("documents.exportDialog.colors"),
                      ...selection.colors.map((row) => row.row),
                  ),
              ]
            : []),
        field(
            I18n.translate("documents.exportDialog.units"),
            label(
                { className: style.exportCheck },
                useWorkspace,
                span({ textContent: new Localize("documents.exportDialog.workspaceUnits") }),
            ),
            units,
        ),
        field(
            I18n.translate("documents.exportDialog.options"),
            delivery,
            label(
                { className: style.exportCheck },
                splines,
                span({ textContent: new Localize("documents.exportDialog.splines") }),
            ),
            label(
                { className: style.exportCheck },
                zHeight,
                span({ textContent: new Localize("documents.exportDialog.zHeight") }),
            ),
        ),
        field(
            I18n.translate("documents.exportDialog.properties"),
            properties,
            span({
                className: style.muted,
                textContent: new Localize("documents.exportDialog.propertiesHint"),
            }),
            label(
                { className: style.exportCheck },
                includeVariables,
                span({ textContent: new Localize("documents.exportDialog.includeVariables") }),
            ),
            label(
                { className: style.exportCheck },
                includeConfiguration,
                span({ textContent: new Localize("documents.exportDialog.includeConfiguration") }),
            ),
        ),
    );

    const settings = (): ExportSettings => ({
        fileName: name.value.trim() || suggested(format),
        format,
        units: (useWorkspace.checked ? workspaceUnits : units.value) as DrawingUnits,
        properties: {
            ...(includeVariables.checked ? variableProperties(document) : {}),
            ...(includeConfiguration.checked ? configurationProperties(document) : {}),
            ...parseProperties(properties.value),
        },
        selection: selection.selection(),
    });
    const buttons: DialogButton[] = [
        {
            content: "documents.exportDialog.export",
            onclick: async () => {
                const chosen = settings();
                try {
                    await exportDrawingFile(options.drawing(), chosen);
                    PubSub.default.pub("showToast", "documents.exportDialog.exported{0}", chosen.fileName);
                } catch (error) {
                    PubSub.default.pub(
                        "showToast",
                        "error.default:{0}",
                        error instanceof Error ? error.message : String(error),
                    );
                }
            },
        },
        { content: "common.cancel" },
    ];
    PubSub.default.pub("showDialog", "documents.exportDialog.title", content, buttons);
}
