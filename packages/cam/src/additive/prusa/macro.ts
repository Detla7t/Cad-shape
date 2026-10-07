// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type PrusaConfig, parseStrings, unescapeString } from "./values";

/**
 * PrusaSlicer's custom G-code macro language, the part printer profiles use:
 *
 * - legacy placeholders `[first_layer_temperature]`, `[nozzle_diameter_0]` (an unknown name
 *   stays as literal text, so `[` in comments is harmless);
 * - `{expression}` with numbers, strings, booleans, vector indexing `name[0]`, arithmetic,
 *   comparisons, `and`/`or`/`not` (`&&`, `||`, `!`), regex match `=~ /…/` / `!~`, the ternary
 *   `c ? a : b`, and the functions `min`, `max`, `int`, `round`, `abs`, `digits`, `zdigits`,
 *   `is_nil`, `one_of`, `size`, `empty`;
 * - `{local name = …}` / `{global name = …}` assignments, `;`-separated statements;
 * - `{if …}…{elsif …}…{else}…{endif}` blocks, nested.
 *
 * Config values are read from their serialized text; a vector referenced without an index
 * gives the current extruder's (first) value, as the legacy syntax does.
 */

export type MacroValue = number | string | boolean | null | MacroValue[];

export interface MacroScope {
    /** A variable's value, or undefined when it does not exist. */
    lookup(name: string): MacroValue | undefined;
}

export interface MacroResult {
    readonly text: string;
    readonly errors: readonly string[];
}

/** Options whose text is a string (never split into a vector). */
const STRING_KEYS =
    /(_gcode|_notes|_settings_id|^printer_model|^printer_variant|^printer_vendor|^inherits|_condition|^output_filename_format|^post_process|^notes|^thumbnails|^bed_custom|^host_type|^gcode_flavor|^fill_pattern|^top_fill_pattern|^bottom_fill_pattern|^seam_position|^support_material_style|^support_material_pattern|^ironing_type|^infill_connection|^brim_type|^machine_limits_usage|^gcode_label_objects|^wall_generator|^perimeter_generator)$/;

/** Turns a serialized config value into a macro value. */
export function configMacroValue(key: string, text: string): MacroValue {
    if (STRING_KEYS.test(key)) return unescapeString(text);
    const trimmed = text.trim();
    if (trimmed === "nil") return null;
    if (trimmed.startsWith('"')) return parseStrings(trimmed);
    const parts = trimmed.split(",");
    const scalar = (part: string): MacroValue => {
        const p = part.trim();
        if (p === "nil") return null;
        if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(p)) return Number.parseFloat(p);
        if (p === "true") return true;
        if (p === "false") return false;
        return p;
    };
    if (parts.length > 1 && parts.every((p) => /^\s*([-+]?[\d.]+(e[-+]?\d+)?%?|nil|\d+x\d+)\s*$/i.test(p))) {
        return parts.map(scalar);
    }
    return scalar(trimmed);
}

/** A scope over a config plus extra variables (layer number, print bounds, …). */
export function prusaMacroScope(
    config: PrusaConfig,
    extra: Readonly<Record<string, MacroValue>> = {},
): MacroScope {
    const cache = new Map<string, MacroValue>();
    return {
        lookup(name: string) {
            if (name in extra) return extra[name];
            const cached = cache.get(name);
            if (cached !== undefined) return cached;
            const text = config[name];
            if (text === undefined) return undefined;
            const value = configMacroValue(name, text);
            cache.set(name, value);
            return value;
        },
    };
}

// ------------------------------------------------------------------------------ tokens

type Token =
    | { t: "num"; v: number }
    | { t: "str"; v: string }
    | { t: "regex"; v: string }
    | { t: "id"; v: string }
    | { t: "op"; v: string };

const OPERATORS = ["==", "!=", "<>", "<=", ">=", "=~", "!~", "&&", "||", "<", ">", "+", "-", "*", "/", "%"];

class MacroError extends Error {}

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
            const match = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(source.slice(i));
            if (match) {
                tokens.push({ t: "num", v: Number.parseFloat(match[0]) });
                i += match[0].length;
                continue;
            }
        }
        if (c === '"') {
            let text = "";
            i++;
            while (i < source.length && source[i] !== '"') {
                if (source[i] === "\\" && i + 1 < source.length) {
                    const n = source[i + 1];
                    text += n === "n" ? "\n" : n === "t" ? "\t" : n;
                    i += 2;
                } else text += source[i++];
            }
            if (i >= source.length) throw new MacroError("unterminated string");
            i++;
            tokens.push({ t: "str", v: text });
            continue;
        }
        if (c === "/" && tokens.length > 0) {
            const last = tokens[tokens.length - 1];
            if (last.t === "op" && (last.v === "=~" || last.v === "!~")) {
                const end = source.indexOf("/", i + 1);
                if (end < 0) throw new MacroError("unterminated regular expression");
                tokens.push({ t: "regex", v: source.slice(i + 1, end) });
                i = end + 1;
                continue;
            }
        }
        if (/[A-Za-z_]/.test(c)) {
            const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i)) as RegExpExecArray;
            tokens.push({ t: "id", v: match[0] });
            i += match[0].length;
            continue;
        }
        const op = OPERATORS.find((o) => source.startsWith(o, i));
        if (op) {
            tokens.push({ t: "op", v: op });
            i += op.length;
            continue;
        }
        if ("()[],?:;!=".includes(c)) {
            tokens.push({ t: "op", v: c });
            i++;
            continue;
        }
        throw new MacroError(`unexpected "${c}"`);
    }
    return tokens;
}

// ------------------------------------------------------------------------------ evaluation

const truthy = (value: MacroValue): boolean => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    return Boolean(value);
};

const toNumber = (value: MacroValue): number => {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string") {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n)) return n;
    }
    if (Array.isArray(value) && value.length > 0) return toNumber(value[0]);
    throw new MacroError(`not a number: ${JSON.stringify(value)}`);
};

/** How a value prints into G-code. */
export function formatMacroValue(value: MacroValue): string {
    if (value === null) return "nil";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
        if (Number.isInteger(value)) return value.toString();
        const text = Number(value.toFixed(6)).toString();
        return text === "-0" ? "0" : text;
    }
    if (Array.isArray(value)) return value.map(formatMacroValue).join(",");
    return value;
}

class Evaluator {
    private pos = 0;

    constructor(
        private readonly tokens: Token[],
        private readonly scope: MacroScope,
        private readonly locals: Map<string, MacroValue>,
    ) {}

    get done() {
        return this.pos >= this.tokens.length;
    }

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }

    private isOp(v: string): boolean {
        const token = this.peek();
        return token?.t === "op" && token.v === v;
    }

    private isId(v: string): boolean {
        const token = this.peek();
        return token?.t === "id" && token.v === v;
    }

    private expect(v: string) {
        if (!this.isOp(v)) throw new MacroError(`expected "${v}"`);
        this.pos++;
    }

    /** `statement (; statement)*` → the printed values of expression statements. */
    statements(): string {
        let out = "";
        while (!this.done) {
            if (this.isOp(";")) {
                this.pos++;
                continue;
            }
            if (this.isId("local") || this.isId("global")) {
                this.pos++;
                const name = this.peek();
                if (name?.t !== "id") throw new MacroError("expected a variable name");
                this.pos++;
                this.expect("=");
                this.locals.set(name.v, this.expression());
                continue;
            }
            out += formatMacroValue(this.expression());
        }
        return out;
    }

    expression(): MacroValue {
        const condition = this.or();
        if (!this.isOp("?")) return condition;
        this.pos++;
        const a = this.expression();
        this.expect(":");
        const b = this.expression();
        return truthy(condition) ? a : b;
    }

    private or(): MacroValue {
        let left = this.and();
        while (this.isOp("||") || this.isId("or")) {
            this.pos++;
            const right = this.and();
            left = truthy(left) || truthy(right);
        }
        return left;
    }

    private and(): MacroValue {
        let left = this.not();
        while (this.isOp("&&") || this.isId("and")) {
            this.pos++;
            const right = this.not();
            left = truthy(left) && truthy(right);
        }
        return left;
    }

    private not(): MacroValue {
        if (this.isOp("!") || this.isId("not")) {
            this.pos++;
            return !truthy(this.not());
        }
        return this.comparison();
    }

    private comparison(): MacroValue {
        const left = this.additive();
        const token = this.peek();
        if (token?.t !== "op") return left;
        if (token.v === "=~" || token.v === "!~") {
            this.pos++;
            const regex = this.peek();
            if (regex?.t !== "regex") throw new MacroError("expected /regex/");
            this.pos++;
            const matches = new RegExp(`^(?:${regex.v})$`, "s").test(formatMacroValue(left));
            return token.v === "=~" ? matches : !matches;
        }
        if (!["==", "!=", "<>", "<", ">", "<=", ">="].includes(token.v)) return left;
        this.pos++;
        const right = this.additive();
        const bothStrings = typeof left === "string" && typeof right === "string";
        const a = bothStrings ? left : toNumber(left);
        const b = bothStrings ? right : toNumber(right);
        const eq = typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b;
        switch (token.v) {
            case "==":
                return eq;
            case "!=":
            case "<>":
                return !eq;
            case "<":
                return a < b;
            case ">":
                return a > b;
            case "<=":
                return a <= b || eq;
            default:
                return a >= b || eq;
        }
    }

    private additive(): MacroValue {
        let left = this.multiplicative();
        while (this.isOp("+") || this.isOp("-")) {
            const op = (this.tokens[this.pos++] as { v: string }).v;
            const right = this.multiplicative();
            if (op === "+" && (typeof left === "string" || typeof right === "string")) {
                left = formatMacroValue(left) + formatMacroValue(right);
            } else left = op === "+" ? toNumber(left) + toNumber(right) : toNumber(left) - toNumber(right);
        }
        return left;
    }

    private multiplicative(): MacroValue {
        let left = this.unary();
        while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
            const op = (this.tokens[this.pos++] as { v: string }).v;
            const a = toNumber(left);
            const b = toNumber(this.unary());
            if (op !== "*" && b === 0) throw new MacroError("division by zero");
            left = op === "*" ? a * b : op === "/" ? a / b : a % b;
        }
        return left;
    }

    private unary(): MacroValue {
        if (this.isOp("-")) {
            this.pos++;
            return -toNumber(this.unary());
        }
        if (this.isOp("+")) {
            this.pos++;
            return toNumber(this.unary());
        }
        return this.primary();
    }

    private primary(): MacroValue {
        const token = this.peek();
        if (token === undefined) throw new MacroError("unexpected end of expression");
        this.pos++;
        if (token.t === "num" || token.t === "str") return token.v;
        if (token.t === "op" && token.v === "(") {
            const value = this.expression();
            this.expect(")");
            return value;
        }
        if (token.t !== "id") throw new MacroError(`unexpected "${token.v}"`);
        if (token.v === "true") return true;
        if (token.v === "false") return false;
        if (this.isOp("(")) return this.call(token.v);
        let value = this.variable(token.v);
        if (this.isOp("[")) {
            this.pos++;
            const index = Math.trunc(toNumber(this.expression()));
            this.expect("]");
            if (!Array.isArray(value)) {
                if (index !== 0) throw new MacroError(`${token.v} is not a vector`);
            } else {
                if (index < 0 || index >= value.length)
                    throw new MacroError(`${token.v}[${index}] out of range`);
                value = value[index];
            }
        } else if (Array.isArray(value) && value.length > 0 && !this.wantsVector) {
            value = value[0];
        }
        return value;
    }

    /** Set while parsing arguments of functions that take whole vectors. */
    private wantsVector = false;

    private variable(name: string): MacroValue {
        const local = this.locals.get(name);
        if (local !== undefined) return local;
        const value = this.scope.lookup(name);
        if (value === undefined) throw new MacroError(`unknown variable "${name}"`);
        return value;
    }

    private call(name: string): MacroValue {
        this.expect("(");
        const vectorArgs = name === "size" || name === "empty" || name === "is_nil";
        const args: MacroValue[] = [];
        const saved = this.wantsVector;
        this.wantsVector = vectorArgs;
        if (name === "is_nil") {
            // is_nil(name[i]) must not fail on nil: evaluate leniently.
            try {
                args.push(this.expression());
            } catch {
                args.push(null);
            }
        } else {
            while (!this.isOp(")")) {
                args.push(this.expression());
                if (this.isOp(",")) this.pos++;
                else break;
            }
        }
        this.wantsVector = saved;
        this.expect(")");
        const n = (i: number) => toNumber(args[i] ?? null);
        switch (name) {
            case "min":
                return Math.min(n(0), n(1));
            case "max":
                return Math.max(n(0), n(1));
            case "int":
                return Math.trunc(n(0));
            case "round":
                return Math.round(n(0));
            case "abs":
                return Math.abs(n(0));
            case "digits":
            case "zdigits": {
                const value = n(0);
                const decimals = args.length > 2 ? n(2) : 0;
                const text = value.toFixed(decimals);
                const width = args.length > 1 ? n(1) : 0;
                return name === "zdigits" ? text.padStart(width, "0") : text.padStart(width, " ");
            }
            case "is_nil":
                return args[0] === null;
            case "one_of": {
                const value = formatMacroValue(args[0] ?? "");
                return args.slice(1).some((option) => formatMacroValue(option) === value);
            }
            case "size":
                return Array.isArray(args[0]) ? args[0].length : 1;
            case "empty":
                return Array.isArray(args[0]) ? args[0].length === 0 : formatMacroValue(args[0] ?? "") === "";
            default:
                throw new MacroError(`unknown function "${name}"`);
        }
    }
}

function evaluate(source: string, scope: MacroScope, locals: Map<string, MacroValue>): string {
    const evaluator = new Evaluator(tokenize(source), scope, locals);
    return evaluator.statements();
}

function evaluateCondition(source: string, scope: MacroScope, locals: Map<string, MacroValue>): boolean {
    const evaluator = new Evaluator(tokenize(source), scope, locals);
    const value = evaluator.expression();
    if (!evaluator.done) throw new MacroError(`unexpected text after condition "${source}"`);
    return truthy(value);
}

/** Evaluates a boolean expression (a preset's `compatible_printers_condition`). */
export function evaluatePrusaCondition(
    source: string,
    scope: MacroScope,
): { value: boolean; error?: string } {
    if (source.trim() === "") return { value: true };
    try {
        return { value: evaluateCondition(source, scope, new Map()) };
    } catch (error) {
        return { value: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// ------------------------------------------------------------------------------ templates

type Part =
    | { kind: "text"; text: string }
    | { kind: "expr"; source: string }
    | { kind: "legacy"; name: string; raw: string }
    | { kind: "if"; branches: { condition: string | undefined; body: Part[] }[] };

/** Index of the `}` closing the tag opened at `start` (quotes respected). */
function closingBrace(text: string, start: number): number {
    let inString = false;
    for (let i = start + 1; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === "\\") i++;
            else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "}") return i;
    }
    return -1;
}

function parseTemplate(template: string): Part[] {
    const root: Part[] = [];
    const stack: { branches: { condition: string | undefined; body: Part[] }[] }[] = [];
    let target = root;
    let text = "";
    const flush = () => {
        if (text !== "") target.push({ kind: "text", text });
        text = "";
    };
    let i = 0;
    while (i < template.length) {
        const c = template[i];
        if (c === "{") {
            const end = closingBrace(template, i);
            if (end < 0) throw new MacroError("unclosed {");
            const inner = template.slice(i + 1, end).trim();
            flush();
            const keyword = /^(if|elsif|else|endif)\b\s*([\s\S]*)$/.exec(inner);
            if (keyword?.[1] === "if") {
                const block = { branches: [{ condition: keyword[2], body: [] as Part[] }] };
                target.push({ kind: "if", branches: block.branches });
                stack.push(block);
                target = block.branches[0].body;
            } else if (keyword?.[1] === "elsif" || keyword?.[1] === "else") {
                const block = stack[stack.length - 1];
                if (!block) throw new MacroError(`{${keyword[1]}} without {if}`);
                const branch = {
                    condition: keyword[1] === "else" ? undefined : keyword[2],
                    body: [] as Part[],
                };
                block.branches.push(branch);
                target = branch.body;
            } else if (keyword?.[1] === "endif") {
                if (!stack.pop()) throw new MacroError("{endif} without {if}");
                const parent = stack[stack.length - 1];
                target = parent ? parent.branches[parent.branches.length - 1].body : root;
            } else target.push({ kind: "expr", source: inner });
            i = end + 1;
            continue;
        }
        if (c === "[") {
            const match = /^\[([A-Za-z_][A-Za-z0-9_]*)\]/.exec(template.slice(i, i + 80));
            if (match) {
                flush();
                target.push({ kind: "legacy", name: match[1], raw: match[0] });
                i += match[0].length;
                continue;
            }
        }
        text += c;
        i++;
    }
    flush();
    if (stack.length > 0) throw new MacroError("{if} without {endif}");
    return root;
}

function legacyValue(
    name: string,
    scope: MacroScope,
    locals: Map<string, MacroValue>,
): MacroValue | undefined {
    const direct = locals.get(name) ?? scope.lookup(name);
    if (direct !== undefined) return Array.isArray(direct) ? (direct[0] ?? null) : direct;
    const indexed = /^(.*)_(\d+)$/.exec(name);
    if (!indexed) return undefined;
    const vector = scope.lookup(indexed[1]);
    if (vector === undefined) return undefined;
    return Array.isArray(vector) ? vector[Number(indexed[2])] : vector;
}

/** Expands a custom G-code template; problems are reported and their tags print nothing. */
export function expandPrusaMacros(template: string, scope: MacroScope): MacroResult {
    const errors: string[] = [];
    let parts: Part[];
    try {
        parts = parseTemplate(template);
    } catch (error) {
        return { text: template, errors: [error instanceof Error ? error.message : String(error)] };
    }
    const locals = new Map<string, MacroValue>();
    const render = (list: Part[]): string => {
        let out = "";
        for (const part of list) {
            if (part.kind === "text") out += part.text;
            else if (part.kind === "legacy") {
                const value = legacyValue(part.name, scope, locals);
                out += value === undefined ? part.raw : formatMacroValue(value);
            } else if (part.kind === "expr") {
                try {
                    out += evaluate(part.source, scope, locals);
                } catch (error) {
                    errors.push(
                        `{${part.source}}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            } else {
                for (const branch of part.branches) {
                    let taken = branch.condition === undefined;
                    if (!taken) {
                        try {
                            taken = evaluateCondition(branch.condition as string, scope, locals);
                        } catch (error) {
                            errors.push(
                                `{if ${branch.condition}}: ${error instanceof Error ? error.message : String(error)}`,
                            );
                        }
                    }
                    if (taken) {
                        out += render(branch.body);
                        break;
                    }
                }
            }
        }
        return out;
    };
    return { text: render(parts), errors };
}
