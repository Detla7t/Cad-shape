// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Combobox,
    command,
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
} from "@chili3d/core";
import { writeDxf, writeSvg } from "@chili3d/parametric";
import { writeDwg } from "./cad/dwg";
import { type ProjectionAngle, projectionDrawing } from "./cad/projection";
import { DocumentFileNode } from "./documentFileNode";
import { blocksToDocx } from "./richtext/docx";
import { emptyWorkbook } from "./sheet/model";
import { writeWorkbook } from "./sheet/workbookIo";

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
        const shapes: IShape[] = nodes.map((node) => node.shape.value.transformedMul(node.worldTransform()));
        try {
            const drawing = projectionDrawing(shapes, {
                angle: this.angle as ProjectionAngle,
                iso: this.iso,
            });
            const name = `${nodes[0].name} drawing${this.format}`;
            if (this.format === ".svg") download([writeSvg(drawing, { title: nodes[0].name })], name);
            else if (this.format === ".dwg") {
                const bytes = await writeDwg(drawing);
                if (!bytes.isOk) {
                    PubSub.default.pub("showToast", "error.default:{0}", bytes.error);
                    return;
                }
                download([bytes.value as BlobPart], name);
            } else download([writeDxf(drawing)], name);
        } finally {
            for (const shape of shapes) shape.dispose();
        }
    }
}
