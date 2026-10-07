// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, Localize, PubSub, Transaction } from "@chili3d/core";
import { div, input, label, option, p, select, span } from "@chili3d/element";
import { writeDxf, writeSvg } from "@chili3d/parametric";
import { addDrawingSketch } from "../../cad/drawingToSketch";
import { importDwg, writeDwg } from "../../cad/dwg";
import { DXF_UNITS, type ImportedDrawing, importDxf } from "../../cad/dxfToDrawing";
import { uniqueElementName } from "../../importers";
import { labelButton, toolButton } from "../controls";
import style from "../documents.module.css";
import type { DocumentExport, IDocumentViewer, ViewerContext } from "../viewer";

/**
 * DXF and DWG drawings: the model space drawn as SVG (pan by dragging, zoom with the
 * wheel), layers that can be hidden, what the import left out, the drawing units (a
 * unitless file can be told its units), "Create sketch" to bring the geometry into the
 * Part Studio, and exports as DXF R12, SVG or DWG.
 */

const UNIT_CHOICES = [4, 5, 6, 1, 2] as const; // mm, cm, m, in, ft

export function createDrawingViewer({ node, document }: ViewerContext): IDocumentViewer {
    const canvasHost = div({ className: style.drawingCanvas });
    const facts = div({ className: style.facts });
    const layerList = div();
    const unitMenu = select({ className: style.select, title: new Localize("documents.drawing.units") });
    let imported: ImportedDrawing | undefined;
    let toMm: number | undefined;
    let svgElement: SVGSVGElement | undefined;
    let view = { x: 0, y: 0, width: 1, height: 1 };

    const applyView = () =>
        svgElement?.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);

    const render = () => {
        if (imported === undefined) return;
        canvasHost.innerHTML = writeSvg(imported.drawing, { margin: 2, strokeWidth: 0.25 }).replace(
            /^<\?xml[^>]*>\s*/,
            "",
        );
        svgElement = canvasHost.querySelector("svg") ?? undefined;
        const box = svgElement?.getAttribute("viewBox")?.split(" ").map(Number);
        if (svgElement !== undefined && box?.length === 4) {
            svgElement.removeAttribute("width");
            svgElement.removeAttribute("height");
            svgElement.setAttribute("preserveAspectRatio", "xMidYMid meet");
            view = { x: box[0], y: box[1], width: box[2] || 1, height: box[3] || 1 };
            applyView();
        }
        const skipped = Object.entries(imported.skipped);
        facts.replaceChildren(
            p({
                textContent: I18n.translate(
                    "documents.drawing.summary{0}{1}{2}",
                    imported.drawing.entities.length,
                    imported.drawing.layers.length,
                    imported.version ?? "",
                ),
            }),
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
            ...imported.drawing.layers.map((layer) => {
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
            const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
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
    canvasHost.addEventListener("mousedown", (e) => {
        if (svgElement === undefined) return;
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
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    });

    const createSketch = () => {
        if (imported === undefined) return;
        const drawing = imported;
        Transaction.execute(document, "create sketch from drawing", () => {
            const { sketch } = addDrawingSketch(
                document,
                uniqueElementName(document, node.name),
                drawing.drawing,
                drawing.sources,
            );
            PubSub.default.pub("showToast", "documents.drawing.sketchCreated{0}", sketch.name);
        });
    };

    const exports = (): DocumentExport[] => {
        const drawing = () => {
            if (imported === undefined) throw new Error(I18n.translate("documents.loading"));
            return imported.drawing;
        };
        return [
            { label: "documents.export.dxfR12", extension: ".dxf", produce: async () => writeDxf(drawing()) },
            {
                label: "documents.export.svg",
                extension: ".svg",
                produce: async () => writeSvg(drawing(), { title: node.name }),
            },
            {
                label: "documents.export.dwg",
                extension: ".dwg",
                produce: async () => {
                    const bytes = await writeDwg(drawing());
                    if (!bytes.isOk) throw new Error(bytes.error);
                    return bytes.value;
                },
            },
        ];
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
                toolButton("documents.fit", "⤢", render),
            ),
            div(
                { className: style.drawingBody },
                canvasHost,
                div({ className: style.layers }, facts, layerList),
            ),
        ),
        reload: () => void load(),
        exports,
        dispose: () => canvasHost.replaceChildren(),
    };
}
