// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    callAt,
    declarationAt,
    featureAt,
    type LocalName,
    localsAt,
    mapKeyAt,
    memberBefore,
    previousSignificant,
    wordAt,
} from "./analysis";
import { ANNOTATION_KEYS, callFields } from "./completion";
import type { Declaration, EnumMemberInfo, FeatureField, Signature } from "./declarations";
import type { DocField, ParsedDoc } from "./docComment";
import { type ScanToken, stringValue, tokenIndexAt } from "./scanner";
import type { SymbolInfo, SymbolTable } from "./symbols";

/**
 * What the code at a position refers to — for hover docs and go-to-definition — and the
 * call signature around it, for signature help.
 */

export interface NavigationRequest {
    readonly tokens: readonly ScanToken[];
    readonly declarations: readonly Declaration[];
    readonly table: SymbolTable;
    readonly pos: number;
}

interface Span {
    readonly from: number;
    readonly to: number;
}

export type Target = Span &
    (
        | { readonly kind: "symbol"; readonly symbol: SymbolInfo }
        | { readonly kind: "local"; readonly local: LocalName }
        | {
              readonly kind: "enumMember";
              readonly symbol: SymbolInfo;
              readonly member: EnumMemberInfo;
              readonly text?: string;
          }
        | { readonly kind: "field"; readonly field: FeatureField; readonly feature: Declaration }
        | { readonly kind: "docField"; readonly field: DocField; readonly symbol: SymbolInfo }
        | { readonly kind: "annotationKey"; readonly key: string; readonly info: string }
    );

/** What the token at `pos` refers to, if anything known. */
export function targetAt(request: NavigationRequest): Target | undefined {
    const { tokens, table, pos } = request;
    const index = tokenIndexAt(tokens, pos);
    const token = tokens[index];
    if (token === undefined) return undefined;
    const span = { from: token.from, to: token.to };

    if (token.kind === "string") {
        const map = mapKeyAt(tokens, index);
        if (map === undefined) return undefined;
        const key = stringValue(token.text);
        if (map.annotation) {
            const known = ANNOTATION_KEYS.find((entry) => entry.key === key);
            return known === undefined
                ? undefined
                : { ...span, kind: "annotationKey", key, info: known.info };
        }
        if (map.call === undefined) return undefined;
        const fields = callFields(table, map.call.callee, map.call.argument, map.call.namespace);
        const docField = fields?.doc?.find((field) => field.name === key);
        const symbol = table.lookup(map.call.callee, map.call.namespace);
        if (docField !== undefined && symbol !== undefined)
            return { ...span, kind: "docField", field: docField, symbol };
        const field = fields?.precondition?.find((candidate) => candidate.name === key);
        if (field !== undefined && symbol !== undefined) {
            return { ...span, kind: "field", field, feature: symbol.declarations[0] };
        }
        return undefined;
    }

    const word = wordAt(tokens, pos);
    if (word === undefined || word.token.kind !== "ident") return undefined;
    const name = word.token.text;

    const member = memberBefore(tokens, word.token.from);
    if (member !== undefined) {
        if (member.object === "definition") {
            const feature = featureAt(request.declarations, pos);
            const field = feature?.fields?.find((candidate) => candidate.name === name);
            return field === undefined || feature === undefined
                ? undefined
                : { ...span, kind: "field", field, feature };
        }
        const symbol = table.lookup(member.object);
        const enumMember =
            symbol?.kind === "enum"
                ? symbol.declarations[0].members?.find((m) => m.name === name)
                : undefined;
        if (symbol === undefined || enumMember === undefined) return undefined;
        return {
            ...span,
            kind: "enumMember",
            symbol,
            member: enumMember,
            text: table.doc(symbol)?.values.get(name),
        };
    }

    // `Foo::name`
    const separator = previousSignificant(tokens, word.index);
    if (tokens[separator]?.text === "::") {
        const namespace = tokens[previousSignificant(tokens, separator)]?.text;
        const symbol = namespace === undefined ? undefined : table.lookup(name, namespace);
        return symbol === undefined ? undefined : { ...span, kind: "symbol", symbol };
    }

    const declaration = declarationAt(request.declarations, pos);
    if (declaration !== undefined) {
        const local = localsAt(tokens, declaration, word.token.to).find(
            (candidate) => candidate.name === name,
        );
        if (local !== undefined) return { ...span, kind: "local", local };
    }
    const symbol = table.lookup(name);
    return symbol === undefined ? undefined : { ...span, kind: "symbol", symbol };
}

export type DefinitionLocation =
    | { readonly kind: "local"; readonly from: number; readonly to: number }
    | {
          readonly kind: "studio";
          readonly studioId: string;
          readonly studioName: string;
          readonly from: number;
          readonly to: number;
      }
    | { readonly kind: "std"; readonly module: string; readonly from: number; readonly to: number };

function symbolLocation(
    symbol: SymbolInfo,
    declaration: Span = spanOf(symbol.declarations[0]),
): DefinitionLocation {
    const origin = symbol.origin;
    if (origin.kind === "studio")
        return { kind: "studio", studioId: origin.studioId, studioName: origin.studioName, ...declaration };
    if (origin.kind === "std") {
        const index = symbol.declarations.findIndex((d) => d.nameFrom === declaration.from);
        return { kind: "std", module: symbol.modules?.[Math.max(0, index)] ?? origin.module, ...declaration };
    }
    return { kind: "local", ...declaration };
}

function spanOf(declaration: Declaration): Span {
    return { from: declaration.nameFrom, to: declaration.nameTo };
}

/** Where the name at `pos` is declared. */
export function definitionAt(request: NavigationRequest): DefinitionLocation | undefined {
    const target = targetAt(request);
    if (target === undefined) return undefined;
    switch (target.kind) {
        case "local":
            return { kind: "local", from: target.local.from, to: target.local.to };
        case "symbol":
            return symbolLocation(target.symbol);
        case "enumMember":
            return symbolLocation(target.symbol, { from: target.member.from, to: target.member.to });
        case "field": {
            const feature = request.table.symbols.get(target.feature.name);
            const span = { from: target.field.from, to: target.field.to };
            return feature !== undefined && feature.declarations[0] === target.feature
                ? symbolLocation(feature, span)
                : { kind: "local", ...span };
        }
        case "docField":
            return symbolLocation(target.symbol);
        case "annotationKey":
            return undefined;
    }
}

export interface SignatureHelp {
    readonly symbol: SymbolInfo;
    readonly signatures: readonly Signature[];
    /** The overload that best fits the argument count so far. */
    readonly active: number;
    readonly argument: number;
    readonly doc?: ParsedDoc;
    /** Offset of the call's `(`. */
    readonly open: number;
}

/** The function being called around `pos`, with its overloads and the active argument. */
export function signatureAt(request: NavigationRequest): SignatureHelp | undefined {
    const { tokens, table } = request;
    const call = callAt(tokens, request.pos);
    if (call === undefined) return undefined;
    const symbol = table.lookup(call.callee, call.namespace);
    if (symbol === undefined) return undefined;
    const signatures = symbol.declarations.flatMap((d) => (d.signature === undefined ? [] : [d.signature]));
    if (signatures.length === 0) return undefined;
    const fits = signatures.findIndex((signature) => signature.params.length > call.argument);
    return {
        symbol,
        signatures,
        active: fits < 0 ? 0 : fits,
        argument: call.argument,
        doc: table.doc(symbol),
        open: tokens[call.open].from,
    };
}
