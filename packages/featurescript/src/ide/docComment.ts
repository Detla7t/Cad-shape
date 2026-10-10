// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Std's documentation comments (`/** ... *\/` above a declaration) in structured form:
 * the summary, `@param` (with a definition map's `@field`s inside `{{ ... }}`),
 * `@return`, `@example`, an enum's `@value`s, `@seealso` and `@internal`. Text stays in
 * std's markdown-lite (backticks, `[links]`); `docView` renders it.
 */

export interface DocField {
    readonly name: string;
    readonly type?: string;
    text: string;
    optional: boolean;
    requiredIf?: string;
    readonly examples: string[];
}

export interface DocParam {
    readonly name: string;
    readonly type?: string;
    text: string;
    autocomplete?: string;
    optional: boolean;
    readonly fields: DocField[];
}

export interface ParsedDoc {
    summary: string;
    readonly params: DocParam[];
    returns?: { readonly type?: string; text: string };
    readonly examples: string[];
    /** Enum member → its `@value` text. */
    readonly values: Map<string, string>;
    readonly seeAlso: string[];
    readonly throws: string[];
    internal: boolean;
}

/** The comment's lines without the `/**`, `*\/` and leading ` * ` decoration. */
function cleanLines(raw: string): string[] {
    let body = raw.trim();
    if (body.startsWith("/**")) body = body.slice(3);
    else if (body.startsWith("/*")) body = body.slice(2);
    if (body.endsWith("*/")) body = body.slice(0, -2);
    return body.split("\n").map((line) => line.replace(/^\s*\*(?!\/) ?/, "").replace(/\s+$/, ""));
}

/** Appends a continuation line: blank lines become paragraph breaks. */
function append(text: string, line: string): string {
    if (line.trim() === "") return text === "" || text.endsWith("\n\n") ? text : `${text}\n\n`;
    if (text === "" || text.endsWith("\n")) return text + line.trim();
    // Keep fenced code and list items on their own lines.
    if (/^\s*(```|[-*] |\d+\. )/.test(line) || text.endsWith("```")) return `${text}\n${line.trim()}`;
    return `${text} ${line.trim()}`;
}

const TYPE = String.raw`\{([^{}]*)\}`;
const PARAM = new RegExp(String.raw`^(\w+)\s*(?:${TYPE})?\s*(\{\{)?\s*:?\s*(.*)$`);
const FIELD = new RegExp(String.raw`^(\w+)\s*(?:${TYPE})?\s*:?\s*(.*)$`);
const RETURN = new RegExp(String.raw`^(?:${TYPE})?\s*:?\s*(.*)$`);

/** Pulls inline markers (`@optional`, `@requiredif {...}`, `@autocomplete ...`, `@eg ...`) out of field text. */
function absorbFieldMarkers(field: DocField, text: string): string {
    let rest = text;
    rest = rest.replace(/@optional\b\s*/g, () => {
        field.optional = true;
        return "";
    });
    rest = rest.replace(/@required[iI]f\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*/g, (_, condition: string) => {
        field.requiredIf = condition.trim();
        return "";
    });
    rest = rest.replace(/@autocomplete\s*(`[^`]*`)\s*/g, (_, example: string) => {
        field.examples.push(example);
        return "";
    });
    const eg = /@(?:eg|ex)\b\s*(.*)$/.exec(rest);
    if (eg !== null) {
        if (eg[1].trim() !== "") field.examples.push(eg[1].trim());
        rest = rest.slice(0, eg.index);
    }
    return rest.trim();
}

function absorbParamMarkers(param: DocParam, text: string): string {
    return text
        .replace(/@autocomplete\s*(`[^`]*`)\s*/g, (_, example: string) => {
            param.autocomplete = example;
            return "";
        })
        .replace(/\s*@optional\b\s*/g, () => {
            param.optional = true;
            return " ";
        })
        .trim();
}

type Section =
    | { readonly kind: "summary" }
    | { readonly kind: "param"; readonly param: DocParam }
    | { readonly kind: "field"; readonly field: DocField }
    | { readonly kind: "returns" }
    | { readonly kind: "example" }
    | { readonly kind: "value"; readonly name: string }
    | { readonly kind: "list"; readonly list: string[] }
    | { readonly kind: "ignored" };

export function parseDocComment(raw: string): ParsedDoc {
    const doc: ParsedDoc = {
        summary: "",
        params: [],
        examples: [],
        values: new Map(),
        seeAlso: [],
        throws: [],
        internal: false,
    };
    let section: Section = { kind: "summary" };
    /** The `@param x {{ ... }}` whose fields are being read. */
    let fieldsOf: DocParam | undefined;
    let inFence = false;

    const appendTo = (line: string) => {
        switch (section.kind) {
            case "summary":
                doc.summary = append(doc.summary, line);
                break;
            case "param":
                section.param.text = append(section.param.text, absorbParamMarkers(section.param, line));
                break;
            case "field": {
                const field = section.field;
                field.text = append(field.text, absorbFieldMarkers(field, line));
                break;
            }
            case "returns":
                if (doc.returns !== undefined) doc.returns.text = append(doc.returns.text, line);
                break;
            case "example":
                doc.examples[doc.examples.length - 1] = append(doc.examples[doc.examples.length - 1], line);
                break;
            case "value":
                doc.values.set(section.name, append(doc.values.get(section.name) ?? "", line));
                break;
            case "list":
                section.list[section.list.length - 1] = append(section.list[section.list.length - 1], line);
                break;
            case "ignored":
                break;
        }
    };

    for (const line of cleanLines(raw)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) inFence = !inFence;
        if (fieldsOf !== undefined && trimmed.startsWith("}}")) {
            fieldsOf = undefined;
            section = { kind: "ignored" };
            continue;
        }
        const tag = inFence ? null : /^@(\w+)\b\s*(.*)$/.exec(trimmed);
        if (tag === null) {
            appendTo(line);
            continue;
        }
        const [, name, rest] = tag;
        switch (name) {
            case "param": {
                const match = PARAM.exec(rest);
                if (match === null) break;
                const param: DocParam = {
                    name: match[1],
                    type: match[2]?.trim(),
                    text: "",
                    optional: false,
                    fields: [],
                };
                param.text = absorbParamMarkers(param, match[4] ?? "");
                doc.params.push(param);
                fieldsOf = match[3] !== undefined ? param : undefined;
                section = { kind: "param", param };
                break;
            }
            case "field": {
                const match = FIELD.exec(rest);
                if (match === null) break;
                const field: DocField = {
                    name: match[1],
                    type: match[2]?.trim(),
                    text: "",
                    optional: false,
                    examples: [],
                };
                field.text = absorbFieldMarkers(field, match[3] ?? "");
                (fieldsOf ?? doc.params[doc.params.length - 1])?.fields.push(field);
                section = { kind: "field", field };
                break;
            }
            case "eg":
            case "ex":
            case "optional":
            case "requiredif":
            case "requiredIf":
            case "autocomplete":
                if (section.kind === "field") {
                    const field = section.field;
                    field.text = append(field.text, absorbFieldMarkers(field, trimmed));
                } else if (section.kind === "param" && name === "autocomplete") {
                    section.param.autocomplete = rest.trim();
                } else {
                    appendTo(trimmed);
                }
                break;
            case "return":
            case "returns": {
                const match = RETURN.exec(rest);
                doc.returns = { type: match?.[1]?.trim(), text: (match?.[2] ?? rest).trim() };
                section = { kind: "returns" };
                break;
            }
            case "example":
                doc.examples.push(rest.trim());
                section = { kind: "example" };
                break;
            case "value": {
                const match = /^(\w+)\s*:?\s*(.*)$/.exec(rest);
                if (match === null) break;
                doc.values.set(match[1], match[2].trim());
                section = { kind: "value", name: match[1] };
                break;
            }
            case "seealso":
            case "seeAlso":
                doc.seeAlso.push(rest.trim());
                section = { kind: "list", list: doc.seeAlso };
                break;
            case "throws":
                doc.throws.push(rest.trim());
                section = { kind: "list", list: doc.throws };
                break;
            case "internal":
                doc.internal = true;
                if (rest.trim() !== "") appendTo(rest);
                break;
            default:
                // `@type`, `@default`, ... — keep the text in whatever section is open.
                appendTo(rest);
                break;
        }
    }
    doc.summary = doc.summary.trim();
    for (const param of doc.params) {
        param.text = param.text.trim();
        for (const field of param.fields) field.text = field.text.trim();
    }
    if (doc.returns !== undefined) doc.returns.text = doc.returns.text.trim();
    for (const list of [doc.examples, doc.seeAlso, doc.throws]) {
        for (let i = 0; i < list.length; i++) list[i] = list[i].trim();
    }
    for (const [name, text] of doc.values) doc.values.set(name, text.trim());
    return doc;
}

/** The first sentence of the summary, for completion details. */
export function docSummaryLine(doc: ParsedDoc | undefined): string {
    if (doc === undefined) return "";
    const paragraph = doc.summary.split("\n\n")[0] ?? "";
    const sentence = /^(.*?[.!?])(\s|$)/.exec(paragraph)?.[1] ?? paragraph;
    return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}
