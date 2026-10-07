// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsScanner, stringValue } from "./scanner";

/**
 * A module's top-level declarations, read tolerantly: half-typed code yields what can be
 * recognized instead of an error, and declaration bodies are skipped bracket-by-bracket
 * without being analyzed — what the outline, completion, hover and go-to-definition
 * need, fast enough for the whole std. A declaration keeps the doc comment right above
 * it (before its annotations) and, for a feature, the parameters its precondition
 * declares (`definition.x is T`, `isLength(definition.x, ...)`).
 */

export type DeclarationKind =
    | "feature"
    | "function"
    | "predicate"
    | "operator"
    | "const"
    | "type"
    | "enum"
    | "import";

export interface ParamInfo {
    readonly name: string;
    readonly type?: string;
}

export interface Signature {
    readonly params: readonly ParamInfo[];
    readonly returns?: string;
}

/** A parameter a feature's precondition declares. */
export interface FeatureField {
    readonly name: string;
    /** The `is` type, or the predicate's quantity kind: "length", "angle", "integer", "real", "anything". */
    readonly type?: string;
    /** The annotation's "Name". */
    readonly label?: string;
    readonly bounds?: string;
    readonly from: number;
    readonly to: number;
}

export interface EnumMemberInfo {
    readonly name: string;
    readonly label?: string;
    readonly from: number;
    readonly to: number;
}

export interface Declaration {
    readonly kind: DeclarationKind;
    /** The declared name; an import's path; `operator+` for an operator. */
    readonly name: string;
    readonly exported: boolean;
    /** Offsets of the declared name (the path string for an import). */
    readonly nameFrom: number;
    readonly nameTo: number;
    /** From the first annotation (or `export`) to the end of the declaration. */
    readonly from: number;
    readonly to: number;
    readonly signature?: Signature;
    /** A const's or type's declared type (`const X is T`, `type X typecheck P`). */
    readonly type?: string;
    /** The raw doc comment above the declaration. */
    readonly doc?: string;
    /** Annotation map entries: key → value source text (string values decoded). */
    readonly annotation?: ReadonlyMap<string, string>;
    readonly fields?: readonly FeatureField[];
    readonly members?: readonly EnumMemberInfo[];
    /** An import's namespace (`Foo::import(...)`). */
    readonly namespace?: string;
    /** A feature's or function's precondition / body block offsets (`{` to past `}`). */
    readonly precondition?: { readonly from: number; readonly to: number };
    readonly body?: { readonly from: number; readonly to: number };
}

const QUANTITY_PREDICATES: Record<string, string> = {
    isLength: "length",
    isAngle: "angle",
    isInteger: "integer",
    isReal: "real",
    isAnything: "anything",
};

interface Saved {
    readonly kind: FsScanner["kind"];
    readonly start: number;
    readonly end: number;
    readonly pos: number;
}

class DeclarationReader {
    private readonly s: FsScanner;
    readonly declarations: Declaration[] = [];

    constructor(private readonly source: string) {
        this.s = new FsScanner(source);
    }

    private save(): Saved {
        const { kind, start, end, pos } = this.s;
        return { kind, start, end, pos };
    }

    private restore(saved: Saved): void {
        this.s.kind = saved.kind;
        this.s.start = saved.start;
        this.s.end = saved.end;
        this.s.pos = saved.pos;
    }

    private peekIs(text: string): boolean {
        const saved = this.save();
        this.s.nextSignificant();
        const result = this.s.is(text);
        this.restore(saved);
        return result;
    }

    read(): Declaration[] {
        const s = this.s;
        let doc: string | undefined;
        let annotation: { from: number; entries: Map<string, string> } | undefined;
        while (s.next() !== "eof") {
            if (s.kind === "doc") {
                doc = s.text();
                continue;
            }
            if (s.kind === "comment") continue;
            if (s.is("FeatureScript")) {
                this.skipTo(";");
                continue;
            }
            if (s.is("annotation")) {
                const from = s.start;
                s.nextSignificant();
                if (!s.is("{")) continue;
                const entries = this.annotationEntries();
                annotation =
                    annotation === undefined ? { from, entries } : { from: annotation.from, entries };
                continue;
            }
            const from = annotation?.from ?? s.start;
            const pending = { doc, annotation: annotation?.entries, from };
            doc = undefined;
            annotation = undefined;
            this.declaration(pending);
        }
        return this.declarations;
    }

    private declaration(pending: { doc?: string; annotation?: Map<string, string>; from: number }): void {
        const s = this.s;
        let exported = false;
        if (s.is("export")) {
            exported = true;
            s.nextSignificant();
        }
        const base = { exported, doc: pending.doc, annotation: pending.annotation, from: pending.from };
        if (s.kind === "ident" && this.peekIs("::")) {
            const namespace = s.text();
            s.nextSignificant(); // ::
            s.nextSignificant();
            if (s.is("import")) this.importDeclaration(base, namespace);
            return;
        }
        if (s.is("import")) {
            this.importDeclaration(base);
            return;
        }
        if (s.is("const")) {
            this.constDeclaration(base);
            return;
        }
        if (s.is("function")) {
            s.nextSignificant();
            if (s.kind !== "ident") return;
            const nameFrom = s.start;
            const name = s.text();
            const nameTo = s.end;
            s.nextSignificant();
            const fn = this.functionRest();
            this.declarations.push({ ...base, kind: "function", name, nameFrom, nameTo, to: s.end, ...fn });
            return;
        }
        if (s.is("predicate")) {
            s.nextSignificant();
            if (s.kind !== "ident") return;
            const nameFrom = s.start;
            const name = s.text();
            const nameTo = s.end;
            s.nextSignificant();
            const fn = this.functionRest();
            this.declarations.push({ ...base, kind: "predicate", name, nameFrom, nameTo, to: s.end, ...fn });
            return;
        }
        if (s.is("operator")) {
            s.nextSignificant();
            const nameFrom = s.start;
            const name = `operator${s.text()}`;
            const nameTo = s.end;
            s.nextSignificant();
            const fn = this.functionRest();
            this.declarations.push({ ...base, kind: "operator", name, nameFrom, nameTo, to: s.end, ...fn });
            return;
        }
        if (s.is("type")) {
            s.nextSignificant();
            if (s.kind !== "ident") return;
            const nameFrom = s.start;
            const name = s.text();
            const nameTo = s.end;
            s.nextSignificant();
            let type: string | undefined;
            if (s.is("typecheck")) {
                s.nextSignificant();
                type = this.typeName();
            }
            this.skipTo(";");
            this.declarations.push({ ...base, kind: "type", name, nameFrom, nameTo, to: s.end, type });
            return;
        }
        if (s.is("enum")) {
            s.nextSignificant();
            if (s.kind !== "ident") return;
            const nameFrom = s.start;
            const name = s.text();
            const nameTo = s.end;
            s.nextSignificant();
            const members = s.is("{") ? this.enumMembers() : [];
            this.declarations.push({ ...base, kind: "enum", name, nameFrom, nameTo, to: s.end, members });
        }
        // Anything else at the top level is skipped token by token.
    }

    private importDeclaration(
        base: { exported: boolean; doc?: string; annotation?: Map<string, string>; from: number },
        namespace?: string,
    ): void {
        const s = this.s;
        s.nextSignificant();
        if (!s.is("(")) return;
        let path: string | undefined;
        let nameFrom = s.start;
        let nameTo = s.end;
        while (s.nextSignificant() !== "eof" && !s.is(")") && !s.is(";")) {
            if (s.kind === "ident" && s.text() === "path") {
                let kind = s.nextSignificant();
                if (s.is(":")) kind = s.nextSignificant();
                if (kind === "string") {
                    path = stringValue(s.text());
                    nameFrom = s.start;
                    nameTo = s.end;
                }
            }
        }
        if (s.is(")")) {
            const saved = this.save();
            s.nextSignificant();
            if (!s.is(";")) this.restore(saved);
        }
        if (path === undefined) return;
        this.declarations.push({
            ...base,
            kind: "import",
            name: path,
            nameFrom,
            nameTo,
            to: s.end,
            namespace,
        });
    }

    private constDeclaration(base: {
        exported: boolean;
        doc?: string;
        annotation?: Map<string, string>;
        from: number;
    }): void {
        const s = this.s;
        s.nextSignificant();
        if (s.kind !== "ident") return;
        const nameFrom = s.start;
        const name = s.text();
        const nameTo = s.end;
        s.nextSignificant();
        let type: string | undefined;
        if (s.is("is")) {
            s.nextSignificant();
            type = this.typeName();
            s.nextSignificant();
        }
        if (!s.is("=")) {
            this.skipTo(";");
            this.declarations.push({ ...base, kind: "const", name, nameFrom, nameTo, to: s.end, type });
            return;
        }
        s.nextSignificant();
        if (s.kind === "ident" && s.text() === "defineFeature" && this.peekIs("(")) {
            s.nextSignificant(); // (
            s.nextSignificant();
            if (s.is("function")) {
                s.nextSignificant();
                if (s.kind === "ident") s.nextSignificant();
                const fn = this.functionRest();
                const fields =
                    fn.precondition !== undefined ? preconditionFields(this.source, fn.precondition) : [];
                this.skipTo(";");
                this.declarations.push({
                    ...base,
                    kind: "feature",
                    name,
                    nameFrom,
                    nameTo,
                    to: s.end,
                    ...fn,
                    fields,
                });
                return;
            }
        }
        if (s.is("function")) {
            s.nextSignificant();
            if (s.kind === "ident") s.nextSignificant();
            const fn = this.functionRest();
            this.skipTo(";");
            this.declarations.push({ ...base, kind: "function", name, nameFrom, nameTo, to: s.end, ...fn });
            return;
        }
        this.skipTo(";", true);
        this.declarations.push({ ...base, kind: "const", name, nameFrom, nameTo, to: s.end, type });
    }

    /**
     * With the scanner on a function's `(`: parameters, `returns`, the precondition and the
     * body; leaves the scanner on the body's closing `}`.
     */
    private functionRest(): {
        signature: Signature;
        precondition?: { from: number; to: number };
        body?: { from: number; to: number };
    } {
        const s = this.s;
        const params: ParamInfo[] = [];
        if (s.is("(")) {
            while (s.nextSignificant() !== "eof" && !s.is(")")) {
                if (s.kind !== "ident") {
                    if (s.is("{") || s.is(";")) break;
                    continue;
                }
                const name = s.text();
                const saved = this.save();
                s.nextSignificant();
                let type: string | undefined;
                if (s.is("is")) {
                    s.nextSignificant();
                    type = this.typeName();
                } else {
                    this.restore(saved);
                }
                params.push({ name, type });
                const after = this.save();
                s.nextSignificant();
                if (!s.is(",")) this.restore(after);
            }
        }
        const signature: { params: ParamInfo[]; returns?: string } = { params };
        let saved = this.save();
        s.nextSignificant();
        if (s.is("returns")) {
            s.nextSignificant();
            signature.returns = this.typeName();
            saved = this.save();
            s.nextSignificant();
        }
        let precondition: { from: number; to: number } | undefined;
        if (s.is("precondition")) {
            s.nextSignificant();
            if (s.is("{")) {
                const from = s.start;
                s.skipBalanced();
                precondition = { from, to: s.end };
            } else {
                this.skipTo(";");
            }
            saved = this.save();
            s.nextSignificant();
        }
        if (s.is("{")) {
            const from = s.start;
            s.skipBalanced();
            return { signature, precondition, body: { from, to: s.end } };
        }
        this.restore(saved);
        return { signature, precondition };
    }

    /** A (possibly namespaced) type name at the scanner; leaves the scanner on its last token. */
    private typeName(): string {
        const s = this.s;
        let name = s.text();
        if (s.kind === "ident" && this.peekIs("::")) {
            s.nextSignificant();
            s.nextSignificant();
            name = `${name}::${s.text()}`;
        }
        return name;
    }

    private enumMembers(): EnumMemberInfo[] {
        const s = this.s;
        const members: EnumMemberInfo[] = [];
        let label: string | undefined;
        while (s.nextSignificant() !== "eof" && !s.is("}")) {
            if (s.is("annotation")) {
                s.nextSignificant();
                if (s.is("{")) label = this.annotationEntries().get("Name");
                continue;
            }
            if (s.kind === "ident") {
                members.push({ name: s.text(), label, from: s.start, to: s.end });
                label = undefined;
            }
            if (s.is("{") || s.is("(") || s.is("[")) s.skipBalanced();
        }
        return members;
    }

    /** With the scanner on `{`: the map's `"key" : value` entries; leaves it on the `}`. */
    private annotationEntries(): Map<string, string> {
        return readMapEntries(this.s);
    }

    /** Skips to the next `terminator` outside brackets (stopping before a closer of the enclosing scope). */
    private skipTo(terminator: string, stopAtTopLevelKeyword = false): void {
        const s = this.s;
        while (s.nextSignificant() !== "eof") {
            if (s.is(terminator)) return;
            if (s.is("{") || s.is("(") || s.is("[")) {
                s.skipBalanced();
                continue;
            }
            if (s.is("}") || s.is(")") || s.is("]")) return;
            // A missing `;` must not swallow the next declaration.
            if (stopAtTopLevelKeyword && this.startsDeclaration()) {
                this.rewindToLineStart();
                return;
            }
        }
    }

    /** True when the current token begins a line and is `export`, `annotation`, `function` ... */
    private startsDeclaration(): boolean {
        const s = this.s;
        if (
            !(s.is("export") || s.is("annotation") || s.is("function") || s.is("predicate") || s.is("enum"))
        ) {
            return false;
        }
        const lineStart = this.source.lastIndexOf("\n", s.start - 1) + 1;
        return this.source.slice(lineStart, s.start).trim() === "";
    }

    private rewindToLineStart(): void {
        const s = this.s;
        s.pos = s.start;
        s.end = s.start;
    }
}

/** With the scanner on `{`: `"key" : value` entries of a map literal; leaves it on the `}`. */
export function readMapEntries(s: FsScanner): Map<string, string> {
    const entries = new Map<string, string>();
    let key: string | undefined;
    let valueFrom = -1;
    const finish = (to: number) => {
        if (key !== undefined && valueFrom >= 0) {
            const raw = s.source.slice(valueFrom, to).trim();
            entries.set(key, raw.startsWith('"') || raw.startsWith("'") ? stringValue(raw) : raw);
        }
        key = undefined;
        valueFrom = -1;
    };
    let expectKey = true;
    while (s.nextSignificant() !== "eof") {
        if (s.is("}")) {
            finish(s.start);
            return entries;
        }
        if (s.is(",")) {
            finish(s.start);
            expectKey = true;
            continue;
        }
        if (expectKey && s.kind === "string") {
            key = stringValue(s.text());
            expectKey = false;
            continue;
        }
        if (key !== undefined && valueFrom < 0 && s.is(":")) {
            valueFrom = s.end;
            continue;
        }
        if (s.is("{") || s.is("(") || s.is("[")) s.skipBalanced();
    }
    finish(s.source.length);
    return entries;
}

/** The parameters a feature precondition block (`{` ... `}` at `range`) declares. */
export function preconditionFields(source: string, range: { from: number; to: number }): FeatureField[] {
    const s = new FsScanner(source, range.from, range.to);
    const fields: FeatureField[] = [];
    const seen = new Set<string>();
    let label: string | undefined;
    // A sliding window of the last significant tokens: enough to match `definition . x is T`.
    const window: { kind: string; text: string; from: number; to: number }[] = [];
    const push = (field: FeatureField) => {
        if (seen.has(field.name)) return;
        seen.add(field.name);
        fields.push(field);
        label = undefined;
    };
    while (s.nextSignificant() !== "eof") {
        if (s.is("annotation")) {
            s.nextSignificant();
            if (s.is("{")) label = readMapEntries(s).get("Name");
            continue;
        }
        window.push({ kind: s.kind, text: s.text(), from: s.start, to: s.end });
        if (window.length > 6) window.shift();
        const n = window.length;
        // definition . name is Type
        if (n >= 4 && window[n - 1].kind === "ident" && window[n - 2].text === "is") {
            const name = window[n - 3];
            if (
                window[n - 4]?.text === "." &&
                window[n - 5]?.text === "definition" &&
                name.kind === "ident"
            ) {
                push({ name: name.text, type: window[n - 1].text, label, from: name.from, to: name.to });
            }
        }
        // isLength ( definition . name [, BOUNDS]
        if (n >= 5 && window[n - 1].kind === "ident" && window[n - 2].text === ".") {
            const predicate = window[n - 5];
            if (
                window[n - 3].text === "definition" &&
                window[n - 4].text === "(" &&
                predicate.kind === "ident" &&
                QUANTITY_PREDICATES[predicate.text] !== undefined
            ) {
                const name = window[n - 1];
                let bounds: string | undefined;
                const saved = { pos: s.pos, kind: s.kind, start: s.start, end: s.end };
                s.nextSignificant();
                if (s.is(",")) {
                    s.nextSignificant();
                    if (s.kind === "ident") bounds = s.text();
                }
                s.pos = saved.pos;
                s.kind = saved.kind;
                s.start = saved.start;
                s.end = saved.end;
                push({
                    name: name.text,
                    type: QUANTITY_PREDICATES[predicate.text],
                    label,
                    bounds,
                    from: name.from,
                    to: name.to,
                });
            }
        }
    }
    return fields;
}

/** Every top-level declaration of a module (imports included), in source order. */
export function scanDeclarations(source: string): Declaration[] {
    return new DeclarationReader(source).read();
}

/** 1-based line of an offset. */
export function lineOf(source: string, offset: number): number {
    let line = 1;
    let index = source.indexOf("\n");
    while (index >= 0 && index < offset) {
        line++;
        index = source.indexOf("\n", index + 1);
    }
    return line;
}

/** How a declaration reads in a list: `opExtrude(context is Context, id is Id, definition is map)`. */
export function formatSignature(name: string, signature: Signature | undefined): string {
    if (signature === undefined) return name;
    const params = signature.params.map((param) =>
        param.type ? `${param.name} is ${param.type}` : param.name,
    );
    const returns = signature.returns ? ` returns ${signature.returns}` : "";
    return `${name}(${params.join(", ")})${returns}`;
}
