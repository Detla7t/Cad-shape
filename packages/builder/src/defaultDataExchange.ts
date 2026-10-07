// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DetectedFileFormat,
    detectFileFormat,
    EditableShapeNode,
    FILE_FORMATS,
    fileImporters,
    GeometryNode,
    I18n,
    type IDataExchange,
    type IDocument,
    type ImportFile,
    type INode,
    type IShape,
    Logger,
    PubSub,
    Result,
    ShapeNode,
    type VisualNode,
} from "@chili3d/core";
import { type ThreeMfMesh, write3mf } from "./threeMf";

/** Formats the kernel imports itself (any registered importer may add more). */
const BUILT_IN_IMPORTS = [".step", ".stp", ".iges", ".igs", ".brep", ".stl", ".fs"];

/**
 * Import and export of the Part Studio. Every imported file is identified by
 * `detectFileFormat` — content first (magic bytes, container entries, text signatures),
 * then the extension — and handed to the first registered `IFileImporter` that accepts
 * it (DXF/DWG, meshes, documents, …), else to the kernel's STEP/IGES/BREP/STL readers.
 * Proprietary CAD formats get an explanation instead of "unsupported".
 */
export class DefaultDataExchange implements IDataExchange {
    importFormats(): string[] {
        const extensions = new Set(BUILT_IN_IMPORTS);
        for (const importer of fileImporters())
            for (const extension of importer.extensions) extensions.add(extension);
        // Offered so that picking one explains why it cannot be read.
        for (const format of FILE_FORMATS) {
            if (format.category === "proprietary")
                for (const extension of format.extensions) extensions.add(extension);
        }
        return [...extensions];
    }

    exportFormats(): string[] {
        return [
            ".step",
            ".iges",
            ".brep",
            ".stl",
            ".stl binary",
            ".ply",
            ".ply binary",
            ".obj",
            ".glb",
            ".gltf",
            ".3mf",
        ];
    }

    async import(document: IDocument, files: FileList | File[]): Promise<void> {
        for (const file of files) {
            await this.handleSingleFileImport(document, file);
        }
    }

    private async handleSingleFileImport(document: IDocument, file: File) {
        let importResult: Result<INode> | undefined;

        const fileName = file.name.toLocaleLowerCase();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const format = detectFileFormat(file.name, bytes);
        if (format.mismatch) {
            Logger.info(
                `${file.name} is ${format.name} (recognized by its content), not what its extension says`,
            );
        }
        if (format.id === "featurescript") {
            // FeatureScript: the file becomes a new Feature Studio of the document.
            const { importFeatureStudio } = await import("@chili3d/parametric");
            importFeatureStudio(document, file.name, new TextDecoder().decode(bytes));
            return;
        }
        const importFile: ImportFile = { name: file.name, bytes, format };
        const importer = fileImporters().find((candidate) => candidate.accepts(importFile));
        if (importer !== undefined) {
            const imported = await importer.import(document, importFile);
            if (!imported.isOk) {
                PubSub.default.pub("showToast", "error.import.failed{0}{1}", file.name, imported.error);
                return;
            }
            document.visual.update();
            return;
        }
        if (format.id === "brep") {
            importResult = this.importBrep(document, file.name, bytes);
        } else if (format.id === "stl") {
            importResult = shapeConverter.convertFromSTL(document, bytes);
        } else if (format.id === "step") {
            importResult = shapeConverter.convertFromSTEP(document, bytes);
        } else if (format.id === "iges") {
            importResult = shapeConverter.convertFromIGES(document, bytes);
        } else if (format.category === "proprietary") {
            alert(this.proprietaryMessage(file.name, format));
            return;
        }

        this.handleImportResult(document, fileName, importResult);
    }

    /** Why a closed CAD format cannot be read, and what to do instead. */
    private proprietaryMessage(fileName: string, format: DetectedFileFormat): string {
        const key =
            format.id === "parasolid" ? "error.import.parasolid{0}" : "error.import.proprietary{0}{1}{2}";
        return I18n.translate(key, fileName, format.name, format.vendor ?? "");
    }

    private handleImportResult(document: IDocument, name: string, nodeResult: Result<INode> | undefined) {
        if (!nodeResult?.isOk) {
            alert(I18n.translate("error.import.unsupportedFileType:{0}", name));
            return;
        }

        const node = nodeResult.value;
        node.name = name;
        document.modelManager.addNode(node);
        document.visual.update();
    }

    importBrep(document: IDocument, name: string, bytes: Uint8Array): Result<INode> {
        const shape = shapeConverter.convertFromBrep(new TextDecoder().decode(bytes));
        if (!shape.isOk) {
            return Result.err(shape.error);
        }
        return Result.ok(new EditableShapeNode({ document, name, shape: shape.value }));
    }

    async export(type: string, nodes: VisualNode[]): Promise<BlobPart[] | undefined> {
        if (nodes.length === 0) return undefined;

        const document = nodes[0].document;
        let shapeResult: Result<BlobPart> | undefined;
        if (type === ".ply") {
            shapeResult = document.visual.meshExporter.exportToPly(nodes, true);
        } else if (type === ".ply binary") {
            shapeResult = document.visual.meshExporter.exportToPly(nodes, false);
        } else if (type === ".obj") {
            shapeResult = document.visual.meshExporter.exportToObj(nodes);
        } else if (type === ".glb" || type === ".gltf") {
            shapeResult = await document.visual.meshExporter.exportToGltf(nodes, type === ".glb");
        } else if (type === ".3mf") {
            shapeResult = await this.export3mf(document, nodes);
        } else {
            const shapes = this.getExportShapes(nodes);
            if (!shapes.length) return undefined;
            // STL goes through the headless OCCT-mesh converter (not the Three.js
            // visual exporter), so the same path works in the browser and the MCP server.
            if (type === ".stl") shapeResult = this.exportStl(document, shapes, false);
            if (type === ".stl binary") shapeResult = this.exportStl(document, shapes, true);
            if (type === ".step") shapeResult = this.exportStep(document, shapes);
            if (type === ".iges") shapeResult = this.exportIges(document, shapes);
            if (type === ".brep") shapeResult = this.exportBrep(document, shapes);
        }

        if (shapeResult) {
            return this.handleExportResult(shapeResult);
        }
        return undefined;
    }

    private getExportShapes(nodes: VisualNode[]): IShape[] {
        const shapes = nodes
            .filter((x): x is ShapeNode => x instanceof ShapeNode)
            .map((x) => x.shape.value.transformedMul(x.worldTransform()));

        !shapes.length && PubSub.default.pub("showToast", "error.export.noNodeCanBeExported");
        return shapes;
    }

    /** 3MF from the kernel's meshes (headless, like STL): one object per node, named and colored. */
    private async export3mf(document: IDocument, nodes: VisualNode[]): Promise<Result<BlobPart>> {
        const meshes: ThreeMfMesh[] = [];
        for (const node of nodes) {
            if (!(node instanceof ShapeNode) || !node.shape.isOk) continue;
            const shape = node.shape.value.transformedMul(node.worldTransform());
            try {
                const faces = shape.mesh.faces;
                if (faces === undefined || faces.index.length === 0) continue;
                meshes.push({
                    name: node.name,
                    color: this.nodeColor(document, node),
                    positions: faces.position,
                    indices: faces.index,
                });
            } finally {
                shape.dispose();
            }
        }
        if (meshes.length === 0) return Result.err(I18n.translate("error.export.noNodeCanBeExported"));
        return Result.ok((await write3mf(meshes)) as BlobPart);
    }

    private nodeColor(document: IDocument, node: VisualNode): number | undefined {
        if (!(node instanceof GeometryNode)) return undefined;
        const id = Array.isArray(node.materialId) ? node.materialId[0] : node.materialId;
        const color = document.modelManager.materials.find((material) => material.id === id)?.color;
        if (typeof color === "number") return color;
        if (typeof color === "string" && /^#?[0-9a-f]{6}$/i.test(color)) {
            return Number.parseInt(color.replace("#", ""), 16);
        }
        return undefined;
    }

    private exportStl(doc: IDocument, shapes: IShape[], binary: boolean): Result<BlobPart> {
        return shapeConverter.convertToSTL(shapes, { binary }) as Result<BlobPart>;
    }

    private exportStep(doc: IDocument, shapes: IShape[]) {
        return shapeConverter.convertToSTEP(...shapes);
    }

    private exportIges(doc: IDocument, shapes: IShape[]) {
        return shapeConverter.convertToIGES(...shapes);
    }

    private exportBrep(document: IDocument, shapes: IShape[]) {
        const comp = shapeFactory.combine(shapes);
        if (!comp.isOk) {
            return Result.err(comp.error);
        }

        const result = shapeConverter.convertToBrep(comp.value);
        comp.value.dispose();
        return result;
    }

    private handleExportResult(result: Result<BlobPart> | undefined) {
        if (!result?.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", result?.error);
            return undefined;
        }
        return [result.value];
    }
}
