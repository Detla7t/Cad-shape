// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import type { ParameterValue, Scope } from "./expression";

/**
 * Configured values — Onshape's configured parameters, written as an expression so that
 * storage, undo, versioning and the AI tools keep handling a plain string:
 *
 * ```
 * configure(Size, "S": 10, "M": 20, "L": w * 2)
 * configure(Holes, true: 5, false: 0)
 * ```
 *
 * The first argument names a list or checkbox configuration input (bare or `#Size`); each
 * arm maps one of its options (a quoted name, or bare `true`/`false` for a checkbox) to the
 * value the slot takes while that option is active. An arm's value is anything the slot
 * accepts: an expression (`w * 2`), a number, `true`/`false`, an enum member name, or a
 * quoted string for free text. Only the selected arm is ever evaluated, so an arm may use a
 * variable that only makes sense in its own configuration.
 *
 * The form is the whole value, never part of a larger expression: selecting the arm is a
 * step BEFORE evaluation (`selectConfiguredArm`, which `resolveUnitSpec` runs first), and
 * that is what makes every numeric slot of the app configurable at once.
 */

/** The function name a configured value starts with. */
export const CONFIGURE_FUNCTION = "configure";

/** One option → value pair of a configured value. */
export interface ConfiguredArm {
    /** The option name (`"M"`), or `"true"`/`"false"` for a checkbox input. */
    readonly option: string;
    /** The arm's value as written — an expression, a literal, or a quoted string. */
    readonly value: string;
}

/** A configured value taken apart. */
export interface ConfiguredValue {
    /** The configuration input the value switches on. */
    readonly input: string;
    readonly arms: readonly ConfiguredArm[];
}

const CONFIGURED_PATTERN = /^\s*configure\s*\(/;
const NAME_PATTERN = /^[A-Za-z_]\w*/;
/** A bare option key: a word (`true`, `false`, `M`, `10mm`). */
const BARE_KEY_PATTERN = /^[A-Za-z0-9_.-]+/;
const STRING_LITERAL_PATTERN = /^"(?:[^"\\]|\\.)*"$/;
/** Configured values may nest (`configure(A, "x": configure(B, …))`); this bounds the descent. */
const MAX_DEPTH = 16;

/** True when `value` is a configured value — the stored form starts with `configure(`. */
export function isConfiguredValue(value: unknown): value is string {
    return typeof value === "string" && CONFIGURED_PATTERN.test(value);
}

/** `text` as a string literal of the configured-value syntax. */
export function quoteConfiguredString(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(literal: string): string {
    return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * The source of an arm value: a number or boolean as written, an expression unchanged, and
 * free text (`text: true`) as a quoted string so commas and parentheses survive.
 */
export function configuredArmSource(value: number | string | boolean, options?: { text?: boolean }): string {
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    return options?.text === true ? quoteConfiguredString(value) : value.trim();
}

/** Parses `configure(Input, key: value, …)`; reports where the text stops making sense. */
export function parseConfiguredValue(text: string): Result<ConfiguredValue> {
    return new ConfiguredParser(text).parse();
}

/** A configured value written back: list options quoted, checkbox states bare. */
export function formatConfiguredValue(value: ConfiguredValue): string {
    const arms = value.arms.map((arm) => {
        const key =
            arm.option === "true" || arm.option === "false" ? arm.option : quoteConfiguredString(arm.option);
        return `${key}: ${arm.value.trim()}`;
    });
    return arms.length === 0
        ? `${CONFIGURE_FUNCTION}(${value.input})`
        : `${CONFIGURE_FUNCTION}(${value.input}, ${arms.join(", ")})`;
}

/** How an option names itself in a message: `"L"` for a list option, bare `true` for a checkbox. */
function describeOption(option: string): string {
    return option === "true" || option === "false" ? option : `"${option}"`;
}

/** The value an arm holds: a string literal unquoted, a number as a number, else the text. */
function armValue(source: string): ParameterValue {
    const trimmed = source.trim();
    if (STRING_LITERAL_PATTERN.test(trimmed)) return unquote(trimmed);
    const number = Number(trimmed);
    return trimmed !== "" && Number.isFinite(number) ? number : trimmed;
}

/** The option the active configuration selects for `input`, or why there is none. */
export function activeConfiguredOption(input: string, scope: Scope): Result<string> {
    const entry = scope.get(input);
    if (entry === undefined) return Result.err(`Unknown configuration input: ${input}`);
    if (entry.option === undefined) {
        return Result.err(`${input} is not a list or checkbox configuration input`);
    }
    return Result.ok(entry.option);
}

/**
 * The arm the active configuration picks, or the value itself when it is not configured.
 * Nested configured values are followed down to a plain value.
 */
export function selectConfiguredArm(value: ParameterValue, scope: Scope): Result<ParameterValue> {
    let current: ParameterValue = value;
    for (let depth = 0; isConfiguredValue(current); depth++) {
        if (depth >= MAX_DEPTH) return Result.err("Configured values nest too deeply");
        const parsed = parseConfiguredValue(current);
        if (!parsed.isOk) return Result.err(parsed.error);
        const option = activeConfiguredOption(parsed.value.input, scope);
        if (!option.isOk) return Result.err(option.error);
        const arm = parsed.value.arms.find((x) => x.option === option.value);
        if (arm === undefined) {
            return Result.err(`No value for ${parsed.value.input} = ${describeOption(option.value)}`);
        }
        current = armValue(arm.value);
    }
    return Result.ok(current);
}

/**
 * A boolean slot's value — a feature's suppression, a checkbox parameter: `true`/`false`
 * (or the strings, or `1`/`0`) after the configured arm is selected.
 */
export function selectConfiguredBoolean(value: unknown, scope: Scope): Result<boolean> {
    if (typeof value === "boolean") return Result.ok(value);
    if (value === undefined || value === null) return Result.ok(false);
    if (typeof value !== "number" && typeof value !== "string") return Result.err("Expected true or false");
    const selected = selectConfiguredArm(value, scope);
    if (!selected.isOk) return Result.err(selected.error);
    const result = selected.value;
    if (result === "true" || result === 1) return Result.ok(true);
    if (result === "false" || result === 0 || result === "") return Result.ok(false);
    return Result.err(`Expected true or false, got ${String(result)}`);
}

/**
 * `value` with the arm for `option` set to `source` (added at the end when missing) — how a
 * one-configuration edit of a configured slot lands.
 */
export function withConfiguredArm(value: ConfiguredValue, option: string, source: string): ConfiguredValue {
    const arms = value.arms.some((arm) => arm.option === option)
        ? value.arms.map((arm) => (arm.option === option ? { option, value: source } : arm))
        : [...value.arms, { option, value: source }];
    return { input: value.input, arms };
}

/**
 * `configured` with the ACTIVE configuration's arm set to `source` — how an edit of a
 * configured slot in the feature panel lands: Onshape changes a configured parameter for the
 * configuration being shown, not for all of them.
 */
export function assignActiveArm(configured: string, scope: Scope, source: string): Result<string> {
    const parsed = parseConfiguredValue(configured);
    if (!parsed.isOk) return Result.err(parsed.error);
    const option = activeConfiguredOption(parsed.value.input, scope);
    if (!option.isOk) return Result.err(option.error);
    return Result.ok(formatConfiguredValue(withConfiguredArm(parsed.value, option.value, source)));
}

class ConfiguredParser {
    private pos = 0;

    constructor(private readonly source: string) {}

    parse(): Result<ConfiguredValue> {
        this.skipSpaces();
        if (!this.source.startsWith(CONFIGURE_FUNCTION, this.pos)) {
            return Result.err(`Expected ${CONFIGURE_FUNCTION}(…)`);
        }
        this.pos += CONFIGURE_FUNCTION.length;
        this.skipSpaces();
        if (this.source[this.pos] !== "(") return Result.err(`Expected ( after ${CONFIGURE_FUNCTION}`);
        this.pos++;
        this.skipSpaces();
        if (this.source[this.pos] === "#") this.pos++;
        const input = NAME_PATTERN.exec(this.source.slice(this.pos));
        if (input === null)
            return Result.err(`${CONFIGURE_FUNCTION}() expects a configuration input name first`);
        this.pos += input[0].length;

        const arms: ConfiguredArm[] = [];
        for (;;) {
            this.skipSpaces();
            const ch = this.source[this.pos];
            if (ch === ")") {
                this.pos++;
                break;
            }
            if (ch !== ",") return Result.err(`Expected , or ) in ${CONFIGURE_FUNCTION}()`);
            this.pos++;
            const arm = this.parseArm();
            if (!arm.isOk) return Result.err(arm.error);
            if (arms.some((x) => x.option === arm.value.option)) {
                return Result.err(
                    `Duplicate option in ${CONFIGURE_FUNCTION}(): ${describeOption(arm.value.option)}`,
                );
            }
            arms.push(arm.value);
        }
        this.skipSpaces();
        if (this.pos < this.source.length) {
            return Result.err(
                `Unexpected text after ${CONFIGURE_FUNCTION}(): ${this.source.slice(this.pos)}`,
            );
        }
        return Result.ok({ input: input[0], arms });
    }

    private parseArm(): Result<ConfiguredArm> {
        this.skipSpaces();
        let option: string;
        if (this.source[this.pos] === '"') {
            const literal = this.stringLiteral();
            if (literal === undefined) return Result.err("Unterminated string");
            option = unquote(literal);
        } else {
            const bare = BARE_KEY_PATTERN.exec(this.source.slice(this.pos));
            if (bare === null) return Result.err(`Expected an option name in ${CONFIGURE_FUNCTION}()`);
            this.pos += bare[0].length;
            option = bare[0];
        }
        this.skipSpaces();
        if (this.source[this.pos] !== ":") return Result.err(`Expected : after ${describeOption(option)}`);
        this.pos++;
        const start = this.pos;
        let depth = 0;
        while (this.pos < this.source.length) {
            const ch = this.source[this.pos];
            if (ch === '"') {
                if (this.stringLiteral() === undefined) return Result.err("Unterminated string");
                continue;
            }
            if (ch === "(") depth++;
            else if (ch === ")") {
                if (depth === 0) break;
                depth--;
            } else if (ch === "," && depth === 0) break;
            this.pos++;
        }
        if (this.pos >= this.source.length) return Result.err(`Missing ) in ${CONFIGURE_FUNCTION}()`);
        const value = this.source.slice(start, this.pos).trim();
        if (value === "") return Result.err(`Missing value for ${describeOption(option)}`);
        return Result.ok({ option, value });
    }

    /** Consumes a `"…"` literal at the cursor and returns it (quotes included). */
    private stringLiteral(): string | undefined {
        const start = this.pos;
        this.pos++;
        while (this.pos < this.source.length) {
            const ch = this.source[this.pos];
            if (ch === "\\") {
                this.pos += 2;
                continue;
            }
            this.pos++;
            if (ch === '"') return this.source.slice(start, this.pos);
        }
        return undefined;
    }

    private skipSpaces(): void {
        while (/\s/.test(this.source[this.pos] ?? "")) this.pos++;
    }
}
