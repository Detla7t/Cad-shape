// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Declaration, scanDeclarations } from "./declarations";
import { type ParsedDoc, parseDocComment } from "./docComment";
import { type StdIndex, stdFile } from "./stdIndex";

/**
 * The names a studio's code can use, and where each comes from: the studio's own
 * top-level declarations, what its imports bring in — other studios of the document
 * (by name, with their `export import`s) and std modules (through the `StdIndex`) — and
 * namespaced imports (`Foo::import(...)`, reached as `Foo::name`).
 */

export type SymbolOrigin =
    | { readonly kind: "local" }
    | { readonly kind: "studio"; readonly studioId: string; readonly studioName: string }
    | { readonly kind: "std"; readonly module: string };

export interface SymbolInfo {
    readonly name: string;
    readonly kind: Declaration["kind"];
    readonly origin: SymbolOrigin;
    /** Every declaration of the name (overloads), in order; all from the same origin kind. */
    readonly declarations: readonly Declaration[];
    /** The module each declaration lives in, parallel to `declarations` (std modules only). */
    readonly modules?: readonly string[];
}

export interface StudioSource {
    readonly id: string;
    readonly name: string;
    readonly source: string;
}

export interface SymbolEnvironment {
    /** Onshape's std, when the app has it. */
    readonly std?: StdIndex;
    /** Resolves a non-std import path (a studio name or id). */
    readonly studio: (path: string) => StudioSource | undefined;
}

export class SymbolTable {
    readonly symbols = new Map<string, SymbolInfo>();
    readonly namespaces = new Map<string, Map<string, SymbolInfo>>();
    private readonly docs = new WeakMap<Declaration, ParsedDoc | null>();

    constructor(
        readonly declarations: readonly Declaration[],
        readonly std?: StdIndex,
    ) {}

    lookup(name: string, namespace?: string): SymbolInfo | undefined {
        return namespace === undefined ? this.symbols.get(name) : this.namespaces.get(namespace)?.get(name);
    }

    /** The parsed doc comment of a symbol's first documented declaration. */
    doc(symbol: SymbolInfo): ParsedDoc | undefined {
        for (const declaration of symbol.declarations) {
            if (declaration.doc === undefined) continue;
            if (this.std !== undefined && symbol.origin.kind === "std") return this.std.doc(declaration);
            let doc = this.docs.get(declaration);
            if (doc === undefined) {
                doc = parseDocComment(declaration.doc);
                this.docs.set(declaration, doc);
            }
            return doc ?? undefined;
        }
        return undefined;
    }
}

function addTo(target: Map<string, SymbolInfo>, symbol: SymbolInfo, shadow: boolean): void {
    const existing = target.get(symbol.name);
    if (existing === undefined || shadow) {
        target.set(symbol.name, symbol);
        return;
    }
    // Overloads of one name from two imports merge (std's rule).
    if (existing.origin.kind === symbol.origin.kind && existing.origin.kind !== "local") {
        target.set(symbol.name, {
            ...existing,
            declarations: [...existing.declarations, ...symbol.declarations],
            modules:
                existing.modules !== undefined || symbol.modules !== undefined
                    ? [...(existing.modules ?? []), ...(symbol.modules ?? [])]
                    : undefined,
        });
    }
}

/** What importing `path` brings into scope (`seen` guards studio import cycles). */
function importedSymbols(path: string, env: SymbolEnvironment, seen: Set<string>): Map<string, SymbolInfo> {
    const result = new Map<string, SymbolInfo>();
    const file = stdFile(path);
    if (file !== undefined) {
        if (env.std === undefined) return result;
        for (const [name, entries] of env.std.exportsOf(file)) {
            const first = entries[0];
            if (first === undefined) continue;
            result.set(name, {
                name,
                kind: first.declaration.kind,
                origin: { kind: "std", module: first.module },
                declarations: entries.map((entry) => entry.declaration),
                modules: entries.map((entry) => entry.module),
            });
        }
        return result;
    }
    const studio = env.studio(path);
    if (studio === undefined || seen.has(studio.id)) return result;
    seen.add(studio.id);
    const origin: SymbolOrigin = { kind: "studio", studioId: studio.id, studioName: studio.name };
    for (const declaration of scanDeclarations(studio.source)) {
        if (!declaration.exported) continue;
        if (declaration.kind === "import") {
            if (declaration.namespace !== undefined) continue;
            for (const symbol of importedSymbols(declaration.name, env, seen).values()) {
                addTo(result, symbol, false);
            }
            continue;
        }
        addTo(
            result,
            { name: declaration.name, kind: declaration.kind, origin, declarations: [declaration] },
            true,
        );
    }
    return result;
}

/** The symbol table of a studio whose top-level `declarations` were scanned from its source. */
export function buildSymbolTable(declarations: readonly Declaration[], env: SymbolEnvironment): SymbolTable {
    const table = new SymbolTable(declarations, env.std);
    for (const declaration of declarations) {
        if (declaration.kind !== "import") continue;
        const imported = importedSymbols(declaration.name, env, new Set());
        if (declaration.namespace !== undefined) {
            table.namespaces.set(declaration.namespace, imported);
            continue;
        }
        for (const symbol of imported.values()) addTo(table.symbols, symbol, false);
    }
    // The studio's own declarations shadow anything imported; its overloads collect.
    const own = new Map<string, Declaration[]>();
    for (const declaration of declarations) {
        if (declaration.kind === "import" || declaration.kind === "operator") continue;
        const list = own.get(declaration.name) ?? [];
        list.push(declaration);
        own.set(declaration.name, list);
    }
    for (const [name, list] of own) {
        table.symbols.set(name, { name, kind: list[0].kind, origin: { kind: "local" }, declarations: list });
    }
    return table;
}
