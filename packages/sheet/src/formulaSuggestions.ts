// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FORMULA_FUNCTIONS } from "./formula";
import { FUNCTION_INFO } from "./functionInfo";

export interface FormulaCompletion {
    start: number;
    end: number;
    names: readonly string[];
    ranges?: readonly string[];
}

/** Masks strings and quoted sheet names without shifting cursor positions. */
function context(text: string, cursor: number): { code: string; quoted: boolean } {
    let quote = "";
    let code = "";
    for (let i = 0; i < cursor; i++) {
        const c = text[i];
        if (quote) {
            code += " ";
            if (c === quote) {
                if (text[i + 1] === quote && i + 1 < cursor) {
                    code += " ";
                    i++;
                } else quote = "";
            }
        } else if (c === '"' || c === "'") {
            quote = c;
            code += " ";
        } else code += c;
    }
    return { code, quoted: quote !== "" };
}

export function formulaCompletion(
    text: string,
    cursor = text.length,
    ranges: readonly string[] = [],
): FormulaCompletion | undefined {
    if (!text.startsWith("=")) return undefined;
    const { code, quoted } = context(text, cursor);
    if (quoted) return undefined;
    const match = /(?:^|[=+\-*/^&<>,;(\s])([A-Za-z_][A-Za-z_0-9.]*)$/.exec(code);
    if (!match) return undefined;
    const prefix = match[1].toUpperCase();
    let end = cursor;
    while (/[A-Za-z_0-9.]/.test(text[end] ?? "") && end < text.length) end++;
    // Don't offer functions for sheet names or a cell reference like ABS12.
    if (/[!\d]/.test(text[end] ?? "")) return undefined;
    const names = [...FORMULA_FUNCTIONS, ...ranges].filter((name) => name.toUpperCase().startsWith(prefix));
    return names.length ? { start: cursor - prefix.length, end, names, ranges } : undefined;
}

export function acceptFormulaCompletion(
    text: string,
    completion: FormulaCompletion,
    name: string,
): { text: string; cursor: number } {
    const suffix = text.slice(completion.end);
    const existing = /^\s*\(/.exec(suffix);
    const insertion = name + (existing || completion.ranges?.includes(name) ? "" : "(");
    return {
        text: text.slice(0, completion.start) + insertion + suffix,
        cursor: completion.start + insertion.length + (existing?.[0].length ?? 0),
    };
}

export function formulaArgumentHelp(
    text: string,
    cursor = text.length,
): { name: string; argument: number } | undefined {
    if (!text.startsWith("=")) return undefined;
    const { code } = context(text, cursor);
    const stack: { name: string; argument: number }[] = [];
    for (let i = 0; i < code.length; i++) {
        if (code[i] === "(")
            stack.push({
                name: /([A-Za-z_][\w.]*)\s*$/.exec(code.slice(0, i))?.[1].toUpperCase() ?? "",
                argument: 0,
            });
        else if (code[i] === ")") stack.pop();
        else if ((code[i] === "," || code[i] === ";") && stack.length) stack[stack.length - 1].argument++;
    }
    return [...stack].reverse().find((call) => FUNCTION_INFO[call.name]);
}

/**
 * Inserts a function call at the cursor, as the function browser does: a partially typed
 * function name before the cursor is replaced, an existing "(" after it is reused, and
 * otherwise the call is written balanced — `NAME()` with the cursor inside, or after it for
 * a function without arguments — so the formula stays valid. `wrapRest` makes the text
 * after the cursor the first argument (`=12` → `=ROUND(12)`, cursor before the ")").
 */
export function insertFunctionCall(
    text: string,
    cursor: number,
    name: string,
    options: { names?: readonly string[]; zeroArgs?: boolean; wrapRest?: boolean } = {},
): { text: string; cursor: number } {
    let start = cursor;
    let end = cursor;
    const { code, quoted } = context(text, cursor);
    const partial = quoted ? undefined : /(?:^|[=+\-*/^&<>,;(\s])([A-Za-z_][A-Za-z_0-9.]*)$/.exec(code)?.[1];
    if (partial && (options.names ?? [name]).some((n) => n.startsWith(partial.toUpperCase()))) {
        let after = cursor;
        while (/[A-Za-z_0-9.]/.test(text[after] ?? "") && after < text.length) after++;
        if (text[after] !== "!") {
            start = cursor - partial.length;
            end = after;
        }
    }
    const head = text.slice(0, start);
    const rest = text.slice(end);
    if (options.zeroArgs) {
        const tail = options.wrapRest ? "" : rest.replace(/^\s*\(\s*\)/, "");
        return { text: `${head}${name}()${tail}`, cursor: head.length + name.length + 2 };
    }
    if (options.wrapRest) {
        return { text: `${head}${name}(${rest})`, cursor: head.length + name.length + 1 + rest.length };
    }
    const paren = /^\s*\(/.exec(rest);
    if (paren) return { text: head + name + rest, cursor: head.length + name.length + paren[0].length };
    const closed = rest.trim() === "" || /^\s*[,;)+\-*/^&<>=%]/.test(rest);
    return {
        text: `${head}${name}(${closed ? ")" : ""}${rest}`,
        cursor: head.length + name.length + 1,
    };
}
