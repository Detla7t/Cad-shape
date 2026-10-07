// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Constants,
    DocumentVersionControl,
    entriesToArchive,
    type IApplication,
    type IStorage,
    Logger,
    PROJECT_HISTORY_FOLDER,
    type ProjectFiles,
    Result,
    type Serialized,
    StorageHistoryPersistence,
    unpackProject,
} from "@chili3d/core";
import { DetachedDocument } from "./detachedDocument";

/**
 * Makes a `.chili3d` file (opened from disk, never saved in this browser) a link source: its
 * document and version history are stored as if the document had been saved here, so its
 * parts can be linked at any of its versions. A file without history gets one with a single
 * commit of its current state. An already stored document with the same id is replaced by
 * the file's — it is the same document, brought up to date.
 */
export async function importSourceProject(
    application: IApplication,
    storage: IStorage,
    bytes: Uint8Array,
): Promise<Result<{ id: string; name: string }>> {
    const files = await unzip(bytes);
    if (!files.isOk) return Result.err(files.error);
    const project = unpackProject(files.value);
    if (!project.isOk) return Result.err(project.error);
    const document = project.value.document;
    if ((document as { version?: string }).version !== __DOCUMENT_VERSION__) {
        return Result.err("The file was written by an incompatible version of Chili3D");
    }
    const id = String(document["id"]);
    const name = String(document["name"] ?? "Untitled");
    const persistence = new StorageHistoryPersistence(storage);
    const historyFiles = project.value.extensions.get(PROJECT_HISTORY_FOLDER)?.files ?? {};
    try {
        const archive = Object.keys(historyFiles).length > 0 ? entriesToArchive(historyFiles) : undefined;
        if (archive !== undefined) {
            await persistence.remove(id);
            await persistence.save(id, archive.refs, archive.records, () => [...archive.records]);
        }
        // Record the document as loaded (a sync commit when it differs from the history's head).
        await recordHistory(application, document, persistence);
        await storage.put(Constants.DBName, Constants.DocumentTable, id, document);
        await storage.put(Constants.DBName, Constants.RecentTable, id, { id, name, date: Date.now() });
    } catch (error) {
        Logger.warn(`link source import of ${name} failed`, error);
        return Result.err(`The file could not be stored: ${String(error)}`);
    }
    return Result.ok({ id, name });
}

async function recordHistory(
    application: IApplication,
    data: Serialized,
    persistence: StorageHistoryPersistence,
): Promise<void> {
    const detached = await DetachedDocument.load(application, data);
    try {
        // History stays off in a detached document; attach reads the stored archive (or starts one).
        const control = await DocumentVersionControl.attach(detached, { persistence });
        try {
            await control.persist();
        } finally {
            control.dispose();
        }
    } finally {
        detached.dispose();
    }
}

async function unzip(bytes: Uint8Array): Promise<Result<ProjectFiles>> {
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
        files.set(entry.name, await entry.async("uint8array"));
    }
    return Result.ok(files);
}
