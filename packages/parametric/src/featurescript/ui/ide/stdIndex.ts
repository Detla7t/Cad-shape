// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Declaration, scanDeclarations } from "./declarations";
import { type ParsedDoc, parseDocComment } from "./docComment";
import { normalizeNewlines } from "./scanner";

/**
 * What the editor knows about Onshape's std: each module's declarations (scanned from the
 * bundled source on first use) and, per module, the names an importer sees — its own
 * exports plus everything its `export import`s pass on, transitively, which for
 * `geometry.fs` is the whole std surface a Feature Studio programs against.
 *
 * Scanning all of `geometry.fs`'s closure reads several megabytes of source, so `warm`
 * does it in small slices off the critical path; lookups before that scan what they need.
 */

export const STD_PREFIX = "onshape/std/";
export const GEOMETRY_MODULE = "geometry.fs";

export interface StdSourceLike {
    read(file: string): string | undefined;
    readonly version: number;
}

export interface StdModule {
    /** The module file under `onshape/std/`, e.g. `geomOperations.fs`. */
    readonly file: string;
    readonly source: string;
    readonly declarations: readonly Declaration[];
}

/** One exported declaration and the module that declares it. */
export interface StdEntry {
    readonly module: string;
    readonly declaration: Declaration;
}

export class StdIndex {
    private readonly modules = new Map<string, StdModule | null>();
    private readonly exports = new Map<string, ReadonlyMap<string, readonly StdEntry[]>>();
    private readonly docs = new WeakMap<Declaration, ParsedDoc>();
    private readonly warming = new Map<string, Promise<void>>();

    constructor(readonly source: StdSourceLike) {}

    get version(): number {
        return this.source.version;
    }

    /** A std module's declarations; undefined when std has no such file. */
    module(file: string): StdModule | undefined {
        let module = this.modules.get(file);
        if (module === undefined) {
            const raw = this.source.read(file);
            // Std ships with CRLF line endings; offsets must match the editor's `\n` documents.
            const source = raw === undefined ? undefined : normalizeNewlines(raw);
            module = source === undefined ? null : { file, source, declarations: scanDeclarations(source) };
            this.modules.set(file, module);
        }
        return module ?? undefined;
    }

    /** Whether `module(file)` would not need a scan. */
    isScanned(file: string): boolean {
        return this.modules.has(file);
    }

    /** The std module files scanned so far (after `warm`: everything `geometry.fs` reaches). */
    scannedModules(): string[] {
        return [...this.modules].flatMap(([file, module]) => (module === null ? [] : [file])).sort();
    }

    /** name → its exported declarations (overloads in order) for a module importing `file`. */
    exportsOf(file: string): ReadonlyMap<string, readonly StdEntry[]> {
        const done = this.exports.get(file);
        if (done !== undefined) return done;
        const result = new Map<string, StdEntry[]>();
        this.exports.set(file, result); // cycle guard: an import cycle sees the partial map
        const module = this.module(file);
        if (module !== undefined) {
            for (const declaration of module.declarations) {
                if (!declaration.exported) continue;
                if (declaration.kind === "import") {
                    const imported = stdFile(declaration.name);
                    if (imported === undefined) continue;
                    for (const [name, entries] of this.exportsOf(imported)) {
                        // A module's own declaration shadows an import of the same name...
                        const own = result.get(name);
                        if (own === undefined) result.set(name, [...entries]);
                        else if (own[0]?.module !== file) {
                            // ...overloads merge — once each, however many paths export them.
                            for (const entry of entries) {
                                if (!own.some((known) => known.declaration === entry.declaration))
                                    own.push(entry);
                            }
                        }
                    }
                    continue;
                }
                const own = result.get(declaration.name);
                const entry = { module: file, declaration };
                if (own === undefined || own[0]?.module !== file) result.set(declaration.name, [entry]);
                else own.push(entry);
            }
        }
        return result;
    }

    /** The doc comment of a declaration, parsed once. */
    doc(declaration: Declaration): ParsedDoc | undefined {
        if (declaration.doc === undefined) return undefined;
        let doc = this.docs.get(declaration);
        if (doc === undefined) {
            doc = parseDocComment(declaration.doc);
            this.docs.set(declaration, doc);
        }
        return doc;
    }

    /**
     * Scans every module `file`'s exports reach in slices of about `sliceMs` (`yieldNow`
     * between slices), so a later `exportsOf(file)` is instant. Resolves once done.
     */
    warm(file = GEOMETRY_MODULE, yieldNow: () => Promise<void> = idle, sliceMs = 12): Promise<void> {
        let warming = this.warming.get(file);
        if (warming === undefined) {
            warming = this.scanClosure(file, yieldNow, sliceMs);
            this.warming.set(file, warming);
        }
        return warming;
    }

    private async scanClosure(file: string, yieldNow: () => Promise<void>, sliceMs: number): Promise<void> {
        const queue = [file];
        const seen = new Set<string>(queue);
        let sliceStart = performance.now();
        while (queue.length > 0) {
            const next = queue.shift() as string;
            if (!this.isScanned(next)) {
                this.module(next);
                if (performance.now() - sliceStart > sliceMs) {
                    await yieldNow();
                    sliceStart = performance.now();
                }
            }
            for (const declaration of this.module(next)?.declarations ?? []) {
                if (declaration.kind !== "import" || !declaration.exported) continue;
                const imported = stdFile(declaration.name);
                if (imported !== undefined && !seen.has(imported)) {
                    seen.add(imported);
                    queue.push(imported);
                }
            }
        }
        this.exportsOf(file);
    }
}

/** `onshape/std/foo.fs` → `foo.fs`; undefined for a non-std path. */
export function stdFile(path: string): string | undefined {
    return path.startsWith(STD_PREFIX) ? path.slice(STD_PREFIX.length) : undefined;
}

function idle(): Promise<void> {
    return new Promise((resolve) => {
        const request = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
            .requestIdleCallback;
        if (request !== undefined) request(() => resolve(), { timeout: 200 });
        else setTimeout(resolve, 0);
    });
}

const indexes = new WeakMap<StdSourceLike, StdIndex>();

/** The shared index of one std source. */
export function stdIndexFor(source: StdSourceLike): StdIndex {
    let index = indexes.get(source);
    if (index === undefined) {
        index = new StdIndex(source);
        indexes.set(source, index);
    }
    return index;
}
