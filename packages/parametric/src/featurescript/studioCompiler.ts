// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "@chili3d/core";
import { analyzeFeature, analyzeTable, type FeatureSpec } from "./featureSpec";
import { FeatureStudioNode } from "./featureStudioNode";
import type {
    FeatureExport,
    Interpreter,
    ModuleInstance,
    ModuleSource,
    TableExport,
} from "./lang/interpreter";
import { createInterpreter, describeError } from "./runtime";

/**
 * Compiles the Feature Studios of a document, cached by source. A studio imports another
 * by name (`import(path : "Fasteners", version : "")`) — or by node id — and the cache
 * key covers every source the compilation read, so editing an imported studio
 * recompiles its importers.
 *
 * One interpreter per compiled studio: modules are instantiated once and reused by every
 * rebuild of every body running the studio's features. Each run gets a fresh step
 * budget (`Interpreter.resetBudget`).
 */

export interface CompiledStudio {
    readonly studioId: string;
    readonly interpreter: Interpreter;
    readonly module?: ModuleInstance;
    readonly features: readonly FeatureExport[];
    readonly error?: string;
    readonly line?: number;
    readonly column?: number;
    /** Node ids of the other studios this one imported (transitively). */
    readonly dependencies: readonly string[];
    /** Output of `print`/`println`, from loading and from feature runs (most recent last, bounded). */
    readonly log: string[];
    spec(featureName: string): FeatureSpec | undefined;
    feature(featureName: string): FeatureExport | undefined;
    /** Custom tables the studio exports (`defineTable`), with their parameter specs. */
    readonly tables: readonly TableExport[];
    table(tableName: string): TableExport | undefined;
    tableSpec(tableName: string): FeatureSpec | undefined;
}

const MAX_CACHE = 48;
const MAX_LOG = 200;
const cache = new Map<string, CompiledStudio>();
/** studio id → the dependencies its latest compilation read; what bodies watch. */
const lastDependencies = new Map<string, readonly string[]>();

export function findStudio(document: IDocument, idOrName: string): FeatureStudioNode | undefined {
    const byId = document.modelManager.findNode(
        (node) => node instanceof FeatureStudioNode && node.id === idOrName,
    );
    if (byId instanceof FeatureStudioNode) return byId;
    const byName = document.modelManager.findNode(
        (node) => node instanceof FeatureStudioNode && node.name === idOrName,
    );
    return byName instanceof FeatureStudioNode ? byName : undefined;
}

export function documentStudios(document: IDocument): FeatureStudioNode[] {
    return document.modelManager.findNodes(
        (node) => node instanceof FeatureStudioNode,
    ) as FeatureStudioNode[];
}

/** The studio ids the latest compilation of `studioId` imported — without needing the document. */
export function studioDependencies(studioId: string): readonly string[] {
    return lastDependencies.get(studioId) ?? [];
}

/** A token that changes whenever the studio's source, or any source it imports, changes. */
export function studioToken(document: IDocument, studioId: string): string {
    const studio = findStudio(document, studioId);
    if (studio === undefined) return "missing";
    const parts = [
        studio.source,
        ...studioDependencies(studio.id).map((id) => findStudio(document, id)?.source ?? "missing"),
    ];
    return hashString(parts.join("\u0000"));
}

export function compileDocumentStudio(document: IDocument, studioId: string): CompiledStudio | undefined {
    const studio = findStudio(document, studioId);
    if (studio === undefined) return undefined;
    return compileStudioSource(studio.id, studio.name, studio.source, (path) => {
        const imported = findStudio(document, path);
        return imported === undefined
            ? undefined
            : { id: imported.id, name: imported.name, source: imported.source };
    });
}

/**
 * Compiles one studio source. `lookup` resolves an import path to another studio; the
 * cache key is the studio's own source plus each import's source, discovered on the
 * first compilation and re-validated on every lookup.
 */
export function compileStudioSource(
    studioId: string,
    name: string,
    source: string,
    lookup: (path: string) => { id: string; name: string; source: string } | undefined,
): CompiledStudio {
    const previous = lastDependencies.get(studioId) ?? [];
    const dependencySources = previous.map((id) => lookup(id)?.source ?? "\u0001missing");
    const key = [studioId, source, ...previous, ...dependencySources].join("\u0000");
    const cached = cache.get(key);
    if (cached !== undefined) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }
    const compiled = compileUncached(studioId, name, source, lookup);
    lastDependencies.set(studioId, compiled.dependencies);
    // Re-key under the dependencies actually read, so the next lookup hits.
    const finalKey = [
        studioId,
        source,
        ...compiled.dependencies,
        ...compiled.dependencies.map((id) => lookup(id)?.source ?? "\u0001missing"),
    ].join("\u0000");
    cache.set(finalKey, compiled);
    while (cache.size > MAX_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return compiled;
}

function compileUncached(
    studioId: string,
    name: string,
    source: string,
    lookup: (path: string) => { id: string; name: string; source: string } | undefined,
): CompiledStudio {
    const log: string[] = [];
    const dependencies = new Set<string>();
    const interpreter = createInterpreter({
        print: (text) => {
            log.push(text);
            if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
        },
        resolveModule: (path): ModuleSource | undefined => {
            const found = lookup(path);
            if (found === undefined) return undefined;
            if (found.id !== studioId) dependencies.add(found.id);
            return { path: found.name, source: found.source };
        },
    });
    const specs = new Map<string, FeatureSpec | undefined>();
    let module: ModuleInstance | undefined;
    let failure: ReturnType<typeof describeError> | undefined;
    try {
        module = interpreter.load({ path: name, source });
    } catch (error) {
        failure = describeError(error);
    }
    const features = module?.features ?? [];
    const tables = module?.tables ?? [];
    const tableSpecs = new Map<string, FeatureSpec | undefined>();
    /** Analyzes once per name; a precondition the analyzer cannot read yields no spec. */
    const cachedSpec = <T>(
        cache: Map<string, FeatureSpec | undefined>,
        name: string,
        exported: T | undefined,
        analyze: (exported: T) => FeatureSpec,
    ) => {
        if (!cache.has(name)) {
            let spec: FeatureSpec | undefined;
            try {
                spec = exported === undefined ? undefined : analyze(exported);
            } catch {
                spec = undefined;
            }
            cache.set(name, spec);
        }
        return cache.get(name);
    };
    return {
        studioId,
        interpreter,
        module,
        features,
        tables,
        error: failure?.error,
        line: failure?.line,
        column: failure?.column,
        dependencies: [...dependencies],
        log,
        feature: (featureName) => features.find((feature) => feature.name === featureName),
        spec: (featureName) =>
            cachedSpec(
                specs,
                featureName,
                features.find((candidate) => candidate.name === featureName),
                (feature) => analyzeFeature(interpreter, feature),
            ),
        table: (tableName) => tables.find((table) => table.name === tableName),
        tableSpec: (tableName) =>
            cachedSpec(
                tableSpecs,
                tableName,
                tables.find((candidate) => candidate.name === tableName),
                (table) => analyzeTable(interpreter, table),
            ),
    };
}

/** FNV-1a, enough to key a cache on source text. */
function hashString(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}
