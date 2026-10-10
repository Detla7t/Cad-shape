// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import { base64ToBytes, bytesToBase64 } from "../foundation/utils/base64";
import { sha256Hex } from "../foundation/utils/sha256";
import { InternalClassName, type Serialized } from "../serialize";
import { PART_STUDIO_KIND } from "../ui/documentElements";
import { isValidProjectPrefix } from "./projectExtensions";
import {
    PROJECT_DOCUMENT_PATH,
    PROJECT_FILE_ENCODING_KEY,
    PROJECT_FILE_REF_KEY,
    PROJECT_FORMAT,
    PROJECT_FORMAT_VERSION,
    PROJECT_GEOMETRY_FOLDER,
    PROJECT_HISTORY_FOLDER,
    PROJECT_MANIFEST_PATH,
    PROJECT_THUMBNAIL_PATH,
    type ProjectElement,
    type ProjectExtensionEntry,
    type ProjectFileEntry,
    type ProjectFileRole,
    type ProjectGeometryCacheEntry,
    type ProjectManifest,
    type ProjectSourceElementSpec,
    type ProjectSourceEncoding,
    projectSourceElementSpecs,
    safeProjectFileName,
} from "./projectFormat";

/**
 * The pure halves of the `.chili3d` writer and reader: `packProject` turns a serialized
 * document (plus thumbnail, caches and extension folders) into the archive's entries,
 * `unpackProject` validates entries and rebuilds the serialized document. The zip I/O
 * itself lives with the app (`@chili3d/app` `projectFile.ts`).
 */

/** Archive entries by path, in writing order (the manifest first). */
export type ProjectFiles = Map<string, Uint8Array>;

export interface ProjectExtensionInput {
    readonly prefix: string;
    readonly name?: string;
    readonly version?: number;
    /** Keyed relative to `prefix` (a key already starting with `prefix` is accepted). */
    readonly files: Record<string, Uint8Array | string>;
}

export interface ProjectGeometryInput {
    readonly nodeId: string;
    readonly name: string;
    readonly data: Uint8Array | string;
}

export interface ProjectPackInput {
    /** `IDocument.serialize()`. */
    readonly document: Serialized;
    readonly app: { readonly name: string; readonly version: string };
    readonly createdAt: string;
    readonly modifiedAt: string;
    /** Elements beyond the Part Studio and the registered source elements (sceneless nodes). */
    readonly elements?: readonly ProjectElement[];
    /** PNG bytes. */
    readonly thumbnail?: Uint8Array;
    /** BREP caches, written under `geometry/` and flagged non-authoritative. */
    readonly geometry?: readonly ProjectGeometryInput[];
    readonly extensions?: readonly ProjectExtensionInput[];
    /** Extra top-level manifest fields (`featureScript`, ...); reserved keys are ignored. */
    readonly manifest?: Record<string, unknown>;
}

export interface UnpackedExtension {
    readonly entry: ProjectExtensionEntry;
    /** Keyed relative to the prefix. */
    readonly files: Record<string, Uint8Array>;
}

export interface UnpackedProject {
    readonly manifest: ProjectManifest;
    /** The serialized document with every externalized source inlined again. */
    readonly document: Serialized;
    readonly thumbnail?: Uint8Array;
    /** Every folder listed in `extensions`, plus `history/` whenever the archive has it. */
    readonly extensions: Map<string, UnpackedExtension>;
    /** Problems that do not stop loading (a hand-edited source, a missing thumbnail). */
    readonly warnings: string[];
}

const RESERVED_MANIFEST_KEYS = new Set([
    "format",
    "formatVersion",
    "app",
    "createdAt",
    "modifiedAt",
    "document",
    "elements",
    "files",
    "extensions",
    "geometry",
]);

const utf8 = (text: string) => new TextEncoder().encode(text);
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const toBytes = (data: Uint8Array | string) => (typeof data === "string" ? utf8(data) : data);

function documentNodes(document: Serialized): Result<Record<string, unknown>[]> {
    if (document[InternalClassName] !== "Document") return Result.err("document.json is not a document");
    const nodes = (document["models"] as Record<string, unknown> | undefined)?.["nodes"];
    if (!Array.isArray(nodes) || nodes.some((node) => !isRecord(node))) {
        return Result.err("document.json has no model tree");
    }
    return Result.ok(nodes as Record<string, unknown>[]);
}

/** A provider-supplied entry key as a path relative to `prefix`, or undefined when unsafe. */
function relativeEntryPath(prefix: string, key: string): string | undefined {
    const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    if (relative.length === 0 || relative.startsWith("/") || relative.includes("\\")) return undefined;
    if (relative.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
    return relative;
}

export function packProject(input: ProjectPackInput): Result<ProjectFiles> {
    // A deep copy in exactly the JSON form the file holds.
    const document = JSON.parse(JSON.stringify(input.document)) as Serialized;
    const nodes = documentNodes(document);
    if (!nodes.isOk) return Result.err(nodes.error);

    const content = new Map<string, { data: Uint8Array; role: ProjectFileRole }>();
    const elements: ProjectElement[] = [];
    const root = nodes.value[0];
    if (root !== undefined) {
        elements.push({ id: String(root["id"]), kind: PART_STUDIO_KIND, name: String(document["name"]) });
    }

    const sources = new Map<string, { data: Uint8Array; role: ProjectFileRole }>();
    const usedNames = new Map<string, Set<string>>();
    for (const node of nodes.value) {
        let element: ProjectElement | undefined;
        for (const spec of projectSourceElementSpecs(String(node[InternalClassName]))) {
            const value = node[spec.field];
            if (typeof value !== "string" || (spec.skipEmpty === true && value === "")) continue;
            const encoding = sourceEncoding(spec, node);
            const data = encoding === "base64" ? base64ToBytes(value) : utf8(value);
            // A value that is not the base64 it claims to be stays inline: never lose data.
            if (data === undefined) continue;
            const used = usedNames.get(spec.folder) ?? new Set<string>();
            usedNames.set(spec.folder, used);
            const name = typeof node["name"] === "string" ? node["name"] : spec.kind;
            const path = spec.folder + sourceFileName(spec, node, name, used);
            sources.set(path, { data, role: "source" });
            node[spec.field] =
                encoding === "base64"
                    ? { [PROJECT_FILE_REF_KEY]: path, [PROJECT_FILE_ENCODING_KEY]: "base64" }
                    : { [PROJECT_FILE_REF_KEY]: path };
            element ??= { id: String(node["id"]), kind: spec.kind, name, path };
        }
        if (element !== undefined) elements.push(element);
    }
    for (const element of input.elements ?? []) {
        if (!elements.some((existing) => existing.id === element.id)) elements.push(element);
    }

    content.set(PROJECT_DOCUMENT_PATH, { data: utf8(JSON.stringify(document, null, 2)), role: "document" });
    for (const [path, file] of sources) content.set(path, file);
    if (input.thumbnail !== undefined && input.thumbnail.length > 0) {
        content.set(PROJECT_THUMBNAIL_PATH, { data: input.thumbnail, role: "thumbnail" });
    }

    const geometry: ProjectGeometryCacheEntry[] = [];
    const usedGeometryNames = new Set<string>();
    for (const cache of input.geometry ?? []) {
        const path = PROJECT_GEOMETRY_FOLDER + safeProjectFileName(cache.name, ".brep", usedGeometryNames);
        content.set(path, { data: toBytes(cache.data), role: "cache" });
        geometry.push({ nodeId: cache.nodeId, name: cache.name, path });
    }

    const extensions: ProjectExtensionEntry[] = [];
    for (const extension of input.extensions ?? []) {
        if (!isValidProjectPrefix(extension.prefix)) {
            return Result.err(`Invalid project folder "${extension.prefix}"`);
        }
        if (extensions.some((existing) => existing.prefix === extension.prefix)) {
            return Result.err(`Project folder "${extension.prefix}" is written twice`);
        }
        const files: string[] = [];
        for (const [key, data] of Object.entries(extension.files)) {
            const relative = relativeEntryPath(extension.prefix, key);
            if (relative === undefined) {
                return Result.err(`Invalid entry "${key}" in project folder "${extension.prefix}"`);
            }
            content.set(extension.prefix + relative, { data: toBytes(data), role: "extension" });
            files.push(relative);
        }
        extensions.push({
            prefix: extension.prefix,
            ...(extension.name === undefined ? {} : { name: extension.name }),
            ...(extension.version === undefined ? {} : { version: extension.version }),
            files: files.sort(),
        });
    }

    const contributions = Object.fromEntries(
        Object.entries(input.manifest ?? {}).filter(([key]) => !RESERVED_MANIFEST_KEYS.has(key)),
    );
    const manifest: ProjectManifest = {
        format: PROJECT_FORMAT,
        formatVersion: PROJECT_FORMAT_VERSION,
        app: { name: input.app.name, version: input.app.version },
        createdAt: input.createdAt,
        modifiedAt: input.modifiedAt,
        document: {
            id: String(document["id"]),
            name: String(document["name"]),
            version: String(document["version"]),
            ...(typeof document["schemaVersion"] === "number"
                ? { schemaVersion: document["schemaVersion"] }
                : {}),
        },
        ...contributions,
        elements,
        files: [...content].map(([path, file]) => fileEntry(path, file.data, file.role)),
        extensions,
        ...(geometry.length === 0 ? {} : { geometry: { authoritative: false as const, entries: geometry } }),
    };

    const files: ProjectFiles = new Map();
    files.set(PROJECT_MANIFEST_PATH, utf8(JSON.stringify(manifest, null, 2)));
    for (const [path, file] of content) files.set(path, file.data);
    return Result.ok(files);
}

function sourceEncoding(
    spec: ProjectSourceElementSpec,
    node: Record<string, unknown>,
): ProjectSourceEncoding {
    const encoding = typeof spec.encoding === "function" ? spec.encoding(node) : spec.encoding;
    return encoding === "base64" ? "base64" : "text";
}

const FILE_EXTENSION = /^\.[A-Za-z0-9_-]{1,12}$/;

/** `<name><extension>`, or the spec's own file name for the node, split at its extension. */
function sourceFileName(
    spec: ProjectSourceElementSpec,
    node: Record<string, unknown>,
    name: string,
    used: Set<string>,
): string {
    const own = spec.fileName?.(node);
    if (own === undefined || own.trim() === "") {
        return safeProjectFileName(name, spec.extensionOf?.(node) ?? spec.extension, used);
    }
    const dot = own.lastIndexOf(".");
    const extension = dot > 0 && FILE_EXTENSION.test(own.slice(dot)) ? own.slice(dot) : "";
    return safeProjectFileName(extension === "" ? own : own.slice(0, dot), extension, used);
}

function fileEntry(path: string, data: Uint8Array, role: ProjectFileRole): ProjectFileEntry {
    return {
        path,
        size: data.length,
        sha256: sha256Hex(data),
        role,
        ...(role === "cache" ? { authoritative: false as const } : {}),
    };
}

// ------------------------------------------------------------------ Reading

function parseJson(bytes: Uint8Array, path: string): Result<unknown> {
    try {
        return Result.ok(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch {
        return Result.err(`${path} is not valid JSON`);
    }
}

function decodeText(bytes: Uint8Array, path: string): Result<string> {
    try {
        return Result.ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        return Result.err(`${path} is not UTF-8 text`);
    }
}

function validateManifest(value: unknown): Result<ProjectManifest> {
    if (!isRecord(value)) return Result.err("manifest.json is not an object");
    if (value["format"] !== PROJECT_FORMAT) {
        return Result.err(`Not a Chili3D project (format: ${JSON.stringify(value["format"])})`);
    }
    const version = value["formatVersion"];
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        return Result.err(`Bad manifest: formatVersion ${JSON.stringify(version)} is not a version number`);
    }
    if (version > PROJECT_FORMAT_VERSION) {
        return Result.err(
            `This project uses format version ${version}; this Chili3D reads up to version ${PROJECT_FORMAT_VERSION}. Update Chili3D to open it.`,
        );
    }
    if (!isRecord(value["document"]) || typeof value["document"]["id"] !== "string") {
        return Result.err("Bad manifest: no document entry");
    }
    for (const key of ["elements", "files", "extensions"]) {
        if (value[key] !== undefined && !Array.isArray(value[key])) {
            return Result.err(`Bad manifest: ${key} is not a list`);
        }
    }
    return Result.ok({
        ...value,
        elements: (value["elements"] as ProjectElement[] | undefined) ?? [],
        files: (value["files"] as ProjectFileEntry[] | undefined) ?? [],
        extensions: (value["extensions"] as ProjectExtensionEntry[] | undefined) ?? [],
    } as unknown as ProjectManifest);
}

/** `{ "$file": path }`, optionally with `"$encoding"` — nothing else. */
function isFileReference(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) return false;
    const keys = Object.keys(value);
    return (
        keys.includes(PROJECT_FILE_REF_KEY) &&
        keys.every((key) => key === PROJECT_FILE_REF_KEY || key === PROJECT_FILE_ENCODING_KEY)
    );
}

function inlineSources(
    nodes: Record<string, unknown>[],
    files: ReadonlyMap<string, Uint8Array>,
): Result<void> {
    for (const node of nodes) {
        for (const [key, value] of Object.entries(node)) {
            if (!isFileReference(value)) continue;
            const path = value[PROJECT_FILE_REF_KEY];
            if (typeof path !== "string") return Result.err(`document.json has a bad file reference`);
            const bytes = files.get(path);
            if (bytes === undefined) return Result.err(`The project is missing ${path}`);
            const encoding = value[PROJECT_FILE_ENCODING_KEY];
            if (encoding === "base64") {
                node[key] = bytesToBase64(bytes);
                continue;
            }
            if (encoding !== undefined) {
                return Result.err(
                    `document.json stores ${path} in an unknown encoding (${String(encoding)})`,
                );
            }
            const text = decodeText(bytes, path);
            if (!text.isOk) return Result.err(text.error);
            node[key] = text.value;
        }
    }
    return Result.ok(undefined);
}

function checkListedFiles(manifest: ProjectManifest, files: ReadonlyMap<string, Uint8Array>): string[] {
    const warnings: string[] = [];
    for (const entry of manifest.files) {
        if (!isRecord(entry) || typeof entry.path !== "string") continue;
        const bytes = files.get(entry.path);
        if (bytes === undefined) {
            if (entry.role !== "source" && entry.role !== "document") {
                warnings.push(`${entry.path} is listed but missing`);
            }
            continue;
        }
        if (
            entry.size !== bytes.length ||
            (typeof entry.sha256 === "string" && entry.sha256 !== sha256Hex(bytes))
        ) {
            warnings.push(`${entry.path} was changed outside Chili3D`);
        }
    }
    return warnings;
}

function extensionFolders(
    manifest: ProjectManifest,
    files: ReadonlyMap<string, Uint8Array>,
): Map<string, UnpackedExtension> {
    const entries = new Map<string, ProjectExtensionEntry>();
    for (const entry of manifest.extensions) {
        if (isRecord(entry) && typeof entry.prefix === "string" && isValidProjectPrefix(entry.prefix)) {
            entries.set(entry.prefix, entry);
        }
    }
    const hasHistory = [...files.keys()].some((path) => path.startsWith(PROJECT_HISTORY_FOLDER));
    if (hasHistory && !entries.has(PROJECT_HISTORY_FOLDER)) {
        entries.set(PROJECT_HISTORY_FOLDER, { prefix: PROJECT_HISTORY_FOLDER, files: [] });
    }
    const result = new Map<string, UnpackedExtension>();
    for (const [prefix, entry] of entries) {
        const folder: Record<string, Uint8Array> = {};
        for (const [path, bytes] of files) {
            if (!path.startsWith(prefix)) continue;
            const relative = relativeEntryPath(prefix, path);
            if (relative !== undefined) folder[relative] = bytes;
        }
        result.set(prefix, { entry, files: folder });
    }
    return result;
}

/**
 * Validates an archive's entries and rebuilds the serialized document. Unknown entries
 * are ignored (a newer writer may add some); a newer `formatVersion` is refused.
 */
export function unpackProject(files: ReadonlyMap<string, Uint8Array>): Result<UnpackedProject> {
    const manifestBytes = files.get(PROJECT_MANIFEST_PATH);
    if (manifestBytes === undefined) return Result.err("Not a Chili3D project: manifest.json is missing");
    const manifestJson = parseJson(manifestBytes, PROJECT_MANIFEST_PATH);
    if (!manifestJson.isOk) return Result.err(manifestJson.error);
    const manifest = validateManifest(manifestJson.value);
    if (!manifest.isOk) return Result.err(manifest.error);

    const documentBytes = files.get(PROJECT_DOCUMENT_PATH);
    if (documentBytes === undefined) return Result.err("The project is missing document.json");
    const documentJson = parseJson(documentBytes, PROJECT_DOCUMENT_PATH);
    if (!documentJson.isOk) return Result.err(documentJson.error);
    if (!isRecord(documentJson.value)) return Result.err("document.json is not a document");
    const document = documentJson.value as Serialized;
    const nodes = documentNodes(document);
    if (!nodes.isOk) return Result.err(nodes.error);
    const inlined = inlineSources(nodes.value, files);
    if (!inlined.isOk) return Result.err(inlined.error);

    const warnings = checkListedFiles(manifest.value, files);
    if (manifest.value.document.id !== document["id"]) {
        warnings.push("manifest.json and document.json name different documents");
    }
    return Result.ok({
        manifest: manifest.value,
        document,
        thumbnail: files.get(PROJECT_THUMBNAIL_PATH),
        extensions: extensionFolders(manifest.value, files),
        warnings,
    });
}

/** PNG bytes of an `image/png` data URL, or undefined for anything else. */
export function pngDataUrlBytes(dataUrl: string | undefined): Uint8Array | undefined {
    const prefix = "data:image/png;base64,";
    if (dataUrl === undefined || !dataUrl.startsWith(prefix)) return undefined;
    try {
        const binary = atob(dataUrl.slice(prefix.length));
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
        return undefined;
    }
}
