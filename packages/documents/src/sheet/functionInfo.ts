// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ARGUMENT_DOCS,
    FUNCTION_CATEGORIES,
    FUNCTION_DETAILS,
    type FunctionCategory,
} from "./functionDetails";
import { MORE_FUNCTION_CATEGORIES, MORE_FUNCTION_INFO } from "./functionInfoMore";

/** Signatures describe functions that the local evaluator actually supports. */
export const FUNCTION_INFO: Record<
    string,
    readonly [parameters: string, description: string, min: number, max?: number]
> = {
    SUM: ["number1, [number2], …", "Adds numbers and ranges.", 1],
    PRODUCT: ["number1, [number2], …", "Multiplies numbers and ranges.", 1],
    AVERAGE: [
        "number1, [number2], …",
        "Returns the arithmetic mean, ignoring empty cells and text in ranges.",
        1,
    ],
    MIN: ["number1, [number2], …", "Returns the smallest number.", 1],
    MAX: ["number1, [number2], …", "Returns the largest number.", 1],
    MEDIAN: ["number1, [number2], …", "Returns the middle number.", 1],
    COUNT: ["value1, [value2], …", "Counts numeric values.", 1],
    COUNTA: ["value1, [value2], …", "Counts nonempty values.", 1],
    COUNTBLANK: ["range", "Counts empty cells in a range.", 1, 1],
    SUMIF: [
        "range, criteria, [sum_range]",
        "Adds values that meet one condition. Supports * and ? wildcards.",
        2,
        3,
    ],
    COUNTIF: ["range, criteria", "Counts cells that meet one condition.", 2, 2],
    AVERAGEIF: ["range, criteria, [average_range]", "Averages values that meet one condition.", 2, 3],
    SUMIFS: ["sum_range, criteria_range1, criteria1, …", "Adds values whose rows meet every condition.", 3],
    COUNTIFS: ["criteria_range1, criteria1, …", "Counts rows that meet every condition.", 2],
    AVERAGEIFS: [
        "average_range, criteria_range1, criteria1, …",
        "Averages values that meet every condition.",
        3,
    ],
    MINIFS: [
        "min_range, criteria_range1, criteria1, …",
        "Returns the smallest value that meets every condition.",
        3,
    ],
    MAXIFS: [
        "max_range, criteria_range1, criteria1, …",
        "Returns the largest value that meets every condition.",
        3,
    ],
    SUMPRODUCT: ["array1, [array2], …", "Adds products of matching entries in equally sized ranges.", 1],
    IF: ["logical_test, value_if_true, [value_if_false]", "Chooses a value based on a condition.", 2, 3],
    IFERROR: ["value, value_if_error", "Returns a fallback when the value is an error.", 2, 2],
    IFNA: ["value, value_if_na", "Returns a fallback only for #N/A.", 2, 2],
    IFS: ["logical_test1, value_if_true1, …", "Returns the value for the first true condition.", 2],
    AND: ["logical1, [logical2], …", "TRUE when all conditions are true.", 1],
    OR: ["logical1, [logical2], …", "TRUE when any condition is true.", 1],
    NOT: ["logical", "Reverses TRUE and FALSE.", 1, 1],
    TRUE: ["", "Returns TRUE.", 0, 0],
    FALSE: ["", "Returns FALSE.", 0, 0],
    NA: ["", "Returns the #N/A error.", 0, 0],
    ISNUMBER: ["value", "Tests whether a value is numeric.", 1, 1],
    ISTEXT: ["value", "Tests whether a value is text.", 1, 1],
    ISBLANK: ["value", "Tests whether a referenced cell is empty.", 1, 1],
    ISERROR: ["value", "Tests for any formula error.", 1, 1],
    ISNA: ["value", "Tests specifically for #N/A.", 1, 1],
    ROUND: ["number, num_digits", "Rounds to a number of decimal places.", 1, 2],
    ROUNDUP: ["number, num_digits", "Rounds away from zero.", 1, 2],
    ROUNDDOWN: ["number, num_digits", "Rounds toward zero.", 1, 2],
    TRUNC: ["number, [num_digits]", "Truncates a number toward zero.", 1, 2],
    ABS: ["number", "Returns the absolute value.", 1, 1],
    SQRT: ["number", "Returns the square root.", 1, 1],
    INT: ["number", "Rounds down to an integer.", 1, 1],
    EXP: ["number", "Returns e raised to a power.", 1, 1],
    LN: ["number", "Returns the natural logarithm.", 1, 1],
    LOG10: ["number", "Returns the base-10 logarithm.", 1, 1],
    LOG: ["number, [base]", "Returns a logarithm; the default base is 10.", 1, 2],
    POWER: ["number, power", "Raises a number to a power.", 2, 2],
    MOD: ["number, divisor", "Returns the remainder with the sign of the divisor.", 2, 2],
    SIGN: ["number", "Returns -1, 0 or 1 for the sign of a number.", 1, 1],
    PI: ["", "Returns pi.", 0, 0],
    SIN: ["number", "Returns the sine of an angle in radians.", 1, 1],
    COS: ["number", "Returns the cosine of an angle in radians.", 1, 1],
    TAN: ["number", "Returns the tangent of an angle in radians.", 1, 1],
    ASIN: ["number", "Returns the inverse sine in radians.", 1, 1],
    ACOS: ["number", "Returns the inverse cosine in radians.", 1, 1],
    ATAN: ["number", "Returns the inverse tangent in radians.", 1, 1],
    ATAN2: ["x_num, y_num", "Returns the angle of a point, in radians.", 2, 2],
    RADIANS: ["angle", "Converts degrees to radians.", 1, 1],
    DEGREES: ["angle", "Converts radians to degrees.", 1, 1],
    CONCAT: ["text1, [text2], …", "Joins text and ranges.", 1],
    CONCATENATE: ["text1, [text2], …", "Joins text values.", 1],
    TEXTJOIN: [
        "delimiter, ignore_empty, text1, …",
        "Joins text with a delimiter, optionally skipping empty cells.",
        3,
    ],
    TEXT: ["value, format_text", "Formats a value with an Excel number or date format.", 2, 2],
    VALUE: ["text", "Converts numeric text, currency or a percentage to a number.", 1, 1],
    LEN: ["text", "Counts characters in text.", 1, 1],
    LEFT: ["text, [num_chars]", "Returns characters from the start of text.", 1, 2],
    RIGHT: ["text, [num_chars]", "Returns characters from the end of text.", 1, 2],
    MID: ["text, start_num, num_chars", "Returns characters starting at a one-based position.", 3, 3],
    UPPER: ["text", "Converts text to uppercase.", 1, 1],
    LOWER: ["text", "Converts text to lowercase.", 1, 1],
    PROPER: ["text", "Capitalizes the first letter of each word.", 1, 1],
    TRIM: ["text", "Removes leading, trailing and repeated spaces.", 1, 1],
    CLEAN: ["text", "Removes nonprinting ASCII characters.", 1, 1],
    EXACT: ["text1, text2", "Compares text, including letter case.", 2, 2],
    SUBSTITUTE: [
        "text, old_text, new_text, [instance_num]",
        "Replaces matching text, optionally only one occurrence.",
        3,
        4,
    ],
    REPT: ["text, number_times", "Repeats text.", 2, 2],
    FIND: ["find_text, within_text, [start_num]", "Finds a case-sensitive one-based text position.", 2, 3],
    SEARCH: [
        "find_text, within_text, [start_num]",
        "Finds text ignoring case. Supports * and ? wildcards.",
        2,
        3,
    ],
    VLOOKUP: [
        "lookup_value, table_array, col_index_num, [range_lookup]",
        "Searches the first column; FALSE requests an exact match.",
        3,
        4,
    ],
    HLOOKUP: [
        "lookup_value, table_array, row_index_num, [range_lookup]",
        "Searches the first row; FALSE requests an exact match.",
        3,
        4,
    ],
    XLOOKUP: [
        "lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode]",
        "Looks up a value in a row or column. Exact match is the default.",
        3,
        6,
    ],
    INDEX: ["array, row_num, [column_num]", "Returns the value at a row and column.", 2, 3],
    MATCH: [
        "lookup_value, lookup_array, [match_type]",
        "Returns a matching position; use 0 for an exact match.",
        2,
        3,
    ],
    DATE: ["year, month, day", "Builds an Excel serial date.", 3, 3],
    TIME: ["hour, minute, second", "Builds a time as a fraction of a day.", 3, 3],
    YEAR: ["serial_number", "Returns a date's year.", 1, 1],
    MONTH: ["serial_number", "Returns a date's month, 1 to 12.", 1, 1],
    DAY: ["serial_number", "Returns a date's day of the month.", 1, 1],
    HOUR: ["serial_number", "Returns the hour, 0 to 23.", 1, 1],
    MINUTE: ["serial_number", "Returns the minute, 0 to 59.", 1, 1],
    SECOND: ["serial_number", "Returns the second, 0 to 59.", 1, 1],
    TODAY: ["", "Returns today's date.", 0, 0],
    NOW: ["", "Returns the current date and time.", 0, 0],
    EDATE: ["start_date, months", "Shifts a date by a number of months.", 2, 2],
    EOMONTH: ["start_date, months", "Returns the last day of a shifted month.", 2, 2],
    DAYS: ["end_date, start_date", "Returns the number of days between two dates.", 2, 2],
};

Object.assign(FUNCTION_INFO, MORE_FUNCTION_INFO);

export { FUNCTION_CATEGORIES, type FunctionCategory } from "./functionDetails";

export interface FunctionArgumentDoc {
    name: string;
    optional: boolean;
    /** The argument (with the ones before it in its group) may repeat. */
    repeating: boolean;
    description: string;
}

/** Everything the function browser shows about one function. */
export interface FunctionDoc {
    name: string;
    category: FunctionCategory;
    /** Parameters only, e.g. "number1, [number2], …". */
    signature: string;
    description: string;
    example: string;
    args: FunctionArgumentDoc[];
    /** Takes no arguments (TODAY, PI, …). */
    zeroArgs: boolean;
}

const CATEGORY_RULES: [RegExp, FunctionCategory][] = [
    [/^IS|^ERROR\.TYPE$|^(N|NA|TYPE|CELL|INFO|SHEETS?)$/, "Information"],
    [/^D(AVERAGE|COUNTA?|GET|MAX|MIN|PRODUCT|STDEVP?|SUM|VARP?)$/, "Database"],
    [/^(BIN|DEC|HEX|OCT)2|^IM|^BESSEL|^BIT|^ERFC?(\.|$)|^(COMPLEX|CONVERT|DELTA|GESTEP)$/, "Engineering"],
    [
        /^(COUP|YIELD|PRICE|TBILL|ACCRINT|DOLLAR(DE|FR))|^(X?IRR|X?NPV|MIRR|N?PER|PMT|I?PPMT|PV|FV|RATE)$/,
        "Financial",
    ],
    [/DIST|\.INV|TEST$|^(STDEV|VAR|COVAR|PERCENT|QUARTILE|RANK|MODE|SKEW|KURT)/, "Statistical"],
    [/DATE|TIME|DAY|WEEK|MONTH|YEAR|^(NOW|HOUR|MINUTE|SECOND)$/, "Date & time"],
    [/^TEXT|^REGEX|^(LEFT|RIGHT|MID|LEN|TRIM|UPPER|LOWER|PROPER|CHAR|CODE|UNICHAR|UNICODE)$/, "Text"],
    [
        /LOOKUP|MATCH|STACK$|^(CHOOSE|INDEX|INDIRECT|OFFSET|ROWS?|COLUMNS?|SORT|SORTBY|FILTER|UNIQUE)$/,
        "Lookup & reference",
    ],
];

function categoryOf(name: string): FunctionCategory {
    const declared = MORE_FUNCTION_CATEGORIES[name];
    if (declared && (FUNCTION_CATEGORIES as readonly string[]).includes(declared))
        return declared as FunctionCategory;
    const known = FUNCTION_DETAILS[name]?.category;
    if (known) return known;
    return CATEGORY_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? "Other";
}

/** The browser category of a function: the engine's declaration, then the reference table, then a guess. */
export function functionCategory(name: string): FunctionCategory {
    return categoryOf(name.toUpperCase());
}

function argumentsOf(name: string, signature: string): FunctionArgumentDoc[] {
    const notes = FUNCTION_DETAILS[name]?.args;
    const args: FunctionArgumentDoc[] = [];
    for (const raw of signature.split(",").map((part) => part.trim())) {
        if (raw === "") continue;
        if (raw === "…" || raw === "...") {
            const last = args.at(-1);
            if (last) last.repeating = true;
            continue;
        }
        const optional = raw.startsWith("[");
        const label = raw.replace(/[[\]…]/g, "").trim();
        const base = label.replace(/\d+$/, "");
        const description =
            notes?.[label] ?? notes?.[base] ?? ARGUMENT_DOCS[label] ?? ARGUMENT_DOCS[base] ?? "";
        args.push({ name: label, optional, repeating: false, description });
    }
    return args;
}

/** Merges the engine's own metadata (authoritative signature and arity) with the reference details. */
export function functionDoc(name: string): FunctionDoc {
    const key = name.toUpperCase();
    const info = FUNCTION_INFO[key];
    const detail = FUNCTION_DETAILS[key];
    const signature = info?.[0] ?? detail?.signature ?? "";
    return {
        name: key,
        category: categoryOf(key),
        signature,
        description: info?.[1] ?? detail?.description ?? "",
        example: detail?.example ?? `=${key}(${signature ? "…" : ""})`,
        args: argumentsOf(key, signature),
        zeroArgs: info ? info[3] === 0 : signature === "",
    };
}

function isSubsequence(query: string, text: string): boolean {
    let i = 0;
    for (const c of text) if (c === query[i]) i++;
    return i === query.length;
}

/**
 * Filters and ranks functions for a search: exact name, name prefix, prefix of a dotted
 * part (`DIST` finds `NORM.DIST`), substring, letters in order from the first (`vlk` finds VLOOKUP), then
 * descriptions containing every word. An empty query keeps alphabetical order.
 */
export function searchFunctions(docs: readonly FunctionDoc[], query: string, category = ""): FunctionDoc[] {
    const pool = category ? docs.filter((doc) => doc.category === category) : [...docs];
    const q = query.trim().toUpperCase();
    if (q === "") return pool.sort((a, b) => a.name.localeCompare(b.name));
    const words = q.split(/\s+/);
    const score = (doc: FunctionDoc) => {
        const name = doc.name;
        if (name === q) return 0;
        if (name.startsWith(q)) return 1;
        if (name.split(/[._]/).some((part) => part.startsWith(q))) return 2;
        if (name.includes(q)) return 3;
        if (q.length > 1 && !q.includes(" ") && name[0] === q[0] && isSubsequence(q, name)) return 4;
        const text = `${doc.description} ${doc.category} ${doc.signature}`.toUpperCase();
        return words.every((word) => text.includes(word)) ? 5 : -1;
    };
    return pool
        .map((doc) => ({ doc, rank: score(doc) }))
        .filter((entry) => entry.rank >= 0)
        .sort(
            (a, b) =>
                a.rank - b.rank ||
                a.doc.name.length - b.doc.name.length ||
                a.doc.name.localeCompare(b.doc.name),
        )
        .map((entry) => entry.doc);
}
