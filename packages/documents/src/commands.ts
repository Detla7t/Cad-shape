// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Combobox,
    Config,
    command,
    documentUnit,
    download,
    GetOrSelectNodeStep,
    I18n,
    type IApplication,
    type ICommand,
    type IDocument,
    type IShape,
    type IStep,
    MultistepCommand,
    nextElementName,
    openElement,
    PubSub,
    property,
    ShapeNode,
    Transaction,
    unitSpecOfType,
} from "@chili3d/core";
import { convertDrawing } from "@chili3d/drawing";
import { partStudioNodes, writeDxf, writeSvg } from "@chili3d/parametric";
import { blocksToDocx } from "@chili3d/richtext/docx";
import { emptyWorkbook } from "@chili3d/sheet/model";
import { writeWorkbook } from "@chili3d/sheet/workbookIo";
import { activeDrawing } from "./activeDrawing";
import { ANNOTATION_LAYERS, withEntities } from "./cad/drawingAnnotations";
import { writeDwg } from "./cad/dwg";
import { importDxf } from "./cad/dxfToDrawing";
import { type ProjectionAngle, projectionDrawing } from "./cad/projection";
import { SHEET_SIZES, scaleLabel, sheetLayout, sheetSizeNamed } from "./cad/sheetDrawing";
import { DocumentFileNode } from "./documentFileNode";
import { showExportDrawingDialog } from "./ui/exportDialog";

/**
 * Commands of the documents module: new Markdown / Word / spreadsheet / text elements
 * (the "+" menu of the element strip and the File tab), and the multiview drawing export.
 */

async function addNewDocument(
    application: IApplication,
    base: string,
    extension: string,
    format: string,
    content: () => Promise<{ bytes?: Uint8Array; text?: string }>,
): Promise<void> {
    const document: IDocument =
        application.activeView?.document ?? (await application.newDocument("Untitled"));
    const name = nextElementName(document, base);
    const node = new DocumentFileNode({
        document,
        name,
        fileName: `${name}${extension}`,
        format,
        ...(await content()),
    });
    Transaction.execute(document, "new document", () => document.modelManager.addNode(node));
    openElement(document, node);
}

/**
 * Onshape's "Create Drawing…": a Drawing element of the Part Studio's visible parts — their
 * front, top, right and isometric views on a sheet with a frame and title block (A4 for a
 * millimetre document, ANSI A for an inch one) at the largest standard scale that fits, or an
 * empty sheet when there is nothing to draw yet. Stored as DXF, so it opens in the drawing
 * viewer and exports as DXF, DWG or SVG.
 */
@command({ key: "documents.newDrawing", icon: "icon-doc-drawing" })
export class NewDrawingCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document: IDocument =
            application.activeView?.document ?? (await application.newDocument("Untitled"));
        const inch = documentUnit(document, unitSpecOfType("length")).suffix === "in";
        const nodes = partStudioNodes(document);
        const shapes: IShape[] = nodes.map((node) => node.shape.value.transformedMul(node.worldTransform()));
        let views;
        try {
            if (shapes.length > 0) views = projectionDrawing(shapes, { angle: "third", iso: true });
        } finally {
            for (const shape of shapes) shape.dispose();
        }
        const name = nextElementName(document, I18n.translate("documents.kind.drawing"));
        // The first saved template is the default sheet; the document's units pick the size otherwise.
        const template = Config.instance.preferences.drawingTemplates[0];
        const date = new Date().toISOString().slice(0, 10);
        const options = {
            size: sheetSizeNamed(template?.sheet) ?? (inch ? SHEET_SIZES.ansiA : SHEET_SIZES.A4),
            title: nodes[0]?.name ?? document.name,
            drawnBy: template?.drawnBy,
            number: template?.number,
            revision: template?.revision,
            date,
            units: inch ? ("inch" as const) : ("mm" as const),
        };
        const layout = sheetLayout(views, options);
        let sheet = layout.drawing;
        if (template?.frameDxf) {
            const art = importDxf(template.frameDxf);
            if (art.isOk)
                sheet = withEntities(
                    sheet,
                    art.value.drawing.entities.map((entity) => ({
                        ...entity,
                        layer: ANNOTATION_LAYERS.template.name,
                    })),
                    ANNOTATION_LAYERS.template,
                );
        }
        const drawing = inch ? convertDrawing(sheet, "inch") : sheet;
        const properties: Record<string, string> = {
            sheet: options.size.name,
            scale: scaleLabel(layout.scale),
            title: options.title,
            date,
            units: options.units,
            ...(options.drawnBy ? { drawnBy: options.drawnBy } : {}),
            ...(options.number ? { number: options.number } : {}),
            ...(options.revision ? { revision: options.revision } : {}),
        };
        const node = new DocumentFileNode({
            document,
            name,
            fileName: `${name}.dxf`,
            format: "dxf",
            text: writeDxf(drawing, { properties }),
        });
        Transaction.execute(document, "new drawing", () => document.modelManager.addNode(node));
        openElement(document, node);
    }
}

/** The Drawing toolbar: each command acts on the drawing element in front. */
@command({ key: "drawing.createSketch", icon: "icon-sketch" })
export class DrawingCreateSketchCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.createSketch();
    }
}
@command({ key: "drawing.fit", icon: "icon-fitcontent" })
export class DrawingFitCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.fit();
    }
}
@command({ key: "drawing.preferences", icon: "icon-cog" })
export class DrawingPreferencesCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.preferences();
    }
}
@command({ key: "drawing.note", icon: "icon-edit" })
export class DrawingNoteCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.note();
    }
}
@command({ key: "drawing.dimension", icon: "icon-dDimension" })
export class DrawingDimensionCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.dimension();
    }
}
@command({ key: "drawing.titleBlock", icon: "icon-group" })
export class DrawingTitleBlockCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.titleBlock();
    }
}
@command({ key: "drawing.insertViews", icon: "icon-curveProject" })
export class DrawingInsertViewsCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.insertViews();
    }
}
@command({ key: "drawing.saveTemplate", icon: "icon-download" })
export class DrawingSaveTemplateCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.saveTemplate();
    }
}
@command({ key: "drawing.importTemplate", icon: "icon-import" })
export class DrawingImportTemplateCommand implements ICommand {
    async execute(): Promise<void> {
        activeDrawing()?.importTemplate();
    }
}
@command({ key: "drawing.exportDxf", icon: "icon-export" })
export class DrawingExportDxfCommand implements ICommand {
    async execute(): Promise<void> {
        await activeDrawing()?.export(".dxf");
    }
}
@command({ key: "drawing.exportDwg", icon: "icon-export" })
export class DrawingExportDwgCommand implements ICommand {
    async execute(): Promise<void> {
        await activeDrawing()?.export(".dwg");
    }
}
@command({ key: "drawing.exportSvg", icon: "icon-export" })
export class DrawingExportSvgCommand implements ICommand {
    async execute(): Promise<void> {
        await activeDrawing()?.export(".svg");
    }
}

@command({ key: "documents.newMarkdown", icon: "icon-doc-markdown" })
export class NewMarkdownCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        await addNewDocument(
            application,
            I18n.translate("documents.new.notes"),
            ".md",
            "markdown",
            async () => ({
                text: `# ${I18n.translate("documents.new.notes")}\n\n`,
            }),
        );
    }
}

@command({ key: "documents.newRichText", icon: "icon-doc-text" })
export class NewRichTextCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        await addNewDocument(
            application,
            I18n.translate("documents.new.document"),
            ".docx",
            "docx",
            async () => ({
                bytes: await blocksToDocx([]),
            }),
        );
    }
}

@command({ key: "documents.newSpreadsheet", icon: "icon-doc-sheet" })
export class NewSpreadsheetCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const bytes = await writeWorkbook(emptyWorkbook(), "xlsx");
        if (!bytes.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", bytes.error);
            return;
        }
        await addNewDocument(
            application,
            I18n.translate("documents.new.spreadsheet"),
            ".xlsx",
            "xlsx",
            async () => ({
                bytes: bytes.value,
            }),
        );
    }
}

@command({ key: "documents.newText", icon: "icon-doc-code" })
export class NewTextCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        await addNewDocument(application, I18n.translate("documents.new.text"), ".txt", "text", async () => ({
            text: "",
        }));
    }
}

export const PROJECTION_FORMATS = [".dxf", ".dwg", ".svg"] as const;

const hasShape = (node: unknown) => node instanceof ShapeNode && node.shape.isOk;

/**
 * Downloads a multiview drawing of the selected parts — front, top, right (and an
 * isometric) view with hidden lines removed by the kernel, in first- or third-angle
 * projection — as DXF, DWG or SVG in millimetres.
 */
@command({ key: "drawing.exportViews", icon: "icon-export" })
export class ExportProjectionCommand extends MultistepCommand {
    @property("file.format", { combobox: Combobox.from<string>([...PROJECTION_FORMATS]) })
    get format(): string {
        return this.getPrivateValue("format", ".dxf");
    }
    set format(value: string) {
        this.setProperty("format", value);
    }

    @property("documents.projection.angle", { combobox: Combobox.from<string>(["third", "first"]) })
    get angle(): string {
        return this.getPrivateValue("angle", "third");
    }
    set angle(value: string) {
        this.setProperty("angle", value);
    }

    @property("documents.projection.iso")
    get iso(): boolean {
        return this.getPrivateValue("iso", true);
    }
    set iso(value: boolean) {
        this.setProperty("iso", value);
    }

    protected override getSteps(): IStep[] {
        return [
            new GetOrSelectNodeStep("prompt.select.models", { multiple: true, filter: { allow: hasShape } }),
        ];
    }

    protected override executeMainTask(): void {
        void this.exportViews().catch((error) =>
            PubSub.default.pub(
                "showToast",
                "error.default:{0}",
                error instanceof Error ? error.message : String(error),
            ),
        );
    }

    private async exportViews(): Promise<void> {
        const nodes = (this.stepDatas[0]?.nodes ?? []).filter((node): node is ShapeNode => hasShape(node));
        if (nodes.length === 0) return;
        const document = nodes[0].document;
        const angle = this.angle as ProjectionAngle;
        const iso = this.iso;
        showExportDrawingDialog({
            document,
            name: `${nodes[0].name} drawing`,
            format: this.format as ".dxf" | ".dwg" | ".svg",
            drawing: () => {
                const shapes: IShape[] = nodes.map((node) =>
                    node.shape.value.transformedMul(node.worldTransform()),
                );
                try {
                    return projectionDrawing(shapes, { angle, iso });
                } finally {
                    for (const shape of shapes) shape.dispose();
                }
            },
        });
    }
}

import "./sketchImport";
