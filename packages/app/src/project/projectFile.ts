// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DOCUMENT_FILE_EXTENSION,
    type IApplication,
    type IDocument,
    isNodeSceneless,
    Logger,
    PROJECT_FILE_EXTENSION,
    PROJECT_THUMBNAIL_PATH,
    type ProjectElement,
    type ProjectEntryProvider,
    type ProjectExtensionInput,
    type ProjectFileState,
    type ProjectFiles,
    type ProjectGeometryInput,
    packProject,
    pngDataUrlBytes,
    projectElementKind,
    projectEntryProviders,
    projectFileState,
    projectManifestContributors,
    projectSourceElementSpec,
    Result,
    type Serialized,
    ShapeNode,
    setProjectFileState,
    type UnpackedProject,
    unpackProject,
} from "@chili3d/core";

/**
 * Reading and writing `.chili3d` project files (zip + manifest, see
 * `docs/project-format.md`) for a live document: the pure format lives in
 * `@chili3d/core` (`packProject` / `unpackProject`); this module adds the document's
 * thumbnail, caches and extension folders, and the zip I/O.
 */

export const APP_NAME = "Chili3D";

export interface ProjectWriteOptions {
    /**
     * Also store every shape node's current geometry as BREP under `geometry/`, flagged
     * non-authoritative (other tools can read it; Chili3D always rebuilds). Off by default.
     */
    readonly includeGeometry?: boolean;
    /** PNG bytes; defaults to the image of a view showing the document. */
    readonly thumbnail?: Uint8Array;
    readonly now?: Date;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function isZipData(bytes: Uint8Array): boolean {
    return ZIP_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** Whether `fileName` opens as a document (a `.chili3d` project or a legacy `.cd` file). */
export function isDocumentFileName(fileName: string): boolean {
    const name = fileName.toLowerCase();
    return name.endsWith(PROJECT_FILE_EXTENSION) || name.endsWith(DOCUMENT_FILE_EXTENSION);
}

// ------------------------------------------------------------------ Writing

function scenelessElements(document: IDocument): ProjectElement[] {
    return document.modelManager
        .findNodes((node) => isNodeSceneless(node))
        .filter((node) => projectSourceElementSpec(node.constructor.name) === undefined)
        .map((node) => ({ id: node.id, kind: projectElementKind(node.constructor.name), name: node.name }));
}

function documentThumbnail(document: IDocument): Uint8Array | undefined {
    const active = document.application.activeView;
    const view =
        active?.document === document
            ? active
            : document.application.views?.find((v) => v.document === document);
    if (view === undefined) return undefined;
    try {
        return pngDataUrlBytes(view.toImage());
    } catch (error) {
        Logger.warn("project: no thumbnail", error);
        return undefined;
    }
}

function geometryCaches(document: IDocument): ProjectGeometryInput[] {
    const converter = document.application.shapeProvider.converter;
    const caches: ProjectGeometryInput[] = [];
    for (const node of document.modelManager.findNodes((x) => x instanceof ShapeNode) as ShapeNode[]) {
        if (!node.shape.isOk) continue;
        const shape = node.shape.value.transformedMul(node.worldTransform());
        try {
            const brep = converter.convertToBrep(shape);
            if (brep.isOk) caches.push({ nodeId: node.id, name: node.name, data: brep.value });
        } finally {
            shape.dispose();
        }
    }
    return caches;
}

function manifestContributions(document: IDocument): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const contributor of projectManifestContributors()) {
        try {
            Object.assign(fields, contributor(document));
        } catch (error) {
            Logger.warn("project: a manifest contributor failed", error);
        }
    }
    return fields;
}

const relativeKey = (prefix: string, key: string) =>
    key.startsWith(prefix) ? key.slice(prefix.length) : key;

async function extensionFolders(
    document: IDocument,
    state: ProjectFileState | undefined,
): Promise<Result<ProjectExtensionInput[]>> {
    const folders: ProjectExtensionInput[] = [];
    const providers = projectEntryProviders();
    for (const provider of providers) {
        const loaded = state?.extensions.get(provider.prefix);
        if (state !== undefined && loaded !== undefined && !state.readPrefixes.has(provider.prefix)) {
            // Registered after the file was opened: the provider sees its data before writing.
            await readFolder(document, state, provider, loaded.files);
        }
        if (state?.failedReads.has(provider.prefix)) {
            // The provider never understood what was loaded: write it back untouched.
            if (loaded !== undefined) folders.push({ ...loaded.entry, files: loaded.files });
            continue;
        }
        let written: Record<string, Uint8Array | string>;
        try {
            written = await provider.write(document);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Result.err(`Saving ${provider.name ?? provider.prefix} failed: ${message}`);
        }
        const files: Record<string, Uint8Array | string> =
            provider.exclusive === true || loaded === undefined ? {} : { ...loaded.files };
        for (const [key, data] of Object.entries(written)) files[relativeKey(provider.prefix, key)] = data;
        folders.push({ prefix: provider.prefix, name: provider.name, version: provider.version, files });
    }
    // Folders no registered module owns (history/ without the version-control module, a
    // newer module's folder) travel on verbatim.
    for (const [prefix, loaded] of state?.extensions ?? []) {
        if (providers.some((provider) => provider.prefix === prefix)) continue;
        folders.push({ ...loaded.entry, prefix, files: loaded.files });
    }
    return Result.ok(folders);
}

/** The archive entries of `document` as a project (see `packProject`). */
export async function buildProjectFiles(
    document: IDocument,
    options: ProjectWriteOptions = {},
): Promise<Result<ProjectFiles>> {
    const serialized = document.serialize();
    const state = projectFileState(document);
    const now = (options.now ?? new Date()).toISOString();
    const extensions = await extensionFolders(document, state);
    if (!extensions.isOk) return Result.err(extensions.error);
    return packProject({
        document: serialized,
        app: { name: APP_NAME, version: __APP_VERSION__ },
        createdAt: state?.createdAt ?? now,
        modifiedAt: now,
        elements: scenelessElements(document),
        thumbnail: options.thumbnail ?? documentThumbnail(document),
        geometry: options.includeGeometry === true ? geometryCaches(document) : undefined,
        extensions: extensions.value,
        manifest: manifestContributions(document),
    });
}

export async function zipProjectFiles(files: ProjectFiles, date = new Date()): Promise<Uint8Array> {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    for (const [path, data] of files) {
        // PNG is already compressed.
        zip.file(path, data, { date, compression: path === PROJECT_THUMBNAIL_PATH ? "STORE" : "DEFLATE" });
    }
    return zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
    });
}

/** `document` as `.chili3d` bytes; it remembers its `createdAt` for the next save. */
export async function writeProjectFile(
    document: IDocument,
    options: ProjectWriteOptions = {},
): Promise<Result<Uint8Array>> {
    const now = options.now ?? new Date();
    const files = await buildProjectFiles(document, { ...options, now });
    if (!files.isOk) return Result.err(files.error);
    const state = projectFileState(document);
    if (state === undefined) {
        setProjectFileState(document, {
            createdAt: now.toISOString(),
            extensions: new Map(),
            readPrefixes: new Set(),
            failedReads: new Set(),
        });
    } else {
        state.createdAt ??= now.toISOString();
    }
    return Result.ok(await zipProjectFiles(files.value, now));
}

// ------------------------------------------------------------------ Reading

export async function unzipProjectFiles(bytes: Uint8Array): Promise<Result<ProjectFiles>> {
    const { default: JSZip } = await import("jszip");
    let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
    try {
        zip = await JSZip.loadAsync(bytes);
    } catch {
        return Result.err("Not a Chili3D project: the file is not a zip archive");
    }
    const files: ProjectFiles = new Map();
    for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        try {
            files.set(entry.name, await entry.async("uint8array"));
        } catch {
            return Result.err(`The project is damaged: ${entry.name} cannot be read`);
        }
    }
    return Result.ok(files);
}

export async function readProjectFile(bytes: Uint8Array): Promise<Result<UnpackedProject>> {
    const files = await unzipProjectFiles(bytes);
    if (!files.isOk) return Result.err(files.error);
    return unpackProject(files.value);
}

async function readFolder(
    document: IDocument,
    state: ProjectFileState,
    provider: ProjectEntryProvider,
    files: Record<string, Uint8Array>,
): Promise<void> {
    state.readPrefixes.add(provider.prefix);
    try {
        await provider.read(document, files);
    } catch (error) {
        state.failedReads.add(provider.prefix);
        Logger.warn(`project: ${provider.name ?? provider.prefix} could not read its files`, error);
    }
}

/** Hands the extension folders to their providers and remembers the file's state on `document`. */
export async function restoreProjectState(document: IDocument, project: UnpackedProject): Promise<void> {
    const state: ProjectFileState = {
        createdAt: typeof project.manifest.createdAt === "string" ? project.manifest.createdAt : undefined,
        extensions: new Map(project.extensions),
        readPrefixes: new Set(),
        failedReads: new Set(),
    };
    setProjectFileState(document, state);
    for (const provider of projectEntryProviders()) {
        await readFolder(document, state, provider, project.extensions.get(provider.prefix)?.files ?? {});
    }
}

/** Opens `.chili3d` bytes as a new document of `app`. */
export async function openProjectFile(app: IApplication, bytes: Uint8Array): Promise<Result<IDocument>> {
    const project = await readProjectFile(bytes);
    if (!project.isOk) return Result.err(project.error);
    for (const warning of project.value.warnings) Logger.warn(`project: ${warning}`);
    const document = await app.loadDocument(project.value.document);
    if (document === undefined) return Result.err("The document could not be loaded");
    await restoreProjectState(document, project.value);
    return Result.ok(document);
}

/**
 * Opens a document file: a `.chili3d` project (recognized by its zip signature, whatever
 * the name) or a legacy `.cd` file (plain JSON).
 */
export async function openDocumentFile(
    app: IApplication,
    file: Blob & { name?: string },
): Promise<Result<IDocument>> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isZipData(bytes)) return openProjectFile(app, bytes);
    let data: Serialized;
    try {
        data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return Result.err(`${file.name ?? "The file"} is not a Chili3D document`);
    }
    const document = await app.loadDocument(data);
    if (document === undefined) return Result.err("The document could not be loaded");
    return Result.ok(document);
}
