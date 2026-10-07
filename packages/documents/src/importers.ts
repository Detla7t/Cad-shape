// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    FILE_FORMATS,
    fileExtension,
    type IDisposable,
    type IDocument,
    type IFileImporter,
    type ImportFile,
    type INode,
    Logger,
    openElement,
    PubSub,
    Result,
    registerFileImporter,
} from "@chili3d/core";
import { addDrawingSketch } from "./cad/drawingToSketch";
import { importDwg } from "./cad/dwg";
import type { ImportedDrawing } from "./cad/dxfToDrawing";
import { importDxf } from "./cad/dxfToDrawing";
import { importMeshFile, type MeshFormat } from "./cad/meshImport";
import { DocumentFileNode } from "./documentFileNode";
import { DOCUMENT_FORMAT_IDS, documentExtensions } from "./documentFormats";

/**
 * The importers of this module, registered with the data exchange (`registerFileImporter`):
 *
 * - DXF / DWG → a sketch on the XY plane with the drawing's lines, arcs and circles, plus
 *   a drawing element keeping the original file (texts, layers, export);
 * - OBJ / glTF / GLB / 3MF → mesh nodes;
 * - office files, PDFs, images, text → a document element, opened in its tab.
 */

const baseName = (fileName: string) => {
    const name = fileName.replace(/^.*[\\/]/, "");
    const extension = fileExtension(name);
    return extension === "" ? name : name.slice(0, -extension.length);
};

/** `base`, or `base (2)`, … — element names are tab titles, so keep them apart. */
export function uniqueElementName(document: IDocument, base: string): string {
    const taken = new Set(document.modelManager.findNodes().map((node) => node.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
        const name = `${base} (${n})`;
        if (!taken.has(name.toLowerCase())) return name;
    }
}

const extensionsOf = (ids: readonly string[]) =>
    FILE_FORMATS.filter((format) => ids.includes(format.id)).flatMap((format) => [...format.extensions]);

/** Adds the file as a document element. */
export function addDocumentFile(document: IDocument, file: ImportFile, open = true): DocumentFileNode {
    const node = new DocumentFileNode({
        document,
        name: uniqueElementName(document, baseName(file.name)),
        fileName: file.name.replace(/^.*[\\/]/, ""),
        format: file.format.id,
        bytes: file.bytes,
    });
    document.modelManager.addNode(node);
    if (open) openElement(document, node);
    return node;
}

function reportDrawing(name: string, drawing: ImportedDrawing, omitted: number): void {
    const skipped = Object.entries(drawing.skipped);
    if (skipped.length > 0) {
        Logger.info(`${name}: left out ${skipped.map(([type, count]) => `${count} ${type}`).join(", ")}`);
    }
    if (drawing.units.assumed) Logger.info(`${name}: no drawing units in the file, millimetres assumed`);
    PubSub.default.pub(
        "showToast",
        "toast.documents.drawingImported{0}{1}{2}",
        drawing.drawing.entities.length - omitted,
        drawing.units.name,
        skipped.reduce((n, [, count]) => n + count, 0) + omitted,
    );
}

export const DRAWING_IMPORTER: IFileImporter = {
    id: "documents.drawing",
    extensions: [".dxf", ".dwg"],
    accepts: (file) => file.format.id === "dxf" || file.format.id === "dwg",
    async import(document, file) {
        const drawing = file.format.id === "dwg" ? await importDwg(file.bytes) : importDxf(file.bytes);
        if (!drawing.isOk) return Result.err(drawing.error);
        const name = uniqueElementName(document, baseName(file.name));
        const { sketch, omitted } = addDrawingSketch(
            document,
            name,
            drawing.value.drawing,
            drawing.value.sources,
        );
        const element = addDocumentFile(
            document,
            { ...file, name: `${name}${fileExtension(file.name)}` },
            false,
        );
        reportDrawing(file.name, drawing.value, omitted);
        return Result.ok<INode[]>([sketch, element]);
    },
};

export const MESH_IMPORTER: IFileImporter = {
    id: "documents.mesh",
    extensions: extensionsOf(["obj", "gltf", "glb", "3mf"]),
    accepts: (file) => ["obj", "gltf", "glb", "3mf"].includes(file.format.id),
    import: (document, file) =>
        importMeshFile(document, baseName(file.name), file.format.id as MeshFormat, file.bytes),
};

export const DOCUMENT_IMPORTER: IFileImporter = {
    id: "documents.files",
    extensions: documentExtensions(),
    accepts: (file) => DOCUMENT_FORMAT_IDS.includes(file.format.id),
    import: async (document, file) => Result.ok<INode[]>([addDocumentFile(document, file)]),
};

/** Registers the importers; the returned handle removes them again. */
export function registerDocumentImporters(): IDisposable {
    const handles = [DOCUMENT_IMPORTER, MESH_IMPORTER, DRAWING_IMPORTER].map(registerFileImporter);
    return {
        dispose: () => {
            for (const handle of handles) handle.dispose();
        },
    };
}
