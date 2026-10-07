// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import {
    PROJECT_DOCUMENT_PATH,
    PROJECT_GEOMETRY_FOLDER,
    PROJECT_MANIFEST_PATH,
    PROJECT_THUMBNAIL_PATH,
    type ProjectExtensionEntry,
    projectSourceFolders,
} from "./projectFormat";

/**
 * Lets another module keep its own files inside a `.chili3d` project without touching the
 * writer or reader — the version history lives under `history/` this way.
 *
 * - `write` runs on save, after `document.json` is produced; it returns the folder's
 *   entries keyed by path RELATIVE to `prefix` (a key that already starts with `prefix`
 *   is accepted too). Strings are stored as UTF-8.
 * - `read` runs on open, after the document is loaded (also with `{}` when the file has
 *   no entries under `prefix`), with the entries keyed relative to `prefix`.
 * - Entries loaded from the file that `write` does not produce again are carried over
 *   unchanged on the next save, unless the provider is `exclusive` (its `write` output is
 *   then the folder's complete content). When `read` throws, the loaded entries are kept
 *   verbatim and `write` is skipped for that document, so a failure never drops data.
 *   A provider registered after a file was opened gets `read` with the loaded entries
 *   right before its first `write` for that document.
 *
 * Each provider is listed in the manifest's `extensions` with the files it produced.
 */
export interface ProjectEntryProvider {
    /** The zip folder the provider owns, ending in "/", e.g. "history/". */
    readonly prefix: string;
    /** Shown in the manifest's `extensions` list. */
    readonly name?: string;
    readonly version?: number;
    readonly exclusive?: boolean;
    write(document: IDocument): Promise<Record<string, Uint8Array | string>>;
    read(document: IDocument, entries: Record<string, Uint8Array>): Promise<void>;
}

const RESERVED_PREFIXES = ["featurestudios/", PROJECT_GEOMETRY_FOLDER];
const RESERVED_FILES = [PROJECT_MANIFEST_PATH, PROJECT_DOCUMENT_PATH, PROJECT_THUMBNAIL_PATH];

const providers = new Map<string, ProjectEntryProvider>();

export function isValidProjectPrefix(prefix: string): boolean {
    return (
        /^[a-z0-9][a-z0-9._-]*\/([a-z0-9][a-z0-9._-]*\/)*$/i.test(prefix) &&
        !prefix.split("/").includes("..") &&
        ![...RESERVED_PREFIXES, ...projectSourceFolders()].some((reserved) =>
            prefix.toLowerCase().startsWith(reserved.toLowerCase()),
        ) &&
        !RESERVED_FILES.some((file) => prefix.toLowerCase().startsWith(`${file}/`))
    );
}

/** Registers a provider; a second provider for the same prefix replaces the first. */
export function registerProjectEntryProvider(provider: ProjectEntryProvider): void {
    if (!isValidProjectPrefix(provider.prefix)) {
        throw new Error(`Invalid or reserved project folder: "${provider.prefix}"`);
    }
    providers.set(provider.prefix, provider);
}

export function unregisterProjectEntryProvider(prefix: string): void {
    providers.delete(prefix);
}

export function projectEntryProviders(): ProjectEntryProvider[] {
    return [...providers.values()];
}

/** Adds top-level manifest fields (e.g. `featureScript`); `undefined` adds nothing. */
export type ProjectManifestContributor = (document: IDocument) => Record<string, unknown> | undefined;

const contributors: ProjectManifestContributor[] = [];

export function registerProjectManifestContributor(contributor: ProjectManifestContributor): void {
    if (!contributors.includes(contributor)) contributors.push(contributor);
}

export function projectManifestContributors(): readonly ProjectManifestContributor[] {
    return contributors;
}

/** What a document remembers about the project file it was opened from. */
export interface ProjectFileState {
    /** The manifest's `createdAt`, kept across saves. */
    createdAt?: string;
    /** Extension folders loaded from the file, by prefix, entries keyed relative to the prefix. */
    readonly extensions: Map<string, { entry: ProjectExtensionEntry; files: Record<string, Uint8Array> }>;
    /** Prefixes whose provider has read the loaded entries (a provider registered later reads on save). */
    readonly readPrefixes: Set<string>;
    /** Prefixes whose provider failed to read: their loaded entries are written back verbatim. */
    readonly failedReads: Set<string>;
}

const states = new WeakMap<IDocument, ProjectFileState>();

export function projectFileState(document: IDocument): ProjectFileState | undefined {
    return states.get(document);
}

export function setProjectFileState(document: IDocument, state: ProjectFileState): void {
    states.set(document, state);
}
