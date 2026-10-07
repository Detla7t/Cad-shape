// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KEYWORDS } from "../../lang/lexer";
import {
    declarationAt,
    featureAt,
    inCode,
    inPrecondition,
    localsAt,
    mapKeyAt,
    memberBefore,
    previousSignificant,
} from "./analysis";
import { type Declaration, type FeatureField, formatSignature } from "./declarations";
import { type DocField, docSummaryLine } from "./docComment";
import {
    BUILTIN_TYPES,
    isClosedString,
    type ScanToken,
    tokenIndexAt,
    tokenIndexBefore,
    UNIT_NAMES,
} from "./scanner";
import { STD_PREFIX } from "./stdIndex";
import type { SymbolInfo, SymbolTable } from "./symbols";

/**
 * Completion for a position in a studio, as plain data (the CodeMirror adapter turns it
 * into options): keywords, names in scope (locals, the studio's declarations, imported
 * studios, std), enum members after `Enum.`, a feature's parameters after `definition.`,
 * types after `is`/`returns`/`as`, annotation keys and a call's definition-map fields in
 * map keys, import paths, and snippets for the common shapes of a studio.
 */

export type CompletionKind =
    | "keyword"
    | "function"
    | "feature"
    | "predicate"
    | "const"
    | "type"
    | "enum"
    | "enumMember"
    | "variable"
    | "parameter"
    | "property"
    | "annotationKey"
    | "snippet"
    | "module"
    | "unit";

export interface CompletionItem {
    readonly label: string;
    readonly kind: CompletionKind;
    readonly detail?: string;
    /** Markdown-lite documentation shown beside the list. */
    readonly info?: string;
    /** The symbol, when the item names one (its docs render as the info). */
    readonly symbol?: SymbolInfo;
    /** A snippet template (`${name}` fields, tabs for indentation) inserted instead of the label. */
    readonly snippet?: string;
    readonly boost?: number;
}

export interface CompletionResult {
    readonly from: number;
    readonly to: number;
    readonly items: readonly CompletionItem[];
    /** Typing more of what matches keeps the list open without asking again. */
    readonly validFor: RegExp;
}

export interface CompletionRequest {
    readonly source: string;
    readonly tokens: readonly ScanToken[];
    readonly declarations: readonly Declaration[];
    readonly table: SymbolTable;
    readonly pos: number;
    /** Ctrl+Space rather than typing. */
    readonly explicit: boolean;
    /** Other studios of the document, offered as import paths. */
    readonly studioNames?: readonly string[];
    /** Std module files, offered as import paths. */
    readonly stdModules?: readonly string[];
}

const WORD = /^\w*$/;
const KEY = /^[\w #-]*$/;

export const ANNOTATION_KEYS: readonly { readonly key: string; readonly info: string }[] = [
    { key: "Name", info: "The label of a parameter (or of an enum value) in the feature dialog." },
    {
        key: "Feature Type Name",
        info: "The name of a custom feature, as the feature list and dialog show it.",
    },
    { key: "Feature Type Description", info: "A description of the feature, shown in its tooltip." },
    { key: "Feature Name Template", info: 'The instance name template, e.g. `"#length Slot"`.' },
    {
        key: "UIHint",
        info: "Display hints: `UIHint.REMEMBER_PREVIOUS_VALUE`, `UIHint.OPPOSITE_DIRECTION`, ...",
    },
    { key: "Default", info: "The default of a boolean, enum, string or count parameter." },
    { key: "Filter", info: "What a query parameter accepts, e.g. `EntityType.FACE && GeometryType.PLANE`." },
    { key: "MaxNumberOfPicks", info: "How many entities a query parameter takes." },
    { key: "Description", info: "A tooltip for the parameter." },
    { key: "Group Name", info: "Groups the following parameters under a collapsible heading." },
    { key: "Collapsed By Default", info: "Whether a parameter group starts collapsed." },
    { key: "Driving Parameter", info: "The boolean parameter that shows or hides a group." },
    { key: "AdditionalBoxSelectFilter", info: "An extra filter for box selection of a query parameter." },
    { key: "Item name", info: "The name of one item of an array parameter." },
    { key: "Item label template", info: 'The label of each array item, e.g. `"#size"`.' },
    { key: "Show labels only", info: "Shows only the array items' labels." },
    { key: "Hidden", info: "Hides the parameter (or enum value) from the dialog." },
    { key: "MaxLength", info: "The maximum length of a string parameter." },
    { key: "Lookup Table", info: "A lookup table parameter's table." },
    { key: "Editing Logic Function", info: "A function run when the dialog's parameters change." },
    { key: "Manipulator Change Function", info: "A function run when a manipulator is dragged." },
    { key: "Filter Selector", info: "Selection filter presets for the feature." },
    { key: "Icon", info: "The feature's icon (an imported image)." },
    { key: "Description Image", info: "An image shown in the feature's tooltip." },
    { key: "Tooltip Template", info: "Template for the feature's tooltip." },
    { key: "Deprecated", info: "Marks the parameter as deprecated." },
];

export const SNIPPETS: readonly {
    readonly label: string;
    readonly detail: string;
    readonly template: string;
    readonly where: "top" | "precondition" | "code" | "any";
}[] = [
    {
        label: "feature",
        detail: "new custom feature",
        where: "top",
        template: [
            'annotation { "Feature Type Name" : "#{My Feature}" }',
            "export const #{myFeature} = defineFeature(function(context is Context, id is Id, definition is map)",
            "\tprecondition",
            "\t{",
            '\t\tannotation { "Name" : "#{Length}" }',
            "\t\tisLength(definition.#{length}, LENGTH_BOUNDS);",
            "\t}",
            "\t{",
            "\t\t#{}",
            "\t});",
        ].join("\n"),
    },
    {
        label: "function",
        detail: "exported function",
        where: "top",
        template: "export function #{name}(context is Context, #{arg}) returns #{map}\n{\n\t#{}\n}",
    },
    {
        label: "import geometry",
        detail: "import std's geometry.fs",
        where: "top",
        template: 'import(path : "onshape/std/geometry.fs", version : "#{version}");',
    },
    {
        label: "enum",
        detail: "exported enum",
        where: "top",
        template:
            'export enum #{MyEnum}\n{\n\tannotation { "Name" : "#{First}" }\n\t#{FIRST},\n\tannotation { "Name" : "#{Second}" }\n\t#{SECOND}\n}',
    },
    {
        label: "length parameter",
        detail: "isLength(definition.x, LENGTH_BOUNDS)",
        where: "precondition",
        template: 'annotation { "Name" : "#{Length}" }\nisLength(definition.#{length}, #{LENGTH_BOUNDS});',
    },
    {
        label: "angle parameter",
        detail: "isAngle(definition.x, ANGLE_360_BOUNDS)",
        where: "precondition",
        template: 'annotation { "Name" : "#{Angle}" }\nisAngle(definition.#{angle}, #{ANGLE_360_BOUNDS});',
    },
    {
        label: "count parameter",
        detail: "isInteger(definition.x, POSITIVE_COUNT_BOUNDS)",
        where: "precondition",
        template:
            'annotation { "Name" : "#{Count}" }\nisInteger(definition.#{count}, #{POSITIVE_COUNT_BOUNDS});',
    },
    {
        label: "real parameter",
        detail: "isReal(definition.x, POSITIVE_REAL_BOUNDS)",
        where: "precondition",
        template: 'annotation { "Name" : "#{Value}" }\nisReal(definition.#{value}, #{POSITIVE_REAL_BOUNDS});',
    },
    {
        label: "boolean parameter",
        detail: "definition.x is boolean",
        where: "precondition",
        template: 'annotation { "Name" : "#{Flip}", "Default" : #{false} }\ndefinition.#{flip} is boolean;',
    },
    {
        label: "query parameter",
        detail: "definition.x is Query, with a Filter",
        where: "precondition",
        template:
            'annotation { "Name" : "#{Faces}", "Filter" : #{EntityType.FACE}, "MaxNumberOfPicks" : #{1} }\ndefinition.#{faces} is Query;',
    },
    {
        label: "enum parameter",
        detail: "definition.x is SomeEnum",
        where: "precondition",
        template: 'annotation { "Name" : "#{Type}" }\ndefinition.#{type} is #{BoundingType};',
    },
    {
        label: "string parameter",
        detail: "definition.x is string",
        where: "precondition",
        template: 'annotation { "Name" : "#{Label}" }\ndefinition.#{label} is string;',
    },
    {
        label: "for",
        detail: "counted loop",
        where: "code",
        template: "for (var #{i} = 0; #{i} < #{count}; #{i} += 1)\n{\n\t#{}\n}",
    },
    {
        label: "for in",
        detail: "loop over an array",
        where: "code",
        template: "for (var #{item} in #{items})\n{\n\t#{}\n}",
    },
    { label: "while", detail: "while loop", where: "code", template: "while (#{condition})\n{\n\t#{}\n}" },
    { label: "if", detail: "if statement", where: "code", template: "if (#{condition})\n{\n\t#{}\n}" },
    {
        label: "if else",
        detail: "if / else",
        where: "code",
        template: "if (#{condition})\n{\n\t#{}\n}\nelse\n{\n\t#{}\n}",
    },
    {
        label: "try catch",
        detail: "try / catch",
        where: "code",
        template: "try\n{\n\t#{}\n}\ncatch (#{error})\n{\n\t#{}\n}",
    },
    {
        label: "println",
        detail: "print a value to the output",
        where: "code",
        template: "println(#{value});",
    },
];

function kindOf(symbol: SymbolInfo): CompletionKind {
    switch (symbol.kind) {
        case "feature":
            return "feature";
        case "function":
        case "operator":
            return "function";
        case "predicate":
            return "predicate";
        case "type":
            return "type";
        case "enum":
            return "enum";
        default:
            return UNIT_NAMES.has(symbol.name) ? "unit" : "const";
    }
}

function originBoost(symbol: SymbolInfo, table: SymbolTable): number {
    if (symbol.origin.kind === "local") return 2;
    if (symbol.origin.kind === "studio") return 1;
    return table.doc(symbol)?.internal ? -2 : 0;
}

/** The short detail of a symbol: its parameters, type or kind. */
export function symbolDetail(symbol: SymbolInfo): string {
    const declaration = symbol.declarations[0];
    const overloads = symbol.declarations.length > 1 ? ` +${symbol.declarations.length - 1}` : "";
    const where =
        symbol.origin.kind === "studio"
            ? ` · ${symbol.origin.studioName}`
            : symbol.origin.kind === "std"
              ? ""
              : "";
    switch (symbol.kind) {
        case "feature":
            return `feature ${declaration.annotation?.get("Feature Type Name") ?? ""}`.trim() + where;
        case "function":
        case "predicate":
        case "operator": {
            const params = declaration.signature?.params.map((param) => param.name).join(", ") ?? "";
            const returns = declaration.signature?.returns ? ` → ${declaration.signature.returns}` : "";
            return `(${params})${returns}${overloads}${where}`;
        }
        case "type":
            return `type${where}`;
        case "enum":
            return `enum${where}`;
        default:
            return (declaration.type ?? "const") + where;
    }
}

function symbolItem(symbol: SymbolInfo, table: SymbolTable): CompletionItem {
    return {
        label: symbol.name,
        kind: kindOf(symbol),
        detail: symbolDetail(symbol),
        symbol,
        boost: originBoost(symbol, table),
    };
}

/** A call template for a std op/feature: `opExtrude(context, id + "extrude1", { required fields })`. */
function callTemplate(symbol: SymbolInfo, table: SymbolTable): CompletionItem | undefined {
    if (symbol.origin.kind !== "std" || (symbol.kind !== "function" && symbol.kind !== "feature"))
        return undefined;
    const declaration = symbol.declarations.find((d) => d.signature?.params.length === 3);
    const params = declaration?.signature?.params;
    if (params === undefined || params[0].type !== "Context" || params[1].type !== "Id") return undefined;
    const doc = table.doc(symbol);
    const definition = doc?.params.find((param) => param.name === params[2].name);
    if (definition === undefined || definition.fields.length === 0) return undefined;
    const required = definition.fields.filter((field) => !field.optional && field.requiredIf === undefined);
    const fields = (required.length > 0 ? required : definition.fields.slice(0, 1)).map(
        (field) => `\t"${field.name}" : #{${field.name}}`,
    );
    const suffix = /`id \+ "([^"]+)"`/.exec(
        doc?.params.find((p) => p.name === params[1].name)?.autocomplete ?? "",
    )?.[1];
    const idSuffix = suffix ?? `${symbol.name}1`;
    return {
        label: `${symbol.name}(…)`,
        kind: "snippet",
        detail: "call with its definition map",
        symbol,
        snippet: `${symbol.name}(context, id + "#{${idSuffix}}", {\n${fields.join(",\n")}\n});`,
        boost: -3,
    };
}

/** Keeps lists in declaration order (CodeMirror sorts equal matches by boost, then by label). */
function orderBoost(index: number, base = 40): number {
    return Math.max(-99, base - index);
}

function fieldItem(field: FeatureField, index = 0): CompletionItem {
    const type = field.type ? ` ${field.type}` : "";
    const bounds = field.bounds ? ` · ${field.bounds}` : "";
    return {
        label: field.name,
        kind: "property",
        detail: `${field.label ? `"${field.label}"` : ""}${type}${bounds}`.trim(),
        boost: orderBoost(index),
    };
}

function docFieldItem(field: DocField, index = 0): CompletionItem {
    const flags = field.optional ? "optional" : field.requiredIf !== undefined ? "required if…" : "";
    const examples = field.examples.length > 0 ? `\n\ne.g. ${field.examples.join(", ")}` : "";
    const requiredIf = field.requiredIf !== undefined ? `\n\nRequired if ${field.requiredIf}` : "";
    return {
        label: field.name,
        kind: "property",
        detail: [field.type, flags].filter((part) => part !== undefined && part !== "").join(" · "),
        info: `${field.text}${requiredIf}${examples}`.trim(),
        boost: orderBoost(index, field.optional ? 0 : 40),
    };
}

/** The definition-map fields a call's argument `argument` takes (std doc `@field`s, or a feature's precondition). */
export function callFields(
    table: SymbolTable,
    callee: string,
    argument: number,
    namespace?: string,
): { doc?: readonly DocField[]; precondition?: readonly FeatureField[] } | undefined {
    const symbol = table.lookup(callee, namespace);
    if (symbol === undefined) return undefined;
    if (symbol.kind === "feature" && symbol.origin.kind !== "std") {
        const fields = symbol.declarations[0].fields;
        if (argument === 2 && fields !== undefined) return { precondition: fields };
    }
    const doc = table.doc(symbol);
    if (doc === undefined) return undefined;
    const declaration =
        symbol.declarations.find((d) => (d.signature?.params.length ?? 0) > argument) ??
        symbol.declarations[0];
    const paramName = declaration.signature?.params[argument]?.name;
    const param = doc.params.find((p) => p.name === paramName) ?? doc.params[argument];
    if (param === undefined || param.fields.length === 0) {
        if (symbol.kind === "feature") {
            const fields = symbol.declarations[0].fields;
            if (argument === 2 && fields !== undefined && fields.length > 0) return { precondition: fields };
        }
        return undefined;
    }
    return { doc: param.fields };
}

function stringCompletions(request: CompletionRequest, index: number): CompletionResult | null {
    const { tokens, table } = request;
    const token = tokens[index];
    const from = token.from + 1;
    const to = isClosedString(token.text) ? token.to - 1 : token.to;
    if (request.pos < from || request.pos > to) return null;

    // import(path : "|")
    const before = previousSignificant(tokens, index);
    const keyToken = tokens[previousSignificant(tokens, before)];
    if (tokens[before]?.text === ":" && keyToken?.text === "path") {
        const items: CompletionItem[] = [
            ...(request.studioNames ?? []).map((name) => ({
                label: name,
                kind: "module" as const,
                detail: "Feature Studio",
                boost: 1,
            })),
            ...(request.stdModules ?? []).map((file) => ({
                label: `${STD_PREFIX}${file}`,
                kind: "module" as const,
                detail: "std",
                boost: file === "geometry.fs" ? 2 : 0,
            })),
        ];
        return { from, to, items, validFor: /^[\w./ -]*$/ };
    }

    const map = mapKeyAt(tokens, index);
    if (map === undefined) return null;
    if (map.annotation) {
        return {
            from,
            to,
            items: ANNOTATION_KEYS.map(({ key, info }) => ({ label: key, kind: "annotationKey", info })),
            validFor: KEY,
        };
    }
    if (map.call === undefined) return null;
    const fields = callFields(table, map.call.callee, map.call.argument, map.call.namespace);
    if (fields === undefined) return null;
    const items =
        fields.doc?.map((field, index) => docFieldItem(field, index)) ??
        fields.precondition?.map((field, index) => fieldItem(field, index)) ??
        [];
    return { from, to, items, validFor: KEY };
}

function typeItems(table: SymbolTable): CompletionItem[] {
    const items: CompletionItem[] = BUILTIN_TYPES.map((name) => ({
        label: name,
        kind: "type",
        detail: "built-in",
        boost: 1,
    }));
    for (const symbol of table.symbols.values()) {
        if (symbol.kind === "type" || symbol.kind === "enum") items.push(symbolItem(symbol, table));
    }
    return items;
}

function memberItems(request: CompletionRequest, object: string): CompletionItem[] | undefined {
    const { table } = request;
    if (object === "definition") {
        const feature = featureAt(request.declarations, request.pos);
        if (feature?.fields !== undefined)
            return feature.fields.map((field, index) => fieldItem(field, index));
        return undefined;
    }
    const symbol = table.lookup(object);
    if (symbol?.kind !== "enum") return undefined;
    const declaration = symbol.declarations[0];
    const doc = table.doc(symbol);
    return (declaration.members ?? []).map((member, index) => ({
        label: member.name,
        kind: "enumMember" as const,
        detail: member.label !== undefined ? `"${member.label}"` : object,
        info: doc?.values.get(member.name),
        boost: orderBoost(index),
    }));
}

function snippetItems(request: CompletionRequest): CompletionItem[] {
    const top = !inCode(request.tokens, request.pos);
    const precondition = inPrecondition(request.declarations, request.pos);
    return SNIPPETS.filter((snippet) => {
        if (snippet.where === "any") return true;
        if (snippet.where === "top") return top;
        if (snippet.where === "precondition") return precondition;
        return !top;
    }).map((snippet) => ({
        label: snippet.label,
        kind: "snippet" as const,
        detail: snippet.detail,
        snippet: snippet.template,
        boost: -1,
    }));
}

/** Completions at `request.pos`, or null where nothing applies (a comment, a plain string, ...). */
export function completeAt(request: CompletionRequest): CompletionResult | null {
    const { tokens, pos, table } = request;
    const index = tokenIndexAt(tokens, pos);
    const token = tokens[index];
    if (token !== undefined && token.from < pos) {
        if (token.kind === "comment" || token.kind === "doc") {
            const open = token.text.startsWith("//") || !token.text.endsWith("*/") || pos < token.to;
            if (open) return null;
        }
        if (token.kind === "string") return stringCompletions(request, index);
        if (token.kind === "number") return null;
    }
    const isWord =
        token !== undefined &&
        (token.kind === "ident" || token.kind === "keyword") &&
        token.from <= pos &&
        pos <= token.to;
    const from = isWord ? token.from : pos;
    const to = isWord ? token.to : pos;

    // `Enum.` / `definition.`
    const member = memberBefore(tokens, from);
    if (member !== undefined) {
        const items = memberItems(request, member.object);
        return items === undefined ? null : { from, to, items, validFor: WORD };
    }
    const before = tokens[tokenIndexBefore(tokens, from)];
    if (before !== undefined && (before.text === "." || before.text === "?.")) return null;

    // `Foo::`
    if (before?.text === "::") {
        const namespaceToken = tokens[previousSignificant(tokens, tokenIndexBefore(tokens, from))];
        const namespace = table.namespaces.get(namespaceToken?.text ?? "");
        if (namespace === undefined) return null;
        return {
            from,
            to,
            items: [...namespace.values()].map((symbol) => symbolItem(symbol, table)),
            validFor: WORD,
        };
    }

    // Types after `is`, `returns`, `as`, `typecheck`.
    if (before?.kind === "keyword" && ["is", "returns", "as", "typecheck"].includes(before.text)) {
        return { from, to, items: typeItems(table), validFor: WORD };
    }

    if (!isWord && !request.explicit) return null;
    // Declaring a name: nothing to complete.
    if (
        before?.kind === "keyword" &&
        ["var", "const", "function", "predicate", "enum", "type"].includes(before.text)
    ) {
        return null;
    }

    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    const declaration = declarationAt(request.declarations, pos);
    if (declaration !== undefined) {
        for (const local of localsAt(tokens, declaration, from)) {
            seen.add(local.name);
            items.push({
                label: local.name,
                kind: local.kind === "parameter" ? "parameter" : "variable",
                detail: local.type ?? local.kind,
                boost: 3,
            });
        }
    }
    for (const symbol of table.symbols.values()) {
        if (seen.has(symbol.name)) continue;
        items.push(symbolItem(symbol, table));
        const template = callTemplate(symbol, table);
        if (template !== undefined) items.push(template);
    }
    for (const keyword of KEYWORDS) {
        if (!seen.has(keyword)) items.push({ label: keyword, kind: "keyword", boost: -1 });
    }
    items.push(...snippetItems(request));
    return { from, to, items, validFor: WORD };
}

/** A one-line description of a symbol for lists: signature or kind plus the doc's first sentence. */
export function symbolSummary(symbol: SymbolInfo, table: SymbolTable): string {
    const declaration = symbol.declarations[0];
    const head =
        declaration.signature !== undefined
            ? formatSignature(symbol.name, declaration.signature)
            : symbol.name;
    const doc = docSummaryLine(table.doc(symbol));
    return doc === "" ? head : `${head} — ${doc}`;
}
