// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The `.chili3d` project file: a zip with a `manifest.json` describing what is inside,
 * the serialized document (`document.json`), every text-sourced element (Feature
 * Studios, ...) as its own plain-text file, an optional thumbnail and optional
 * non-authoritative geometry caches. Folders owned by other modules (the version
 * history under `history/`) are written and read through `ProjectEntryProvider`s.
 * See `docs/project-format.md` for the full specification.
 */

export const PROJECT_FILE_EXTENSION = ".chili3d";
export const PROJECT_FORMAT = "chili3d-project";
/** Bumped only for changes an older reader cannot ignore; additions keep the version. */
export const PROJECT_FORMAT_VERSION = 1;
/** MIME type of the archive (for downloads and `?url=` responses). */
export const PROJECT_MIME_TYPE = "application/vnd.chili3d.project+zip";

export const PROJECT_MANIFEST_PATH = "manifest.json";
export const PROJECT_DOCUMENT_PATH = "document.json";
export const PROJECT_THUMBNAIL_PATH = "thumbnail.png";
export const PROJECT_GEOMETRY_FOLDER = "geometry/";
/** Reserved for the version-control system (commit graph, branches, named versions). */
export const PROJECT_HISTORY_FOLDER = "history/";

/** The key that replaces an externalized property in `document.json`: `{ "$file": "<path>" }`. */
export const PROJECT_FILE_REF_KEY = "$file";
/**
 * Beside `$file` for a binary file: `{ "$file": "<path>", "$encoding": "base64" }` — the property
 * holds the file's bytes as base64, the archive holds the bytes themselves.
 */
export const PROJECT_FILE_ENCODING_KEY = "$encoding";

/** One element (tab) of the document. */
export interface ProjectElement {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    /** The file holding the element's source, for text-sourced elements. */
    readonly path?: string;
}

export type ProjectFileRole = "document" | "source" | "thumbnail" | "cache" | "extension";

export interface ProjectFileEntry {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly role: ProjectFileRole;
    /** False for caches: the file is derived data, never read back into the document. */
    readonly authoritative?: false;
}

/** A folder written by a `ProjectEntryProvider` (see `projectExtensions.ts`). */
export interface ProjectExtensionEntry {
    readonly prefix: string;
    readonly name?: string;
    readonly version?: number;
    /** Paths relative to `prefix`. */
    readonly files: readonly string[];
}

export interface ProjectGeometryCacheEntry {
    readonly nodeId: string;
    readonly name: string;
    readonly path: string;
}

export interface ProjectManifest {
    readonly format: typeof PROJECT_FORMAT;
    readonly formatVersion: number;
    readonly app: { readonly name: string; readonly version: string };
    /** ISO 8601 timestamps. */
    readonly createdAt: string;
    readonly modifiedAt: string;
    readonly document: { readonly id: string; readonly name: string; readonly version: string };
    readonly featureScript?: { readonly std: string; readonly version: number };
    readonly elements: readonly ProjectElement[];
    readonly files: readonly ProjectFileEntry[];
    readonly extensions: readonly ProjectExtensionEntry[];
    readonly geometry?: {
        readonly authoritative: false;
        readonly entries: readonly ProjectGeometryCacheEntry[];
    };
    readonly [key: string]: unknown;
}

/**
 * A node class whose (large) property is stored as its own file instead of inline in
 * `document.json` — a Feature Studio's FeatureScript source becomes
 * `featurestudios/<name>.fs`, a Data Source's attached spreadsheet `data/<name>.xlsx`.
 * Registered by the module that owns the class; a class may externalize several properties
 * (one spec each, distinct extensions when they share a folder).
 */
export interface ProjectSourceElementSpec {
    /** The serialized class name (`__cla$$__`). */
    readonly className: string;
    /** The manifest element kind, e.g. "featureStudio". */
    readonly kind: string;
    /** The serialized string property moved out of `document.json`. */
    readonly field: string;
    /** Zip folder, ending in "/". */
    readonly folder: string;
    /** File extension including the dot, e.g. ".fs". */
    readonly extension: string;
    /**
     * The extension for one serialized node — e.g. taken from an attached file's name — or
     * undefined to use `extension`.
     */
    readonly extensionOf?: (node: Readonly<Record<string, unknown>>) => string | undefined;
    /**
     * `"utf8"` (default): the property is text, stored as UTF-8. `"base64"`: the property is
     * binary content as base64, stored as the raw bytes (and base64-encoded again on read).
     */
    readonly encoding?: "utf8" | "base64";
    /** Keep an empty property inline (no file) — for optional content such as an attachment. */
    readonly skipEmpty?: boolean;
}

const sourceElements = new Map<string, ProjectSourceElementSpec[]>();
const elementKinds = new Map<string, string>();

/** Registers one externalized property; a second spec for the same class and field replaces it. */
export function registerProjectSourceElement(spec: ProjectSourceElementSpec): void {
    if (!spec.folder.endsWith("/")) throw new Error(`Project folder must end in "/": ${spec.folder}`);
    const specs = (sourceElements.get(spec.className) ?? []).filter((x) => x.field !== spec.field);
    sourceElements.set(spec.className, [...specs, spec]);
    elementKinds.set(spec.className, spec.kind);
}

/** Names the manifest kind of a sceneless node class that keeps its data inline. */
export function registerProjectElementKind(className: string, kind: string): void {
    elementKinds.set(className, kind);
}

/** The first externalized property of a class — the file its manifest element points at. */
export function projectSourceElementSpec(className: string): ProjectSourceElementSpec | undefined {
    return sourceElements.get(className)?.[0];
}

/** Every externalized property of a class, in registration order. */
export function projectSourceElementSpecs(className: string): readonly ProjectSourceElementSpec[] {
    return sourceElements.get(className) ?? [];
}

/** The manifest kind of a node class: registered, else derived ("VariableStudioNode" → "variableStudio"). */
export function projectElementKind(className: string): string {
    const registered = elementKinds.get(className);
    if (registered !== undefined) return registered;
    const base = className.endsWith("Node") && className.length > 4 ? className.slice(0, -4) : className;
    return base.charAt(0).toLowerCase() + base.slice(1);
}

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A file name for `name` that is safe on every OS and unique (case-insensitively) among
 * `used`, which receives it: "Bracket", "Bracket (2)", ... Unicode letters stay readable.
 */
export function safeProjectFileName(name: string, extension: string, used: Set<string>): string {
    let base = name
        .normalize("NFC")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^[\s.]+|[\s.]+$/g, "")
        .slice(0, 80);
    if (base.length === 0) base = "untitled";
    if (RESERVED_DEVICE_NAMES.test(base)) base = `_${base}`;
    let candidate = `${base}${extension}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
}
