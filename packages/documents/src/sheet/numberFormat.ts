// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { generalNumberText } from "./formula";
import type { CellValue } from "./model";

/**
 * Excel number format codes for display: sections (`pos;neg;zero;text`), digits and
 * decimals (`0`, `#`, `0.00`), thousands separators, percent, scientific (`0.00E+00`),
 * quoted and escaped literals, `@` for text, and dates/times on Excel serial numbers
 * (`yyyy-mm-dd`, `hh:mm:ss`, `AM/PM`). Colors (`[Red]`) and locale codes are ignored.
 */

/** The formats the grid's format menu offers. */
export const COMMON_NUMBER_FORMATS: readonly string[] = [
    "General",
    "0",
    "0.00",
    "#,##0",
    "#,##0.00",
    "0%",
    "0.00%",
    "0.00E+00",
    "yyyy-mm-dd",
    "hh:mm:ss",
    "@",
];

function splitSections(format: string): string[] {
    const sections: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < format.length; i++) {
        const char = format[i];
        if (char === '"') quoted = !quoted;
        if (char === "\\" && i + 1 < format.length) {
            current += char + format[++i];
            continue;
        }
        if (char === ";" && !quoted) {
            sections.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    sections.push(current);
    return sections;
}

/** The format with quoted/escaped literals replaced by placeholders, plus the literals. */
function stripLiterals(section: string): { code: string; literals: string[] } {
    const literals: string[] = [];
    let code = "";
    for (let i = 0; i < section.length; i++) {
        const char = section[i];
        if (char === '"') {
            const end = section.indexOf('"', i + 1);
            literals.push(section.slice(i + 1, end < 0 ? undefined : end));
            code += placeholder(literals.length - 1);
            i = end < 0 ? section.length : end;
        } else if (char === "\\" && i + 1 < section.length) {
            literals.push(section[++i]);
            code += placeholder(literals.length - 1);
        } else if (char === "[") {
            const end = section.indexOf("]", i);
            i = end < 0 ? section.length : end; // colors, conditions, locales
        } else if (char === "_" && i + 1 < section.length) {
            literals.push(" ");
            code += placeholder(literals.length - 1);
            i++;
        } else if (char === "*") {
            i++; // repeat fill
        } else {
            code += char;
        }
    }
    return { code, literals };
}

/** A literal's stand-in: private-use characters, so no digit or format code shows through. */
const placeholder = (index: number) => `\uE000${String.fromCharCode(0xe100 + index)}`;

const restore = (text: string, literals: string[]) =>
    text.replace(
        /\uE000([\uE100-\uEFFF])/g,
        (_, index: string) => literals[index.charCodeAt(0) - 0xe100] ?? "",
    );

const isDateCode = (code: string) =>
    /[yYdD]|[hH]|[sS]|AM\/PM|A\/P/.test(code.replace(/\uE000[\uE100-\uEFFF]/g, ""));

const pad = (value: number, length: number) => String(value).padStart(length, "0");

/** Excel serial day number (1900 system) → UTC date parts. */
function serialToDate(serial: number): Date {
    // Day 60 is Excel's phantom 1900-02-29; after it, days count from 1899-12-30.
    const days = serial < 60 ? serial + 1 : serial;
    const ms = Math.round((days - 1) * 86400000) + Date.UTC(1899, 11, 31);
    return new Date(ms);
}

const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDate(serial: number, code: string, literals: string[]): string {
    const date = serialToDate(serial);
    const hasAmPm = /AM\/PM|A\/P/i.test(code);
    const tokens =
        code.match(/\uE000[\uE100-\uEFFF]|AM\/PM|am\/pm|A\/P|a\/p|y+|Y+|m+|M+|d+|D+|h+|H+|s+|S+|\.0+|./g) ??
        [];
    let out = "";
    let lastWasHour = false;
    tokens.forEach((token, index) => {
        const lower = token.toLowerCase();
        const next =
            tokens
                .slice(index + 1)
                .find((t) => /^[a-z]/i.test(t))
                ?.toLowerCase() ?? "";
        if (lower.startsWith("y"))
            out += lower.length <= 2 ? pad(date.getUTCFullYear() % 100, 2) : String(date.getUTCFullYear());
        else if (lower.startsWith("m")) {
            // "m" after hours or before seconds means minutes.
            if (lastWasHour || next.startsWith("s"))
                out += lower.length >= 2 ? pad(date.getUTCMinutes(), 2) : String(date.getUTCMinutes());
            else if (lower.length >= 4) out += MONTHS[date.getUTCMonth()];
            else if (lower.length === 3) out += MONTHS[date.getUTCMonth()].slice(0, 3);
            else out += lower.length === 2 ? pad(date.getUTCMonth() + 1, 2) : String(date.getUTCMonth() + 1);
        } else if (lower.startsWith("d")) {
            if (lower.length >= 4) out += DAYS[date.getUTCDay()];
            else if (lower.length === 3) out += DAYS[date.getUTCDay()].slice(0, 3);
            else out += lower.length === 2 ? pad(date.getUTCDate(), 2) : String(date.getUTCDate());
        } else if (lower.startsWith("h")) {
            let hours = date.getUTCHours();
            if (hasAmPm) hours = hours % 12 === 0 ? 12 : hours % 12;
            out += lower.length >= 2 ? pad(hours, 2) : String(hours);
        } else if (lower.startsWith("s"))
            out += lower.length >= 2 ? pad(date.getUTCSeconds(), 2) : String(date.getUTCSeconds());
        else if (lower === "am/pm") out += date.getUTCHours() < 12 ? "AM" : "PM";
        else if (lower === "a/p") out += date.getUTCHours() < 12 ? "A" : "P";
        else if (token.startsWith(".0"))
            out += `.${pad(Math.floor((date.getUTCMilliseconds() / 1000) * 10 ** (token.length - 1)), token.length - 1)}`;
        else out += token;
        lastWasHour = lower.startsWith("h") || (lastWasHour && !/^[a-z]/i.test(token));
    });
    return restore(out, literals);
}

function formatNumberCode(value: number, code: string, literals: string[]): string {
    const percent = (code.match(/%/g) ?? []).length;
    let number = value * 100 ** percent;
    const scientific = /E[+-]/i.exec(code);
    const placeholders = /[0#?][0#?,.]*|\.[0#?]+/;
    const match = placeholders.exec(code);
    if (match === null) return restore(code, literals);
    let pattern = match[0];
    if (scientific) {
        const exponentDigits = (/E[+-](0+)/i.exec(code)?.[1] ?? "00").length;
        const mantissa = pattern.split(".");
        const decimals = (mantissa[1] ?? "").length;
        const exponent = number === 0 ? 0 : Math.floor(Math.log10(Math.abs(number)));
        const scaled = number / 10 ** exponent;
        const sign = exponent < 0 ? "-" : "+";
        const body = `${scaled.toFixed(decimals)}E${sign}${pad(Math.abs(exponent), exponentDigits)}`;
        return restore(code.replace(/[0#?.,]+E[+-]0+/i, body), literals);
    }
    // Trailing commas scale by thousands ("#,##0," shows thousands).
    while (pattern.endsWith(",")) {
        number /= 1000;
        pattern = pattern.slice(0, -1);
    }
    const [integerPart, fractionPart = ""] = pattern.split(".");
    const decimals = fractionPart.length;
    const required = fractionPart.replace(/[#?]/g, "").length;
    let fixed = Math.abs(number).toFixed(decimals);
    let [whole, fraction = ""] = fixed.split(".");
    // Optional decimals (#) drop trailing zeros beyond the required ones.
    while (fraction.length > required && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
    const minimumDigits = integerPart.replace(/[^0]/g, "").length;
    if (whole === "0" && minimumDigits === 0) whole = "";
    whole = whole.padStart(minimumDigits, "0");
    if (integerPart.includes(",")) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    fixed = fraction.length > 0 || (decimals > 0 && required > 0) ? `${whole}.${fraction}` : whole;
    if (fixed === "") fixed = "0";
    return restore(code.replace(match[0], fixed), literals);
}

/** A cell value as shown with number format `format` (General when absent). */
export function formatCellValue(value: CellValue | null | undefined, format?: string): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (format === undefined || format === "" || format.toLowerCase() === "general") {
        return typeof value === "number" ? generalNumberText(value) : value;
    }
    const sections = splitSections(format);
    if (typeof value === "string") {
        const textSection = sections.length >= 4 ? sections[3] : sections.find((s) => s.includes("@"));
        if (textSection === undefined) return value;
        const { code, literals } = stripLiterals(textSection);
        return restore(code.replace(/@/g, value), literals);
    }
    let section = sections[0];
    let number = value;
    let negativeSection = false;
    if (value < 0 && sections.length >= 2 && sections[1] !== "") {
        section = sections[1];
        number = -value;
        negativeSection = true;
    } else if (value === 0 && sections.length >= 3 && sections[2] !== "") {
        section = sections[2];
    }
    const { code, literals } = stripLiterals(section);
    if (code.trim() === "@") return generalNumberText(value);
    if (code.toLowerCase() === "general") return generalNumberText(number);
    if (isDateCode(code)) return formatDate(number, code, literals);
    const text = formatNumberCode(number, code, literals);
    return number < 0 && !negativeSection ? `-${text}` : text;
}
