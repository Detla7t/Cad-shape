// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Combobox,
    command,
    download,
    GetOrSelectNodeStep,
    type IApplication,
    type ICommand,
    type INode,
    type IStep,
    MultistepCommand,
    PubSub,
    property,
    readFilesAsync,
} from "@chili3d/core";
import { type Drawing, writeDxf, writeSvg } from "@chili3d/drawing";
import { FEATURE_STUDIO_EXTENSION, FeatureStudioNode } from "../featurescript/featureStudioNode";
import { documentStudios } from "../featurescript/studioCompiler";
import { featureStudioFileName, importFeatureStudio } from "../featurescript/studioFiles";
import { ParametricBodyNode } from "../parametricBodyNode";
import { flatPatternDrawing, flatPatternOf } from "../sheetMetal/flatPattern";
import { sheetModelOf } from "../sheetMetal/model";
import { SketchEditor } from "../sketch/editor/sketchEditor";
import { sketchDrawing } from "../sketch/sketchDrawing";
import { SketchNode } from "../sketch/sketchNode";

/**
 * File commands of the parametric module: 2D drawings (a sheet metal flat pattern, a
 * sketch) as DXF or SVG, and Feature Studios as `.fs` files.
 */

export const DRAWING_FORMATS = [".dxf", ".svg"] as const;

function writeDrawing(drawing: Drawing, format: string, title: string): string {
    return format === ".svg" ? writeSvg(drawing, { title }) : writeDxf(drawing);
}

function isSheetMetalBody(node: INode): boolean {
    return (
        node instanceof ParametricBodyNode && node.shape.isOk && sheetModelOf(node.shape.value) !== undefined
    );
}

/** Downloads the flat pattern of a sheet metal body as DXF or SVG, in millimetres. */
@command({ key: "sheetMetal.exportFlat", icon: "icon-share" })
export class ExportFlatPatternCommand extends MultistepCommand {
    @property("file.format", { combobox: Combobox.from<string>([...DRAWING_FORMATS]) })
    get format(): string {
        return this.getPrivateValue("format", ".dxf");
    }
    set format(value: string) {
        this.setProperty("format", value);
    }

    @property("sheetMetal.labels")
    get labels(): boolean {
        return this.getPrivateValue("labels", true);
    }
    set labels(value: boolean) {
        this.setProperty("labels", value);
    }

    protected override getSteps(): IStep[] {
        return [new GetOrSelectNodeStep("prompt.select.models", { filter: { allow: isSheetMetalBody } })];
    }

    protected override executeMainTask(): void {
        const body = this.stepDatas[0]?.nodes?.[0];
        if (!(body instanceof ParametricBodyNode) || !body.shape.isOk) return;
        const model = sheetModelOf(body.shape.value);
        if (model === undefined) return;
        const pattern = flatPatternOf(model);
        if (!pattern.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", pattern.error);
            return;
        }
        const drawing = flatPatternDrawing(pattern.value, { labels: this.labels });
        download([writeDrawing(drawing, this.format, body.name)], `${body.name} flat${this.format}`);
    }
}

/** Downloads a sketch (the one being edited, or a picked one) as DXF or SVG in its plane's coordinates. */
@command({ key: "sketch.export", icon: "icon-export" })
export class ExportSketchCommand extends MultistepCommand {
    @property("file.format", { combobox: Combobox.from<string>([...DRAWING_FORMATS]) })
    get format(): string {
        return this.getPrivateValue("format", ".dxf");
    }
    set format(value: string) {
        this.setProperty("format", value);
    }

    protected override getSteps(): IStep[] {
        if (SketchEditor.getActive() !== undefined) return [];
        return [
            new GetOrSelectNodeStep("prompt.select.sketch", {
                filter: { allow: (node) => node instanceof SketchNode },
            }),
        ];
    }

    /** Construction geometry goes into the file only when asked (Onshape's DXF export leaves it out). */
    @property("sketch.export.construction")
    get includeConstruction(): boolean {
        return this.getPrivateValue("includeConstruction", false);
    }
    set includeConstruction(value: boolean) {
        this.setProperty("includeConstruction", value);
    }

    @property("sketch.export.external")
    get includeExternal(): boolean {
        return this.getPrivateValue("includeExternal", true);
    }
    set includeExternal(value: boolean) {
        this.setProperty("includeExternal", value);
    }

    /** Sketch layer names, comma-separated; empty for every layer. */
    @property("sketch.export.layers")
    get layers(): string {
        return this.getPrivateValue("layers", "");
    }
    set layers(value: string) {
        this.setProperty("layers", value);
    }

    /** Colours (`#rrggbb`: an entity's own colour, else its layer's), comma-separated; empty for every colour. */
    @property("sketch.export.colors")
    get colors(): string {
        return this.getPrivateValue("colors", "");
    }
    set colors(value: string) {
        this.setProperty("colors", value);
    }

    protected override executeMainTask(): void {
        const editor = SketchEditor.getActive();
        const sketch = editor?.node ?? this.stepDatas[0]?.nodes?.[0];
        if (!(sketch instanceof SketchNode)) return;
        // While editing, the solver holds the latest geometry.
        const data = editor !== undefined ? editor.solver.toData() : sketch.data;
        const list = (text: string) => {
            const items = text
                .split(",")
                .map((item) => item.trim())
                .filter((item) => item !== "");
            return items.length === 0 ? undefined : items;
        };
        const drawing = sketchDrawing(data, {
            construction: this.includeConstruction,
            external: this.includeExternal,
            layers: list(this.layers),
            colors: list(this.colors),
        });
        download([writeDrawing(drawing, this.format, sketch.name)], `${sketch.name}${this.format}`);
    }
}

/**
 * Downloads Feature Studios as `.fs` files: the selected studios, else every studio of the
 * document — one file, or a zip when there are several.
 */
@command({ key: "featurescript.exportStudio", icon: "icon-export" })
export class ExportFeatureStudioCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const selected = document.selection
            .getSelectedNodes()
            .filter((node): node is FeatureStudioNode => node instanceof FeatureStudioNode);
        const studios = selected.length > 0 ? selected : documentStudios(document);
        if (studios.length === 0) {
            PubSub.default.pub("showToast", "toast.featurescript.noStudio");
            return;
        }
        if (studios.length === 1) {
            download([studios[0].source], featureStudioFileName(studios[0]));
            return;
        }
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        const used = new Set<string>();
        for (const studio of studios) zip.file(featureStudioFileName(studio, used), studio.source);
        download([await zip.generateAsync({ type: "blob" })], `${document.name} feature studios.zip`);
    }
}

/** Adds `.fs` files as new Feature Studios (dropping them on the window does the same). */
@command({ key: "featurescript.importStudio", icon: "icon-import" })
export class ImportFeatureStudioCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const files = await readFilesAsync(FEATURE_STUDIO_EXTENSION, true);
        if (!files.isOk || files.value.length === 0) return;
        const document = application.activeView?.document ?? (await application.newDocument("Untitled"));
        for (const file of Array.from(files.value)) {
            importFeatureStudio(document, file.name, await file.text());
        }
        PubSub.default.pub("showToast", "toast.success");
    }
}
