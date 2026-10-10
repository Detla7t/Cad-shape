// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    type DialogButton,
    type DrawingTemplate,
    formatDocumentValue,
    I18n,
    type I18nKeys,
    LENGTH_UNITS,
    Localize,
    PubSub,
    readFilesAsync,
    Transaction,
} from "@chili3d/core";
import {
    type Drawing,
    type DrawingEntity,
    type DrawingSelection,
    drawingBounds,
    filterDrawing,
    type Point2,
    writePdf,
} from "@chili3d/drawing";
import { button, dialog, div, h3, input, label, option, p, select, span } from "@chili3d/element";
import { partStudioNodes, writeDxf, writeSvg } from "@chili3d/parametric";
import { activeDrawing, type IActiveDrawing, setActiveDrawing } from "../../activeDrawing";
import {
    ANNOTATION_LAYERS,
    dimensionEntities,
    layersUsed,
    noteEntity,
    parseScale,
    readSheetProperties,
    splitSheet,
    withEntities,
} from "../../cad/drawingAnnotations";
import { addDrawingSketch } from "../../cad/drawingToSketch";
import { importDwg, writeDwg } from "../../cad/dwg";
import { DXF_UNITS, type ImportedDrawing, importDxf } from "../../cad/dxfToDrawing";
import { projectionDrawing } from "../../cad/projection";
import { SHEET_SIZES, type SheetOptions, sheetLayout, sheetSizeNamed } from "../../cad/sheetDrawing";
import { uniqueElementName } from "../../importers";
import { labelButton, toolButton } from "../controls";
import style from "../documents.module.css";
import { rasterizeDrawing, selectionControls, showExportDrawingDialog } from "../exportDialog";
import type { DocumentExport, IDocumentViewer, ViewerContext } from "../viewer";

/**
 * DXF and DWG drawings: the model space drawn as SVG (pan by dragging, zoom with the
 * wheel), layers that can be hidden, what the import left out, the drawing units (a
 * unitless file can be told its units), "Create sketch" to bring the geometry into the
 * Part Studio, and exports as DXF R12, SVG or DWG.
 *
 * A DXF drawing is also a sheet to annotate (the Drawing toolbar): notes and linear
 * dimensions placed by clicking, edited by double-clicking their text; a title block
 * regenerated from its fields; the Part Studio's views re-inserted; templates saved and
 * imported. Edits change the drawing in memory and Save writes the DXF back into the node
 * as one undo step. The sheet's own data (size, scale, title block) lives in the DXF's
 * leading comments (`readSheetProperties`).
 */

const UNIT_CHOICES = [4, 5, 6, 1, 2] as const; // mm, cm, m, in, ft
const SVG_MARGIN = 2;

/** Stores the templates with the user's preferences. */
function saveTemplates(drawingTemplates: DrawingTemplate[]): void {
    Config.instance.preferences = { ...Config.instance.preferences, drawingTemplates };
    Config.instance.saveToStorage();
}

type Tool = "none" | "note" | "dimension";

export function createDrawingViewer({ node, document, changed }: ViewerContext): IDocumentViewer {
    const canvasHost = div({ className: style.drawingCanvas });
    const facts = div({ className: style.facts });
    const layerList = div();
    const status = span({ className: style.muted });
    const unitMenu = select({ className: style.select, title: new Localize("documents.drawing.units") });
    let imported: ImportedDrawing | undefined;
    /** The drawing as edited; the imported one until a tool changes it. */
    let drawing: Drawing | undefined;
    let properties: Record<string, string> = {};
    let dirty = false;
    let tool: Tool = "none";
    let pending: Point2 | undefined;
    let toMm: number | undefined;
    let svgElement: SVGSVGElement | undefined;
    let view = { x: 0, y: 0, width: 1, height: 1 };
    const editable = () => node.format === "dxf";
    const appearance = () => {
        const dark = Config.instance.preferences.drawingBackground === "dark";
        canvasHost.style.background = dark ? "#25272b" : "#ffffff";
        for (const element of svgElement?.querySelectorAll<SVGElement>("[stroke]") ?? []) {
            const original = element.dataset["originalStroke"] ?? element.getAttribute("stroke")!;
            element.dataset["originalStroke"] = original;
            if (["#000", "#000000", "black", "#fff", "#ffffff", "white"].includes(original.toLowerCase()))
                element.setAttribute("stroke", dark ? "#eeeeee" : "#222222");
        }
    };
    const preferencesChanged = (key: keyof Config) => {
        if (key === "preferences") appearance();
    };
    Config.instance.onPropertyChanged(preferencesChanged);

    const applyView = () =>
        svgElement?.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);

    const setStatus = (key?: Parameters<typeof I18n.translate>[0]) => {
        status.textContent = key === undefined ? "" : I18n.translate(key);
    };

    const markDirty = () => {
        dirty = true;
        changed();
    };

    const render = (keepView = false) => {
        if (drawing === undefined || imported === undefined) return;
        const previous = { ...view };
        canvasHost.innerHTML = writeSvg(drawing, { margin: SVG_MARGIN, strokeWidth: 0.25 }).replace(
            /^<\?xml[^>]*>\s*/,
            "",
        );
        svgElement = canvasHost.querySelector("svg") ?? undefined;
        appearance();
        const box = svgElement?.getAttribute("viewBox")?.split(" ").map(Number);
        if (svgElement !== undefined && box?.length === 4) {
            svgElement.removeAttribute("width");
            svgElement.removeAttribute("height");
            svgElement.setAttribute("preserveAspectRatio", "xMidYMid meet");
            view = keepView ? previous : { x: box[0], y: box[1], width: box[2] || 1, height: box[3] || 1 };
            applyView();
        }
        wireTextEditing();
        const skipped = Object.entries(imported.skipped);
        facts.replaceChildren(
            p({
                textContent: I18n.translate(
                    "documents.drawing.summary{0}{1}{2}",
                    drawing.entities.length,
                    drawing.layers.length,
                    imported.version ?? "",
                ),
            }),
            ...(properties["scale"]
                ? [p({ textContent: `${I18n.translate("documents.drawing.scale")} ${properties["scale"]}` })]
                : []),
            ...(imported.units.assumed
                ? [p({ textContent: new Localize("documents.drawing.unitsAssumed") })]
                : []),
            ...(skipped.length === 0
                ? []
                : [
                      p({
                          textContent: `${I18n.translate("documents.drawing.skipped")}: ${skipped.map(([type, n]) => `${type} ×${n}`).join(", ")}`,
                      }),
                  ]),
        );
        layerList.replaceChildren(
            ...drawing.layers.map((layer) => {
                const box = input({ type: "checkbox", checked: true });
                box.onchange = () => {
                    for (const group of Array.from(svgElement?.querySelectorAll("g") ?? [])) {
                        if (group.id === layer.name)
                            (group as SVGGElement).style.display = box.checked ? "" : "none";
                    }
                };
                return label(
                    { className: style.layer },
                    box,
                    span({ className: style.swatch, style: `background-color: ${layer.color}` }),
                    span({ textContent: layer.name }),
                );
            }),
        );
    };

    /** Double-clicking a note's or dimension's text edits it. */
    const wireTextEditing = () => {
        if (svgElement === undefined || drawing === undefined || !editable()) return;
        for (const layerName of [ANNOTATION_LAYERS.notes.name, ANNOTATION_LAYERS.dimensions.name]) {
            const group = svgElement.querySelector<SVGGElement>(`g[id="${layerName}"]`);
            if (group === null) continue;
            const texts = Array.from(group.querySelectorAll("text"));
            const entities = drawing.entities.filter(
                (entity) => entity.layer === layerName && entity.kind === "text",
            );
            texts.forEach((text, index) => {
                const entity = entities[index];
                if (entity === undefined || entity.kind !== "text") return;
                text.style.cursor = "text";
                text.addEventListener("dblclick", (event) => {
                    event.stopPropagation();
                    const next = window.prompt(I18n.translate("documents.drawing.editText"), entity.text);
                    if (next === null || next === entity.text) return;
                    replaceEntity(entity, next.trim() === "" ? undefined : { ...entity, text: next });
                });
            });
        }
    };

    const replaceEntity = (entity: DrawingEntity, next: DrawingEntity | undefined) => {
        if (drawing === undefined) return;
        const entities = drawing.entities.flatMap((candidate) =>
            candidate === entity ? (next === undefined ? [] : [next]) : [candidate],
        );
        drawing = { ...drawing, entities };
        markDirty();
        render(true);
    };

    const load = async () => {
        canvasHost.replaceChildren(
            div({ className: style.message, textContent: new Localize("documents.loading") }),
        );
        const options = toMm === undefined ? {} : { toMm };
        const result =
            node.format === "dwg" ? await importDwg(node.bytes, options) : importDxf(node.bytes, options);
        if (!result.isOk) {
            canvasHost.replaceChildren(div({ className: style.error, textContent: result.error }));
            return;
        }
        imported = result.value;
        drawing = imported.drawing;
        properties = node.format === "dxf" ? readSheetProperties(node.text) : {};
        dirty = false;
        changed();
        unitMenu.replaceChildren(
            ...UNIT_CHOICES.map((code) => option({ value: String(code), textContent: DXF_UNITS[code][0] })),
        );
        const current = UNIT_CHOICES.find((code) => DXF_UNITS[code][1] === imported?.units.toMm);
        unitMenu.value = String(current ?? 4);
        render();
    };
    void load();

    unitMenu.onchange = () => {
        toMm = DXF_UNITS[Number(unitMenu.value)]?.[1];
        void load();
    };

    /** The drawing coordinates under a pointer position (the SVG flips y; see `writeSvg`). */
    const drawingPoint = (clientX: number, clientY: number): Point2 | undefined => {
        if (svgElement === undefined || drawing === undefined) return undefined;
        const rect = canvasHost.getBoundingClientRect();
        const scale = Math.max(view.width / rect.width, view.height / rect.height);
        const sx = view.x + (clientX - rect.left - (rect.width - view.width / scale) / 2) * scale;
        const sy = view.y + (clientY - rect.top - (rect.height - view.height / scale) / 2) * scale;
        const bounds = drawingBounds(drawing) ?? { min: [0, 0] as Point2, max: [0, 0] as Point2 };
        return [sx + bounds.min[0] - SVG_MARGIN, bounds.max[1] + SVG_MARGIN - sy];
    };

    /** The model distance between two sheet points, in the document's units. */
    const sheetDistance = (a: Point2, b: Point2): string => {
        const scale = parseScale(properties["scale"]) ?? 1;
        const inches = properties["units"] === "inch";
        const sheetMm = Math.hypot(b[0] - a[0], b[1] - a[1]) * (inches ? 25.4 : 1);
        return formatDocumentValue(sheetMm / scale, document, LENGTH_UNITS);
    };

    const placeNote = (at: Point2) => {
        const text = window.prompt(I18n.translate("documents.drawing.noteText"), "");
        if (!text?.trim() || drawing === undefined) return;
        drawing = withEntities(drawing, [noteEntity(at, text.trim())], ANNOTATION_LAYERS.notes);
        markDirty();
        render(true);
    };

    const placeDimension = (at: Point2) => {
        if (pending === undefined) {
            pending = at;
            setStatus("documents.drawing.dimensionSecond");
            return;
        }
        const a = pending;
        pending = undefined;
        if (drawing === undefined) return;
        drawing = withEntities(
            drawing,
            dimensionEntities(a, at, 8, sheetDistance(a, at)),
            ANNOTATION_LAYERS.dimensions,
        );
        markDirty();
        setStatus("documents.drawing.dimensionFirst");
        render(true);
    };

    const arm = (next: Tool) => {
        if (!editable()) {
            PubSub.default.pub("showToast", "documents.drawing.dxfOnly");
            return;
        }
        tool = next;
        pending = undefined;
        canvasHost.style.cursor = next === "none" ? "" : "crosshair";
        setStatus(
            next === "note"
                ? "documents.drawing.notePlace"
                : next === "dimension"
                  ? "documents.drawing.dimensionFirst"
                  : undefined,
        );
    };

    // Pan and zoom.
    canvasHost.addEventListener(
        "wheel",
        (e) => {
            if (svgElement === undefined) return;
            e.preventDefault();
            const rect = canvasHost.getBoundingClientRect();
            const scale = Math.min(view.width / rect.width, view.height / rect.height);
            const fx = view.x + (e.clientX - rect.left - (rect.width - view.width / scale) / 2) * scale;
            const fy = view.y + (e.clientY - rect.top - (rect.height - view.height / scale) / 2) * scale;
            const factor = e.deltaY > 0 !== Config.instance.preferences.mouse.reverseZoom ? 1.2 : 1 / 1.2;
            view = {
                x: fx - (fx - view.x) * factor,
                y: fy - (fy - view.y) * factor,
                width: view.width * factor,
                height: view.height * factor,
            };
            applyView();
        },
        { passive: false },
    );
    let endPan = () => {};
    canvasHost.addEventListener("contextmenu", (e) => e.preventDefault());
    canvasHost.addEventListener("keydown", (e) => {
        if (e.key === "Escape") arm("none");
    });
    canvasHost.tabIndex = 0;
    canvasHost.addEventListener("mousedown", (e) => {
        endPan();
        if (svgElement === undefined) return;
        if (e.button === 0 && tool !== "none") {
            const at = drawingPoint(e.clientX, e.clientY);
            if (at === undefined) return;
            if (tool === "note") placeNote(at);
            else placeDimension(at);
            return;
        }
        const rect = canvasHost.getBoundingClientRect();
        const scale = Math.max(view.width / rect.width, view.height / rect.height);
        const start = { x: e.clientX, y: e.clientY, view: { ...view } };
        const onMove = (event: MouseEvent) => {
            view = {
                ...start.view,
                x: start.view.x - (event.clientX - start.x) * scale,
                y: start.view.y - (event.clientY - start.y) * scale,
            };
            applyView();
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        endPan = onUp;
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    });

    const createSketch = () => {
        if (imported === undefined || drawing === undefined) return;
        const current = drawing;
        const sources = imported.sources;
        Transaction.execute(document, "create sketch from drawing", () => {
            const { sketch } = addDrawingSketch(
                document,
                uniqueElementName(document, node.name),
                current,
                sources,
            );
            PubSub.default.pub("showToast", "documents.drawing.sketchCreated{0}", sketch.name);
        });
    };

    /** The sheet's options as its properties record them. */
    const sheetOptions = (): SheetOptions => ({
        size: sheetSizeNamed(properties["sheet"]) ?? SHEET_SIZES.A4,
        title: properties["title"],
        drawnBy: properties["drawnBy"],
        date: properties["date"],
        number: properties["number"],
        revision: properties["revision"],
        units: properties["units"] === "inch" ? "inch" : "mm",
    });

    /** Lays the sheet out again around `views` (the current views by default), keeping the annotations. */
    const relayout = (views?: DrawingEntity[], template?: DrawingTemplate) => {
        if (drawing === undefined) return;
        const parts = splitSheet(drawing);
        const viewEntities = views ?? parts.views;
        const viewDrawing: Drawing | undefined =
            viewEntities.length === 0
                ? undefined
                : { layers: layersUsed(drawing, viewEntities), entities: viewEntities };
        const layout = sheetLayout(viewDrawing, sheetOptions());
        properties["scale"] =
            layout.scale >= 1 ? `${Math.round(layout.scale)}:1` : `1:${Math.round(1 / layout.scale)}`;
        let next = layout.drawing;
        if (template?.frameDxf) {
            const art = importDxf(template.frameDxf);
            if (art.isOk)
                next = withEntities(
                    next,
                    art.value.drawing.entities.map((entity) => ({
                        ...entity,
                        layer: ANNOTATION_LAYERS.template.name,
                    })),
                    ANNOTATION_LAYERS.template,
                );
        }
        for (const entity of parts.annotations) {
            const layer =
                entity.layer === ANNOTATION_LAYERS.notes.name
                    ? ANNOTATION_LAYERS.notes
                    : ANNOTATION_LAYERS.dimensions;
            next = withEntities(next, [entity], layer);
        }
        drawing = next;
        markDirty();
        render();
    };

    const titleBlock = () => {
        if (!editable()) {
            PubSub.default.pub("showToast", "documents.drawing.dxfOnly");
            return;
        }
        const field = (key: string, placeholder: string) => {
            const box = input({ className: style.exportName, value: properties[key] ?? "" });
            box.placeholder = placeholder;
            box.setAttribute("aria-label", placeholder);
            return box;
        };
        const title = field("title", I18n.translate("documents.drawing.field.title"));
        const drawnBy = field("drawnBy", I18n.translate("documents.drawing.field.drawnBy"));
        const date = field("date", I18n.translate("documents.drawing.field.date"));
        const number = field("number", I18n.translate("documents.drawing.field.number"));
        const revision = field("revision", I18n.translate("documents.drawing.field.revision"));
        const sheet = select(
            { className: style.select },
            ...Object.values(SHEET_SIZES).map((size) =>
                option({
                    value: size.name,
                    textContent: `${size.name} (${size.width} × ${size.height} mm)`,
                    selected: size.name === (properties["sheet"] ?? "A4"),
                }),
            ),
        );
        sheet.setAttribute("aria-label", I18n.translate("documents.drawing.field.sheet"));
        const row = (text: string, control: HTMLElement) =>
            div(
                { className: style.exportField },
                span({ className: style.exportLabel, textContent: text }),
                control,
            );
        const content = div(
            { className: style.exportDialog },
            row(I18n.translate("documents.drawing.field.title"), title),
            row(I18n.translate("documents.drawing.field.drawnBy"), drawnBy),
            row(I18n.translate("documents.drawing.field.date"), date),
            row(I18n.translate("documents.drawing.field.number"), number),
            row(I18n.translate("documents.drawing.field.revision"), revision),
            row(I18n.translate("documents.drawing.field.sheet"), sheet),
        );
        const buttons: DialogButton[] = [
            {
                content: "common.confirm",
                onclick: () => {
                    properties = {
                        ...properties,
                        title: title.value,
                        drawnBy: drawnBy.value,
                        date: date.value,
                        number: number.value,
                        revision: revision.value,
                        sheet: sheet.value,
                    };
                    relayout();
                },
            },
            { content: "common.cancel" },
        ];
        PubSub.default.pub("showDialog", "documents.drawing.titleBlock", content, buttons);
    };

    const insertViews = () => {
        if (!editable()) {
            PubSub.default.pub("showToast", "documents.drawing.dxfOnly");
            return;
        }
        const nodes = partStudioNodes(document);
        if (nodes.length === 0) {
            PubSub.default.pub("showToast", "documents.drawing.noParts");
            return;
        }
        const shapes = nodes.map((part) => part.shape.value.transformedMul(part.worldTransform()));
        try {
            const views = projectionDrawing(shapes, { angle: "third", iso: true });
            if (drawing !== undefined) {
                // The views' layers must be on the drawing before the relayout reads them.
                for (const layer of views.layers)
                    if (!drawing.layers.some((candidate) => candidate.name === layer.name))
                        drawing = { ...drawing, layers: [...drawing.layers, layer] };
            }
            relayout([...views.entities]);
        } finally {
            for (const shape of shapes) shape.dispose();
        }
    };

    const saveTemplate = () => {
        const name = window.prompt(
            I18n.translate("documents.drawing.templateName"),
            properties["title"] || node.name,
        );
        if (!name?.trim()) return;
        const template: DrawingTemplate = {
            name: name.trim(),
            sheet: properties["sheet"] ?? "A4",
            drawnBy: properties["drawnBy"],
            number: properties["number"],
            revision: properties["revision"],
        };
        const frame = Config.instance.preferences.drawingTemplates.find(
            (candidate) => candidate.name === template.name,
        )?.frameDxf;
        if (frame !== undefined) template.frameDxf = frame;
        const others = Config.instance.preferences.drawingTemplates.filter(
            (candidate) => candidate.name !== template.name,
        );
        saveTemplates([template, ...others]);
        PubSub.default.pub("showToast", "documents.drawing.templateSaved{0}", template.name);
    };

    const importTemplate = async () => {
        const files = await readFilesAsync(".dxf", false);
        if (!files.isOk || files.value.length === 0) return;
        const file = files.value[0];
        const text = await file.text();
        const art = importDxf(text);
        if (!art.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", art.error);
            return;
        }
        const name = file.name.replace(/\.dxf$/i, "");
        const template: DrawingTemplate = { name, sheet: properties["sheet"] ?? "A4", frameDxf: text };
        const others = Config.instance.preferences.drawingTemplates.filter(
            (candidate) => candidate.name !== name,
        );
        saveTemplates([template, ...others]);
        if (editable()) relayout(undefined, template);
        PubSub.default.pub("showToast", "documents.drawing.templateSaved{0}", name);
    };

    const exports = (): DocumentExport[] => {
        const current = () => {
            if (drawing === undefined) throw new Error(I18n.translate("documents.loading"));
            return drawing;
        };
        // What goes into the file, in every format: all of it unless the user unticks layers
        // (construction, notes) or colours — one shared filter (`filterDrawing`).
        const chosen = async () => {
            const drawing = current();
            const selection = await chooseExportSelection(drawing);
            if (selection === undefined) throw new Error(I18n.translate("documents.export.cancelled"));
            return filterDrawing(drawing, selection);
        };
        return [
            {
                label: "documents.export.dxfR12",
                extension: ".dxf",
                produce: async () => writeDxf(await chosen(), { properties }),
            },
            {
                label: "documents.export.svg",
                extension: ".svg",
                produce: async () => writeSvg(await chosen(), { title: node.name }),
            },
            {
                label: "documents.export.dwg",
                extension: ".dwg",
                produce: async () => {
                    const bytes = await writeDwg(await chosen(), { properties });
                    if (!bytes.isOk) throw new Error(bytes.error);
                    return bytes.value;
                },
            },
            {
                label: "documents.export.pdf",
                extension: ".pdf",
                produce: async () => writePdf(await chosen(), { title: node.name }),
            },
            {
                label: "documents.export.png",
                extension: ".png",
                produce: async () =>
                    new Uint8Array(await (await rasterizeDrawing(await chosen())).arrayBuffer()),
            },
        ];
    };

    const openPreferences = () => PubSub.default.pub("openPreferences", document, "drawings");
    // The Drawing toolbar (the contextual ribbon tab) acts on the drawing in front.
    const actions: IActiveDrawing = {
        createSketch,
        fit: () => render(),
        preferences: openPreferences,
        export: async (extension) => {
            if (drawing === undefined) return;
            const current = drawing;
            showExportDrawingDialog({ document, name: node.name, drawing: () => current, format: extension });
        },
        note: () => arm("note"),
        dimension: () => arm("dimension"),
        titleBlock,
        insertViews,
        saveTemplate,
        importTemplate: () => void importTemplate(),
    };
    return {
        element: div(
            { className: style.body },
            div(
                { className: style.toolbar },
                labelButton("documents.drawing.createSketch", createSketch),
                div({ className: style.separator }),
                span({ textContent: new Localize("documents.drawing.units") }),
                unitMenu,
                toolButton("documents.fit", "⤢", () => render()),
                button({
                    className: style.button,
                    textContent: "Preferences",
                    title: "Preferences",
                    onclick: openPreferences,
                }),
                div({ className: style.separator }),
                status,
            ),
            div(
                { className: style.drawingBody },
                canvasHost,
                div({ className: style.layers }, facts, layerList),
            ),
        ),
        isDirty: () => dirty,
        save: async () => {
            if (drawing === undefined || !editable()) return;
            const text = writeDxf(drawing, { properties });
            Transaction.execute(document, "save drawing", () => node.setText(text));
            dirty = false;
        },
        reload: () => void load(),
        exports,
        activated: () => setActiveDrawing(actions),
        deactivated: () => {
            if (activeDrawing() === actions) setActiveDrawing(undefined);
        },
        dispose: () => {
            if (activeDrawing() === actions) setActiveDrawing(undefined);
            endPan();
            Config.instance.removePropertyChanged(preferencesChanged);
            canvasHost.replaceChildren();
        },
    };
}

/**
 * A small dialog asking what goes into the file: a checkbox per layer that has entities and
 * per colour drawn (swatch, name, entity count; all ticked). Resolves with the selection — an
 * empty one when everything stays ticked or there is nothing to choose — or undefined when
 * cancelled.
 */
export function chooseExportSelection(drawing: Drawing): Promise<DrawingSelection | undefined> {
    const controls = selectionControls(drawing);
    if (controls.layers.length <= 1 && controls.colors.length <= 1) return Promise.resolve({});
    return new Promise((resolve) => {
        const section = (titleKey: I18nKeys, rows: readonly { row: HTMLElement }[]) =>
            rows.length <= 1
                ? []
                : [
                      span({ className: style.exportLabel, textContent: I18n.translate(titleKey) }),
                      ...rows.map((entry) => entry.row),
                  ];
        const cancel = button({ type: "button", textContent: I18n.translate("common.cancel") });
        const ok = button({
            type: "button",
            className: style.primary,
            textContent: I18n.translate("common.confirm"),
        });
        const panel = dialog(
            { className: style.layerDialog },
            h3({ textContent: I18n.translate("documents.export.selection") }),
            div(
                { className: style.layerChoices },
                ...section("documents.export.layers", controls.layers),
                ...section("documents.export.colors", controls.colors),
            ),
            div({ className: style.layerActions }, cancel, ok),
        );
        panel.setAttribute("aria-label", I18n.translate("documents.export.selection"));
        const finish = (selection: DrawingSelection | undefined) => {
            panel.close();
            panel.remove();
            resolve(selection);
        };
        cancel.onclick = () => finish(undefined);
        ok.onclick = () => finish(controls.selection() ?? {});
        panel.addEventListener("cancel", (event) => {
            event.preventDefault();
            finish(undefined);
        });
        document.body.append(panel);
        panel.showModal();
    });
}
