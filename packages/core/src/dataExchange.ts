// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import type { DetectedFileFormat } from "./fileFormat";
import type { IDisposable } from "./foundation/disposable";
import type { Result } from "./foundation/result";
import type { INode, VisualNode } from "./model";

export interface IDataExchange {
    importFormats(): string[];
    exportFormats(): string[];
    import(document: IDocument, files: FileList | File[]): Promise<void>;
    export(type: string, nodes: VisualNode[]): Promise<BlobPart[] | undefined>;
}

/** A file handed to an importer: its bytes, read once, and what `detectFileFormat` made of it. */
export interface ImportFile {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly format: DetectedFileFormat;
}

/**
 * Reads one kind of file into a document — registered by the module that owns the format
 * (DXF/DWG drawings, office documents, meshes, ...) so the one Import command, drag and
 * drop and `?url=` all reach it. The data exchange detects the format (content first,
 * then extension), asks each importer whether it `accepts` the file (latest registration
 * first) and runs the first that does inside the import's transaction.
 */
export interface IFileImporter {
    /** A key for logs and replacement: a later importer with the same id replaces this one. */
    readonly id: string;
    /** Extensions offered by the Import dialog (lowercase, with the dot). */
    readonly extensions: readonly string[];
    accepts(file: ImportFile): boolean;
    /**
     * Adds what the file holds to `document` and returns the nodes it added (already in
     * the model tree). An `err` is shown to the user.
     */
    import(document: IDocument, file: ImportFile): Promise<Result<INode[]>>;
}

const importers: IFileImporter[] = [];

/** Registers (or replaces, by id) a file importer. */
export function registerFileImporter(importer: IFileImporter): IDisposable {
    const index = importers.findIndex((existing) => existing.id === importer.id);
    if (index >= 0) importers.splice(index, 1);
    importers.push(importer);
    return {
        dispose: () => {
            const at = importers.indexOf(importer);
            if (at >= 0) importers.splice(at, 1);
        },
    };
}

/** The registered importers, latest first (the order they are asked in). */
export function fileImporters(): readonly IFileImporter[] {
    return [...importers].reverse();
}
