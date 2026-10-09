// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ARRAY_FUNCTIONS, numberArg } from "./formulaArrays";
import {
    ERR,
    excelSerial,
    type Fn,
    type FormulaError,
    flatten,
    isError,
    matrix,
    numbers,
    round,
    type Scalar,
    scalar,
    serialDate,
    toBoolean,
    toNumber,
    toText,
    type Value,
} from "./formulaValues";
import { formatCellValue } from "./numberFormat";

/**
 * The formula engine's function library beyond the core set in `formula.ts`: math,
 * statistics, text, dates, information, financial and engineering functions, plus the
 * logic/lookup/dynamic-array functions of `formulaArrays.ts`. `ELEMENTWISE` lists the
 * per-value functions the evaluator maps over array arguments.
 */

type NumberOrError = number | FormulaError;

/** A function of numbers: every argument coerced (errors propagate), `f`'s NaN/∞ → #NUM!. */
function numeric(min: number, f: (...x: number[]) => number | FormulaError): Fn {
    return (args) => {
        const xs: number[] = [];
        for (const arg of args) {
            const x = toNumber(scalar(arg));
            if (isError(x)) return x;
            xs.push(x);
        }
        if (xs.length < min) return ERR("#VALUE!");
        const out = f(...xs);
        return isError(out) || Number.isFinite(out) ? out : ERR("#NUM!");
    };
}

/** Numbers of an argument list with an optional numeric argument after it. */
function listAndK(args: Value[]): { list: number[]; k: number } | FormulaError {
    const list = numbers([args[0] ?? null]);
    if (isError(list)) return list;
    const k = toNumber(scalar(args[1] ?? null));
    return isError(k) ? k : { list, k };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => sum(xs) / xs.length;

function variance(xs: number[], sample: boolean): NumberOrError {
    if (xs.length < (sample ? 2 : 1)) return ERR("#DIV/0!");
    const m = mean(xs);
    return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - (sample ? 1 : 0));
}

function stat(f: (xs: number[]) => NumberOrError): Fn {
    return (args) => {
        const xs = numbers(args);
        return isError(xs) ? xs : f(xs);
    };
}

/** Numbers counting text as 0 and booleans as 0/1 in ranges (the …A functions). */
function numbersA(args: Value[]): number[] | FormulaError {
    const out: number[] = [];
    for (const value of flatten(args)) {
        if (value === null) continue;
        if (isError(value)) return value;
        out.push(typeof value === "number" ? value : typeof value === "boolean" ? (value ? 1 : 0) : 0);
    }
    return out;
}

function percentile(xs: number[], p: number, exclusive: boolean): NumberOrError {
    if (xs.length === 0) return ERR("#NUM!");
    const sorted = [...xs].sort((a, b) => a - b);
    const n = sorted.length;
    const rank = exclusive ? p * (n + 1) - 1 : p * (n - 1);
    if (p < 0 || p > 1 || rank < 0 || rank > n - 1) return ERR("#NUM!");
    const lo = Math.floor(rank);
    const frac = rank - lo;
    return lo + 1 < n ? sorted[lo] + frac * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

function pairs(args: Value[]): { xs: number[]; ys: number[] } | FormulaError {
    const a = flatten([args[0] ?? null]);
    const b = flatten([args[1] ?? null]);
    if (a.length !== b.length) return ERR("#N/A");
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < a.length; i++) {
        if (isError(a[i])) return a[i] as FormulaError;
        if (isError(b[i])) return b[i] as FormulaError;
        if (typeof a[i] === "number" && typeof b[i] === "number") {
            xs.push(a[i] as number);
            ys.push(b[i] as number);
        }
    }
    return { xs, ys };
}

function covariance(xs: number[], ys: number[], sample: boolean): NumberOrError {
    if (xs.length < (sample ? 2 : 1)) return ERR("#DIV/0!");
    const mx = mean(xs);
    const my = mean(ys);
    return sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / (xs.length - (sample ? 1 : 0));
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7). */
function normCdf(z: number): number {
    const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
    const y =
        1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
            t *
            Math.exp(-(z * z) / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse standard normal CDF (Acklam's rational approximation, refined by one Newton step). */
function normInv(p: number): number {
    const a = [
        -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
        2.506628277459239,
    ];
    const b = [
        -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572,
    ];
    const c = [
        -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
        2.938163982698783,
    ];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lowP = 0.02425;
    let x: number;
    if (p < lowP) {
        const q = Math.sqrt(-2 * Math.log(p));
        x =
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= 1 - lowP) {
        const q = p - 0.5;
        const r = q * q;
        x =
            ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
            (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        x =
            -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const e = normCdf(x) - p;
    return x - e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
}

// -------------------------------------------------------------------- Dates

const toDay = (serial: number) => Math.floor(serial);

/** Weekday 1 = Sunday … 7 = Saturday for a date serial. */
function weekday(serial: number): number {
    return serialDate(toDay(serial)).getUTCDay() + 1;
}

/** Weekend days (0 = Sunday) of a NETWORKDAYS.INTL/WORKDAY.INTL weekend code or mask. */
function weekendDays(code: Scalar): Set<number> | FormulaError {
    if (code === null) return new Set([0, 6]);
    if (typeof code === "string") {
        if (!/^[01]{7}$/.test(code)) return ERR("#VALUE!");
        // Mask from Monday to Sunday.
        return new Set([...code].flatMap((bit, i) => (bit === "1" ? [(i + 1) % 7] : [])));
    }
    const n = toNumber(code);
    if (isError(n)) return n;
    const pairsByCode: Record<number, number[]> = {
        1: [6, 0],
        2: [0, 1],
        3: [1, 2],
        4: [2, 3],
        5: [3, 4],
        6: [4, 5],
        7: [5, 6],
        11: [0],
        12: [1],
        13: [2],
        14: [3],
        15: [4],
        16: [5],
        17: [6],
    };
    const days = pairsByCode[Math.trunc(n)];
    return days === undefined ? ERR("#NUM!") : new Set(days);
}

function holidays(value: Value | undefined): Set<number> | FormulaError {
    const out = new Set<number>();
    for (const v of flatten([value ?? null])) {
        if (v === null) continue;
        const n = toNumber(v);
        if (isError(n)) return n;
        out.add(toDay(n));
    }
    return out;
}

function networkDays(
    startValue: Scalar,
    endValue: Scalar,
    weekend: Scalar,
    holidayValue: Value | undefined,
): Value {
    const start = toNumber(startValue);
    const end = toNumber(endValue);
    if (isError(start)) return start;
    if (isError(end)) return end;
    const off = weekendDays(weekend);
    if (isError(off)) return off;
    const free = holidays(holidayValue);
    if (isError(free)) return free;
    const [a, b, sign] = start <= end ? [toDay(start), toDay(end), 1] : [toDay(end), toDay(start), -1];
    let count = 0;
    for (let d = a; d <= b; d++) if (!off.has(weekday(d) - 1) && !free.has(d)) count++;
    return count * sign;
}

function workday(
    startValue: Scalar,
    daysValue: Scalar,
    weekend: Scalar,
    holidayValue: Value | undefined,
): Value {
    const start = toNumber(startValue);
    const days = toNumber(daysValue);
    if (isError(start)) return start;
    if (isError(days)) return days;
    const off = weekendDays(weekend);
    if (isError(off)) return off;
    if (off.size === 7) return ERR("#VALUE!");
    const free = holidays(holidayValue);
    if (isError(free)) return free;
    let d = toDay(start);
    let left = Math.trunc(days);
    const step = left >= 0 ? 1 : -1;
    while (left !== 0) {
        d += step;
        if (!off.has(weekday(d) - 1) && !free.has(d)) left -= step;
    }
    return d;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date typed as text ("2024-03-15", "3/15/2024", "15 Mar 2024", "March 15, 2024"). */
export function parseDateText(text: string): number | undefined {
    const t = text.trim();
    let y: number;
    let mo: number;
    let d: number;
    let time = 0;
    const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](.*))?$/.exec(t);
    const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
    const dayMonth = /^(\d{1,2})[ -]([A-Za-z]{3,})[ -,]*(\d{2,4})$/.exec(t);
    const monthDay = /^([A-Za-z]{3,})[ -](\d{1,2}),?[ -](\d{2,4})$/.exec(t);
    if (iso) {
        [y, mo, d] = [+iso[1], +iso[2], +iso[3]];
        if (iso[4]) {
            const tv = parseTimeText(iso[4]);
            if (tv === undefined) return undefined;
            time = tv;
        }
    } else if (us) {
        // US order (month/day/year), as Excel's default locale.
        [mo, d, y] = [+us[1], +us[2], +us[3]];
    } else if (dayMonth) {
        [d, mo, y] = [+dayMonth[1], MONTHS.indexOf(dayMonth[2].slice(0, 3).toLowerCase()) + 1, +dayMonth[3]];
    } else if (monthDay) {
        [mo, d, y] = [MONTHS.indexOf(monthDay[1].slice(0, 3).toLowerCase()) + 1, +monthDay[2], +monthDay[3]];
    } else return undefined;
    if (y < 100) y += y < 30 ? 2000 : 1900;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCMonth() !== mo - 1) return undefined;
    return excelSerial(date.getTime()) + time;
}

function parseTimeText(text: string): number | undefined {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm])?$/.exec(text.trim());
    if (!m) return undefined;
    let h = +m[1];
    if (m[4]) {
        if (h > 12) return undefined;
        h = (h % 12) + (m[4].toLowerCase() === "pm" ? 12 : 0);
    }
    const seconds = h * 3600 + +m[2] * 60 + (m[3] ? +m[3] : 0);
    return seconds >= 86400 ? undefined : seconds / 86400;
}

function days360(start: number, end: number, european: boolean): number {
    const a = serialDate(toDay(start));
    const b = serialDate(toDay(end));
    let d1 = a.getUTCDate();
    let d2 = b.getUTCDate();
    const lastOfFeb = (d: Date) =>
        d.getUTCMonth() === 1 && new Date(Date.UTC(d.getUTCFullYear(), 2, 0)).getUTCDate() === d.getUTCDate();
    if (european) {
        if (d1 === 31) d1 = 30;
        if (d2 === 31) d2 = 30;
    } else {
        if (d1 === 31 || lastOfFeb(a)) d1 = 30;
        if (d2 === 31 && d1 >= 30) d2 = 30;
    }
    return (
        (b.getUTCFullYear() - a.getUTCFullYear()) * 360 + (b.getUTCMonth() - a.getUTCMonth()) * 30 + (d2 - d1)
    );
}

// -------------------------------------------------------------------- Finance

/** The future-value equation's residual, the basis of PMT/PV/FV/NPER/RATE. */
function fvOf(rate: number, nper: number, pmt: number, pv: number, type: number): number {
    if (rate === 0) return -(pv + pmt * nper);
    const growth = (1 + rate) ** nper;
    return -(pv * growth + (pmt * (1 + rate * type) * (growth - 1)) / rate);
}

function pmtOf(rate: number, nper: number, pv: number, fv: number, type: number): number {
    if (rate === 0) return -(pv + fv) / nper;
    const growth = (1 + rate) ** nper;
    return -((pv * growth + fv) * rate) / ((1 + rate * type) * (growth - 1));
}

/** Newton's method on `f` with a numeric derivative; undefined when it does not converge. */
function solve(f: (x: number) => number, guess: number): number | undefined {
    let x = guess;
    for (let i = 0; i < 100; i++) {
        const y = f(x);
        if (Math.abs(y) < 1e-10) return x;
        const h = Math.max(1e-6, Math.abs(x) * 1e-6);
        const slope = (f(x + h) - f(x - h)) / (2 * h);
        if (!Number.isFinite(slope) || slope === 0) return undefined;
        const next = x - y / slope;
        if (!Number.isFinite(next)) return undefined;
        if (Math.abs(next - x) < 1e-12) return next;
        x = next;
    }
    return Math.abs(f(x)) < 1e-7 ? x : undefined;
}

function cashflows(value: Value): number[] | FormulaError {
    const out: number[] = [];
    for (const v of flatten([value])) {
        if (isError(v)) return v;
        if (typeof v === "number") out.push(v);
    }
    return out;
}

const npv = (rate: number, flows: number[]) =>
    flows.reduce((total, flow, i) => total + flow / (1 + rate) ** (i + 1), 0);

function xnpv(rate: number, flows: number[], dates: number[]): number {
    return flows.reduce((total, flow, i) => total + flow / (1 + rate) ** ((dates[i] - dates[0]) / 365), 0);
}

function cumulative(args: Value[], principal: boolean): Value {
    const xs = args.map((a) => toNumber(scalar(a)));
    const error = xs.find(isError);
    if (error) return error;
    const [rate, nper, pv, start, end, type] = xs as number[];
    if (
        rate <= 0 ||
        nper <= 0 ||
        pv <= 0 ||
        start < 1 ||
        end < start ||
        end > nper ||
        (type !== 0 && type !== 1)
    )
        return ERR("#NUM!");
    let total = 0;
    const pmt = pmtOf(rate, nper, pv, 0, type);
    for (let per = Math.ceil(start); per <= Math.floor(end); per++) {
        const interest = interestOf(rate, per, nper, pv, type);
        total += principal ? pmt - interest : interest;
    }
    return total;
}

/** The interest part of payment `per` (IPMT with fv = 0 semantics generalized). */
function interestOf(rate: number, per: number, nper: number, pv: number, type: number, fv = 0): number {
    const pmt = pmtOf(rate, nper, pv, fv, type);
    if (type === 1 && per === 1) return 0;
    const before = -fvOf(rate, per - 1, pmt, pv, type);
    const interest = -before * rate;
    return type === 1 ? interest / (1 + rate) : interest;
}

// -------------------------------------------------------------------- Engineering

function fromBase(base: number, digits: RegExp): Fn {
    return (args) => {
        const text = toText(scalar(args[0] ?? null));
        if (isError(text)) return text;
        const t = text.trim().toUpperCase();
        if (!digits.test(t) || t.length > 10) return ERR("#NUM!");
        const n = Number.parseInt(t, base);
        // Ten digits: two's complement negatives.
        return t.length === 10 && n >= base ** 10 / 2 ? n - base ** 10 : n;
    };
}

function toBase(base: number, min: number, max: number): Fn {
    return (args) => {
        const n = toNumber(scalar(args[0] ?? null));
        const places = args.length > 1 ? toNumber(scalar(args[1])) : 0;
        if (isError(n)) return n;
        if (isError(places)) return places;
        const v = Math.trunc(n);
        if (v < min || v > max) return ERR("#NUM!");
        const text = (v < 0 ? base ** 10 + v : v).toString(base).toUpperCase();
        if (places && text.length > places) return ERR("#NUM!");
        return v < 0 ? text : text.padStart(Math.trunc(places), "0");
    };
}

// -------------------------------------------------------------------- Library

const textOf = (args: Value[], i: number): string | FormulaError => toText(scalar(args[i] ?? null));

const MORE: Record<string, Fn> = {
    // Math & trig
    CEILING: numeric(1, (x, s = x > 0 ? 1 : -1) =>
        s === 0 ? 0 : x > 0 && s < 0 ? Number.NaN : Math.ceil(x / s) * s,
    ),
    "CEILING.MATH": numeric(1, (x, s = 1, mode = 0) => {
        const step = Math.abs(s) || 1;
        return x < 0 && mode !== 0 ? -Math.ceil(-x / step) * step : Math.ceil(x / step) * step;
    }),
    "CEILING.PRECISE": numeric(1, (x, s = 1) => Math.ceil(x / (Math.abs(s) || 1)) * (Math.abs(s) || 1)),
    FLOOR: numeric(1, (x, s = x > 0 ? 1 : -1) =>
        s === 0 ? ERR("#DIV/0!") : x > 0 && s < 0 ? Number.NaN : Math.floor(x / s) * s,
    ),
    "FLOOR.MATH": numeric(1, (x, s = 1, mode = 0) => {
        const step = Math.abs(s) || 1;
        return x < 0 && mode !== 0 ? -Math.floor(-x / step) * step : Math.floor(x / step) * step;
    }),
    "FLOOR.PRECISE": numeric(1, (x, s = 1) => Math.floor(x / (Math.abs(s) || 1)) * (Math.abs(s) || 1)),
    MROUND: numeric(2, (x, m) => (m === 0 ? 0 : x * m < 0 ? Number.NaN : round(x / m, 0, "half") * m)),
    EVEN: numeric(1, (x) => {
        const n = Math.ceil(Math.abs(x) / 2) * 2;
        return x < 0 ? -n : n;
    }),
    ODD: numeric(1, (x) => {
        let n = Math.ceil(Math.abs(x));
        if (n % 2 === 0) n += 1;
        return x < 0 ? -n : n;
    }),
    FACT: numeric(1, (x) => {
        if (x < 0) return Number.NaN;
        let f = 1;
        for (let i = 2; i <= Math.trunc(x); i++) f *= i;
        return f;
    }),
    FACTDOUBLE: numeric(1, (x) => {
        if (x < -1) return Number.NaN;
        let f = 1;
        for (let i = Math.trunc(x); i > 1; i -= 2) f *= i;
        return f;
    }),
    COMBIN: numeric(2, (n, k) => {
        n = Math.trunc(n);
        k = Math.trunc(k);
        if (n < 0 || k < 0 || k > n) return Number.NaN;
        let c = 1;
        for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
        return Math.round(c);
    }),
    COMBINA: numeric(2, (n, k) => {
        n = Math.trunc(n);
        k = Math.trunc(k);
        if (n < 0 || k < 0) return Number.NaN;
        let c = 1;
        for (let i = 1; i <= k; i++) c = (c * (n + k - 1 - k + i)) / i;
        return Math.round(c);
    }),
    PERMUT: numeric(2, (n, k) => {
        n = Math.trunc(n);
        k = Math.trunc(k);
        if (n < 0 || k < 0 || k > n) return Number.NaN;
        let p = 1;
        for (let i = 0; i < k; i++) p *= n - i;
        return p;
    }),
    GCD: (args) => {
        const xs = numbers(args);
        if (isError(xs)) return xs;
        if (xs.some((x) => x < 0)) return ERR("#NUM!");
        const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
        return xs.map(Math.trunc).reduce(gcd, 0);
    },
    LCM: (args) => {
        const xs = numbers(args);
        if (isError(xs)) return xs;
        if (xs.some((x) => x < 0)) return ERR("#NUM!");
        const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
        return xs.map(Math.trunc).reduce((a, b) => (a === 0 || b === 0 ? 0 : (a * b) / gcd(a, b)), 1);
    },
    QUOTIENT: numeric(2, (a, b) => (b === 0 ? ERR("#DIV/0!") : Math.trunc(a / b))),
    RAND: () => Math.random(),
    RANDBETWEEN: numeric(2, (a, b) =>
        b < a ? Number.NaN : Math.floor(Math.ceil(a) + Math.random() * (Math.floor(b) - Math.ceil(a) + 1)),
    ),
    SUMSQ: stat((xs) => sum(xs.map((x) => x * x))),
    SINH: numeric(1, Math.sinh),
    COSH: numeric(1, Math.cosh),
    TANH: numeric(1, Math.tanh),
    ASINH: numeric(1, Math.asinh),
    ACOSH: numeric(1, Math.acosh),
    ATANH: numeric(1, Math.atanh),
    COT: numeric(1, (x) => (x === 0 ? ERR("#DIV/0!") : 1 / Math.tan(x))),
    SEC: numeric(1, (x) => 1 / Math.cos(x)),
    CSC: numeric(1, (x) => (x === 0 ? ERR("#DIV/0!") : 1 / Math.sin(x))),
    SQRTPI: numeric(1, (x) => (x < 0 ? Number.NaN : Math.sqrt(x * Math.PI))),
    BASE: (args) => {
        const n = toNumber(scalar(args[0] ?? null));
        const radix = toNumber(scalar(args[1] ?? null));
        const length = numberArg(args, 2, 0);
        if (isError(n)) return n;
        if (isError(radix)) return radix;
        if (isError(length)) return length;
        if (n < 0 || radix < 2 || radix > 36) return ERR("#NUM!");
        return Math.trunc(n).toString(Math.trunc(radix)).toUpperCase().padStart(Math.trunc(length), "0");
    },
    DECIMAL: (args) => {
        const text = textOf(args, 0);
        const radix = toNumber(scalar(args[1] ?? null));
        if (isError(text)) return text;
        if (isError(radix)) return radix;
        const n = Number.parseInt(text, Math.trunc(radix));
        return Number.isNaN(n) ? ERR("#NUM!") : n;
    },
    SUMX2MY2: (args) => sumPairs(args, (x, y) => x * x - y * y),
    SUMX2PY2: (args) => sumPairs(args, (x, y) => x * x + y * y),
    SUMXMY2: (args) => sumPairs(args, (x, y) => (x - y) ** 2),
    SUBTOTAL: (args) => {
        const code = toNumber(scalar(args[0] ?? null));
        if (isError(code)) return code;
        const fn = SUBTOTAL_FUNCTIONS[Math.trunc(code) % 100];
        return fn === undefined
            ? ERR("#VALUE!")
            : (LIBRARY[fn] ?? CORE_LOOKUP(fn))(args.slice(1), [], undefined as never);
    },
    AGGREGATE: (args) => {
        const code = toNumber(scalar(args[0] ?? null));
        const option = toNumber(scalar(args[1] ?? null));
        if (isError(code)) return code;
        if (isError(option)) return option;
        const fn = AGGREGATE_FUNCTIONS[Math.trunc(code)];
        if (fn === undefined) return ERR("#VALUE!");
        // Options 2, 3, 6, 7 ignore error values.
        const ignoreErrors = [2, 3, 6, 7].includes(Math.trunc(option));
        const cleaned = args
            .slice(2)
            .map((arg, i) =>
                i === 0 && ignoreErrors && Array.isArray(arg)
                    ? arg.map((row) => row.map((v) => (isError(v) ? null : v)))
                    : arg,
            );
        return (LIBRARY[fn] ?? CORE_LOOKUP(fn))(cleaned, [], undefined as never);
    },

    // Statistical
    AVERAGEA: (args) => {
        const xs = numbersA(args);
        return isError(xs) ? xs : xs.length === 0 ? ERR("#DIV/0!") : mean(xs);
    },
    MAXA: (args) => {
        const xs = numbersA(args);
        return isError(xs) ? xs : xs.length === 0 ? 0 : Math.max(...xs);
    },
    MINA: (args) => {
        const xs = numbersA(args);
        return isError(xs) ? xs : xs.length === 0 ? 0 : Math.min(...xs);
    },
    LARGE: (args) => {
        const input = listAndK(args);
        if (isError(input)) return input;
        const k = Math.ceil(input.k);
        if (k < 1 || k > input.list.length) return ERR("#NUM!");
        return [...input.list].sort((a, b) => b - a)[k - 1];
    },
    SMALL: (args) => {
        const input = listAndK(args);
        if (isError(input)) return input;
        const k = Math.ceil(input.k);
        if (k < 1 || k > input.list.length) return ERR("#NUM!");
        return [...input.list].sort((a, b) => a - b)[k - 1];
    },
    RANK: (args) => rank(args, false),
    "RANK.EQ": (args) => rank(args, false),
    "RANK.AVG": (args) => rank(args, true),
    STDEV: stat((xs) => sqrtOf(variance(xs, true))),
    "STDEV.S": stat((xs) => sqrtOf(variance(xs, true))),
    STDEVP: stat((xs) => sqrtOf(variance(xs, false))),
    "STDEV.P": stat((xs) => sqrtOf(variance(xs, false))),
    STDEVA: (args) => {
        const xs = numbersA(args);
        return isError(xs) ? xs : sqrtOf(variance(xs, true));
    },
    VAR: stat((xs) => variance(xs, true)),
    "VAR.S": stat((xs) => variance(xs, true)),
    VARP: stat((xs) => variance(xs, false)),
    "VAR.P": stat((xs) => variance(xs, false)),
    MODE: stat(mode),
    "MODE.SNGL": stat(mode),
    PERCENTILE: (args) => percentileFn(args, false),
    "PERCENTILE.INC": (args) => percentileFn(args, false),
    "PERCENTILE.EXC": (args) => percentileFn(args, true),
    QUARTILE: (args) => quartile(args, false),
    "QUARTILE.INC": (args) => quartile(args, false),
    "QUARTILE.EXC": (args) => quartile(args, true),
    PERCENTRANK: (args) => percentRank(args),
    "PERCENTRANK.INC": (args) => percentRank(args),
    GEOMEAN: stat((xs) =>
        xs.length === 0 || xs.some((x) => x <= 0) ? ERR("#NUM!") : Math.exp(mean(xs.map(Math.log))),
    ),
    HARMEAN: stat((xs) =>
        xs.length === 0 || xs.some((x) => x <= 0) ? ERR("#NUM!") : xs.length / sum(xs.map((x) => 1 / x)),
    ),
    AVEDEV: stat((xs) => {
        if (xs.length === 0) return ERR("#NUM!");
        const m = mean(xs);
        return mean(xs.map((x) => Math.abs(x - m)));
    }),
    DEVSQ: stat((xs) => {
        const m = xs.length ? mean(xs) : 0;
        return sum(xs.map((x) => (x - m) ** 2));
    }),
    CORREL: (args) => correlation(args),
    PEARSON: (args) => correlation(args),
    RSQ: (args) => {
        const r = correlation(args);
        return typeof r === "number" ? r * r : r;
    },
    "COVARIANCE.S": (args) => {
        const p = pairs(args);
        return isError(p) ? p : covariance(p.xs, p.ys, true);
    },
    "COVARIANCE.P": (args) => {
        const p = pairs(args);
        return isError(p) ? p : covariance(p.xs, p.ys, false);
    },
    COVAR: (args) => {
        const p = pairs(args);
        return isError(p) ? p : covariance(p.xs, p.ys, false);
    },
    SLOPE: (args) => {
        const p = pairs(args);
        if (isError(p)) return p;
        const vx = variance(p.ys, false);
        if (isError(vx) || vx === 0) return ERR("#DIV/0!");
        const c = covariance(p.ys, p.xs, false);
        return isError(c) ? c : c / vx;
    },
    INTERCEPT: (args) => {
        const p = pairs(args);
        if (isError(p)) return p;
        const vx = variance(p.ys, false);
        if (isError(vx) || vx === 0) return ERR("#DIV/0!");
        const c = covariance(p.ys, p.xs, false);
        return isError(c) ? c : mean(p.xs) - (c / vx) * mean(p.ys);
    },
    FORECAST: (args) => forecast(args),
    "FORECAST.LINEAR": (args) => forecast(args),
    STANDARDIZE: numeric(3, (x, m, s) => (s <= 0 ? Number.NaN : (x - m) / s)),
    "NORM.DIST": (args) => {
        const xs = args.slice(0, 3).map((a) => toNumber(scalar(a)));
        const cumulativeArg = toBoolean(scalar(args[3] ?? null));
        const error = xs.find(isError) ?? (isError(cumulativeArg) ? cumulativeArg : undefined);
        if (error) return error;
        const [x, m, s] = xs as number[];
        if (s <= 0) return ERR("#NUM!");
        const z = (x - m) / s;
        return cumulativeArg ? normCdf(z) : Math.exp(-(z * z) / 2) / (s * Math.sqrt(2 * Math.PI));
    },
    NORMDIST: (args) => MORE["NORM.DIST"](args, [], undefined as never),
    "NORM.S.DIST": (args) => {
        const z = toNumber(scalar(args[0] ?? null));
        const cumulativeArg = args.length > 1 ? toBoolean(scalar(args[1])) : true;
        if (isError(z)) return z;
        if (isError(cumulativeArg)) return cumulativeArg;
        return cumulativeArg ? normCdf(z) : Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
    },
    NORMSDIST: numeric(1, normCdf),
    "NORM.INV": numeric(3, (p, m, s) => (p <= 0 || p >= 1 || s <= 0 ? Number.NaN : m + s * normInv(p))),
    NORMINV: numeric(3, (p, m, s) => (p <= 0 || p >= 1 || s <= 0 ? Number.NaN : m + s * normInv(p))),
    "NORM.S.INV": numeric(1, (p) => (p <= 0 || p >= 1 ? Number.NaN : normInv(p))),
    NORMSINV: numeric(1, (p) => (p <= 0 || p >= 1 ? Number.NaN : normInv(p))),
    COUNTUNIQUE: (args) =>
        new Set(
            flatten(args)
                .filter((v) => v !== null && v !== "")
                .map((v) => (typeof v === "string" ? v.toLowerCase() : String(v))),
        ).size,

    // Logical / information
    ISERR: (args) => {
        const v = scalar(args[0] ?? null);
        return isError(v) && v.code !== "#N/A";
    },
    ISLOGICAL: (args) => typeof scalar(args[0] ?? null) === "boolean",
    ISNONTEXT: (args) => typeof scalar(args[0] ?? null) !== "string",
    ISEVEN: numeric(1, (x) => (Math.trunc(x) % 2 === 0 ? 1 : 0)),
    ISODD: numeric(1, (x) => (Math.abs(Math.trunc(x)) % 2 === 1 ? 1 : 0)),
    "ERROR.TYPE": (args) => {
        const v = scalar(args[0] ?? null);
        if (!isError(v)) return ERR("#N/A");
        const codes = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"];
        const i = codes.indexOf(v.code);
        return i < 0 ? (v.code === "#SPILL!" ? 9 : v.code === "#CALC!" ? 14 : ERR("#N/A")) : i + 1;
    },
    TYPE: (args) => {
        const v = args[0] ?? null;
        if (Array.isArray(v) && (v.length > 1 || (v[0]?.length ?? 0) > 1)) return 64;
        const s = scalar(v);
        return typeof s === "number" || s === null
            ? 1
            : typeof s === "string"
              ? 2
              : typeof s === "boolean"
                ? 4
                : 16;
    },
    N: (args) => {
        const v = scalar(args[0] ?? null);
        return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : isError(v) ? v : 0;
    },
    T: (args) => {
        const v = scalar(args[0] ?? null);
        return typeof v === "string" ? v : isError(v) ? v : "";
    },
    HYPERLINK: (args) => {
        const link = scalar(args[0] ?? null);
        return args.length > 1 ? scalar(args[1]) : link;
    },

    // Text
    CHAR: (args) => {
        const n = toNumber(scalar(args[0] ?? null));
        if (isError(n)) return n;
        return n < 1 || n > 255
            ? ERR("#VALUE!")
            : new TextDecoder("windows-1252").decode(new Uint8Array([Math.trunc(n)]));
    },
    CODE: (args) => {
        const text = textOf(args, 0);
        if (isError(text)) return text;
        if (text === "") return ERR("#VALUE!");
        const code = text.charCodeAt(0);
        return code < 128 ? code : (CP1252.get(text[0]) ?? 63);
    },
    UNICHAR: (args) => {
        const n = toNumber(scalar(args[0] ?? null));
        if (isError(n)) return n;
        return n < 1 || n > 0x10ffff ? ERR("#VALUE!") : String.fromCodePoint(Math.trunc(n));
    },
    UNICODE: (args) => {
        const text = textOf(args, 0);
        if (isError(text)) return text;
        return text === "" ? ERR("#VALUE!") : (text.codePointAt(0) ?? 0);
    },
    REPLACE: (args) => {
        const text = textOf(args, 0);
        const start = toNumber(scalar(args[1] ?? null));
        const count = toNumber(scalar(args[2] ?? null));
        const insert = textOf(args, 3);
        for (const v of [text, start, count, insert]) if (isError(v)) return v;
        if ((start as number) < 1 || (count as number) < 0) return ERR("#VALUE!");
        const s = Math.trunc(start as number) - 1;
        return (
            (text as string).slice(0, s) +
            (insert as string) +
            (text as string).slice(s + Math.trunc(count as number))
        );
    },
    FIXED: (args) => {
        const x = toNumber(scalar(args[0] ?? null));
        const digits = numberArg(args, 1, 2);
        const noCommas = args.length > 2 ? toBoolean(scalar(args[2])) : false;
        if (isError(x)) return x;
        if (isError(digits)) return digits;
        if (isError(noCommas)) return noCommas;
        const d = Math.trunc(digits);
        const rounded = round(x, d, "half");
        return rounded.toLocaleString("en-US", {
            minimumFractionDigits: Math.max(0, d),
            maximumFractionDigits: Math.max(0, d),
            useGrouping: !noCommas,
        });
    },
    DOLLAR: (args) => {
        const x = toNumber(scalar(args[0] ?? null));
        const digits = numberArg(args, 1, 2);
        if (isError(x)) return x;
        if (isError(digits)) return digits;
        const d = Math.max(0, Math.trunc(digits));
        return formatCellValue(
            round(x, Math.trunc(digits), "half"),
            `$#,##0${d ? `.${"0".repeat(d)}` : ""};($#,##0${d ? `.${"0".repeat(d)}` : ""})`,
        );
    },
    NUMBERVALUE: (args) => {
        const text = textOf(args, 0);
        const decimal = args.length > 1 ? textOf(args, 1) : ".";
        const group = args.length > 2 ? textOf(args, 2) : ",";
        for (const v of [text, decimal, group]) if (isError(v)) return v;
        let t = (text as string).replace(/\s/g, "");
        if (group) t = t.split(group as string).join("");
        if (decimal !== ".") t = t.split(decimal as string).join(".");
        const percent = (t.match(/%/g) ?? []).length;
        const n = Number(t.replace(/%/g, ""));
        return t === "" ? 0 : Number.isFinite(n) ? n / 100 ** percent : ERR("#VALUE!");
    },
    TEXTBEFORE: (args) => textAround(args, true),
    TEXTAFTER: (args) => textAround(args, false),
    TEXTSPLIT: (args) => {
        const text = textOf(args, 0);
        if (isError(text)) return text;
        const delimiters = (value: Value | undefined) =>
            value === undefined || scalar(value) === null
                ? []
                : flatten([value])
                      .map((v) => toText(v))
                      .filter((v): v is string => !isError(v) && v !== "");
        const cols = delimiters(args[1]);
        const rows = delimiters(args[2]);
        const ignoreEmpty = args.length > 3 ? toBoolean(scalar(args[3])) : false;
        const insensitive = args.length > 4 ? toNumber(scalar(args[4])) === 1 : false;
        if (isError(ignoreEmpty)) return ignoreEmpty;
        const split = (s: string, by: string[]) => {
            if (by.length === 0) return [s];
            const pattern = new RegExp(
                by.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
                insensitive ? "gi" : "g",
            );
            const parts = s.split(pattern);
            return ignoreEmpty ? parts.filter((p) => p !== "") : parts;
        };
        const lines = split(text, rows).map((line) => split(line, cols));
        const width = Math.max(...lines.map((l) => l.length));
        const pad = args.length > 5 ? scalar(args[5]) : ERR("#N/A");
        const out: Scalar[][] = lines.map((l) =>
            Array.from({ length: width }, (_, i) => (i < l.length ? l[i] : pad)),
        );
        return out.length === 1 && out[0].length === 1 ? out[0][0] : out;
    },
    ARRAYTOTEXT: (args) => {
        const strict = numberArg(args, 1, 0);
        if (isError(strict)) return strict;
        const array = matrix(args[0] ?? null);
        const show = (v: Scalar) =>
            isError(v) ? v.code : typeof v === "string" && strict ? `"${v}"` : (toText(v) as string);
        return strict
            ? `{${array.map((row) => row.map(show).join(",")).join(";")}}`
            : array.flatMap((row) => row.map(show)).join(", ");
    },
    VALUETOTEXT: (args) => {
        const v = scalar(args[0] ?? null);
        const strict = numberArg(args, 1, 0);
        if (isError(strict)) return strict;
        if (isError(v)) return v.code;
        return typeof v === "string" && strict ? `"${v}"` : (toText(v) as string);
    },
    REGEXTEST: (args) => regex(args, (re, text) => re.test(text)),
    REGEXEXTRACT: (args) => regex(args, (re, text) => re.exec(text)?.[0] ?? ERR("#N/A")),
    REGEXREPLACE: (args) => {
        const replacement = textOf(args, 2);
        if (isError(replacement)) return replacement;
        return regex(
            args,
            (re, text) =>
                text.replace(new RegExp(re.source, `${re.flags}g`), replacement.replace(/\$(\d)/g, "$$$1")),
            3,
        );
    },

    // Date & time
    WEEKDAY: (args) => {
        const n = toNumber(scalar(args[0] ?? null));
        const type = numberArg(args, 1, 1);
        if (isError(n)) return n;
        if (isError(type)) return type;
        const day = weekday(n); // 1 = Sunday
        const t = Math.trunc(type);
        if (t === 1 || t === 17) return day;
        if (t === 2 || t === 11) return ((day + 5) % 7) + 1;
        if (t === 3) return (day + 5) % 7;
        if (t >= 12 && t <= 16) return ((day - (t - 10) + 7) % 7) + 1;
        return ERR("#NUM!");
    },
    WEEKNUM: (args) => {
        const n = toNumber(scalar(args[0] ?? null));
        const type = numberArg(args, 1, 1);
        if (isError(n)) return n;
        if (isError(type)) return type;
        if (Math.trunc(type) === 21) return isoWeek(n);
        const start = Math.trunc(type) === 2 || Math.trunc(type) === 11 ? 2 : 1;
        const d = serialDate(toDay(n));
        const jan1 = excelSerial(Date.UTC(d.getUTCFullYear(), 0, 1));
        const offset = (weekday(jan1) - start + 7) % 7;
        return Math.floor((toDay(n) - jan1 + offset) / 7) + 1;
    },
    ISOWEEKNUM: numeric(1, isoWeek),
    NETWORKDAYS: (args) => networkDays(scalar(args[0] ?? null), scalar(args[1] ?? null), null, args[2]),
    "NETWORKDAYS.INTL": (args) =>
        networkDays(scalar(args[0] ?? null), scalar(args[1] ?? null), scalar(args[2] ?? null), args[3]),
    WORKDAY: (args) => workday(scalar(args[0] ?? null), scalar(args[1] ?? null), null, args[2]),
    "WORKDAY.INTL": (args) =>
        workday(scalar(args[0] ?? null), scalar(args[1] ?? null), scalar(args[2] ?? null), args[3]),
    DATEDIF: (args) => {
        const start = toNumber(scalar(args[0] ?? null));
        const end = toNumber(scalar(args[1] ?? null));
        const unit = textOf(args, 2);
        if (isError(start)) return start;
        if (isError(end)) return end;
        if (isError(unit)) return unit;
        if (start > end) return ERR("#NUM!");
        const a = serialDate(toDay(start));
        const b = serialDate(toDay(end));
        let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
        if (b.getUTCDate() < a.getUTCDate()) months--;
        switch (unit.toUpperCase()) {
            case "Y":
                return Math.floor(months / 12);
            case "M":
                return months;
            case "D":
                return toDay(end) - toDay(start);
            case "YM":
                return months % 12;
            case "MD": {
                const day = b.getUTCDate() - a.getUTCDate();
                return day >= 0
                    ? day
                    : new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate() + day;
            }
            case "YD": {
                const shifted = new Date(Date.UTC(b.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
                if (shifted.getTime() > b.getTime()) shifted.setUTCFullYear(b.getUTCFullYear() - 1);
                return Math.round((b.getTime() - shifted.getTime()) / 86400000);
            }
            default:
                return ERR("#NUM!");
        }
    },
    DATEVALUE: (args) => {
        const v = scalar(args[0] ?? null);
        if (typeof v === "number") return toDay(v);
        const text = toText(v);
        if (isError(text)) return text;
        const serial = parseDateText(text);
        return serial === undefined ? ERR("#VALUE!") : toDay(serial);
    },
    TIMEVALUE: (args) => {
        const text = textOf(args, 0);
        if (isError(text)) return text;
        const time =
            parseTimeText(text) ??
            ((): number | undefined => {
                const serial = parseDateText(text);
                return serial === undefined ? undefined : serial - toDay(serial);
            })();
        return time === undefined ? ERR("#VALUE!") : time;
    },
    YEARFRAC: (args) => {
        const start = toNumber(scalar(args[0] ?? null));
        const end = toNumber(scalar(args[1] ?? null));
        const basis = numberArg(args, 2, 0);
        if (isError(start)) return start;
        if (isError(end)) return end;
        if (isError(basis)) return basis;
        const [a, b] = start <= end ? [start, end] : [end, start];
        switch (Math.trunc(basis)) {
            case 0:
                return days360(a, b, false) / 360;
            case 1: {
                const ya = serialDate(toDay(a)).getUTCFullYear();
                const yb = serialDate(toDay(b)).getUTCFullYear();
                let days = 0;
                for (let y = ya; y <= yb; y++)
                    days += y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 366 : 365;
                return (toDay(b) - toDay(a)) / (days / (yb - ya + 1));
            }
            case 2:
                return (toDay(b) - toDay(a)) / 360;
            case 3:
                return (toDay(b) - toDay(a)) / 365;
            case 4:
                return days360(a, b, true) / 360;
            default:
                return ERR("#NUM!");
        }
    },
    DAYS360: (args) => {
        const start = toNumber(scalar(args[0] ?? null));
        const end = toNumber(scalar(args[1] ?? null));
        const european = args.length > 2 ? toBoolean(scalar(args[2])) : false;
        if (isError(start)) return start;
        if (isError(end)) return end;
        if (isError(european)) return european;
        return days360(start, end, european);
    },

    // Financial
    PMT: numeric(3, (rate, nper, pv, fv = 0, type = 0) =>
        nper === 0 ? Number.NaN : pmtOf(rate, nper, pv, fv, type ? 1 : 0),
    ),
    FV: numeric(3, (rate, nper, pmt, pv = 0, type = 0) => fvOf(rate, nper, pmt, pv, type ? 1 : 0)),
    PV: numeric(3, (rate, nper, pmt, fv = 0, type = 0) => {
        const t = type ? 1 : 0;
        if (rate === 0) return -(fv + pmt * nper);
        const growth = (1 + rate) ** nper;
        return -(fv + (pmt * (1 + rate * t) * (growth - 1)) / rate) / growth;
    }),
    NPER: numeric(3, (rate, pmt, pv, fv = 0, type = 0) => {
        const t = type ? 1 : 0;
        if (rate === 0) return pmt === 0 ? Number.NaN : -(pv + fv) / pmt;
        const a = pmt * (1 + rate * t) - fv * rate;
        const b = pv * rate + pmt * (1 + rate * t);
        return Math.log(a / b) / Math.log(1 + rate);
    }),
    RATE: numeric(3, (nper, pmt, pv, fv = 0, type = 0, guess = 0.1) => {
        const rate = solve((r) => fvOf(r, nper, pmt, pv, type ? 1 : 0) - fv, guess);
        return rate === undefined ? Number.NaN : rate;
    }),
    IPMT: numeric(4, (rate, per, nper, pv, fv = 0, type = 0) =>
        per < 1 || per > nper ? Number.NaN : interestOf(rate, per, nper, pv, type ? 1 : 0, fv),
    ),
    PPMT: numeric(4, (rate, per, nper, pv, fv = 0, type = 0) =>
        per < 1 || per > nper
            ? Number.NaN
            : pmtOf(rate, nper, pv, fv, type ? 1 : 0) - interestOf(rate, per, nper, pv, type ? 1 : 0, fv),
    ),
    CUMIPMT: (args) => cumulative(args, false),
    CUMPRINC: (args) => cumulative(args, true),
    NPV: (args) => {
        const rate = toNumber(scalar(args[0] ?? null));
        if (isError(rate)) return rate;
        const flows = cashflows(flatten(args.slice(1)).map((v) => [v]));
        if (isError(flows)) return flows;
        return rate === -1 ? ERR("#DIV/0!") : npv(rate, flows);
    },
    XNPV: (args) => {
        const rate = toNumber(scalar(args[0] ?? null));
        if (isError(rate)) return rate;
        const flows = cashflows(args[1] ?? null);
        const dates = cashflows(args[2] ?? null);
        if (isError(flows)) return flows;
        if (isError(dates)) return dates;
        return flows.length !== dates.length ? ERR("#NUM!") : xnpv(rate, flows, dates);
    },
    IRR: (args) => {
        const flows = cashflows(args[0] ?? null);
        const guess = numberArg(args, 1, 0.1);
        if (isError(flows)) return flows;
        if (isError(guess)) return guess;
        if (!flows.some((f) => f > 0) || !flows.some((f) => f < 0)) return ERR("#NUM!");
        const rate = solve((r) => flows.reduce((t, f, i) => t + f / (1 + r) ** i, 0), guess);
        return rate === undefined ? ERR("#NUM!") : rate;
    },
    XIRR: (args) => {
        const flows = cashflows(args[0] ?? null);
        const dates = cashflows(args[1] ?? null);
        const guess = numberArg(args, 2, 0.1);
        if (isError(flows)) return flows;
        if (isError(dates)) return dates;
        if (isError(guess)) return guess;
        if (flows.length !== dates.length || !flows.some((f) => f > 0) || !flows.some((f) => f < 0))
            return ERR("#NUM!");
        const rate = solve((r) => xnpv(r, flows, dates), guess);
        return rate === undefined ? ERR("#NUM!") : rate;
    },
    MIRR: (args) => {
        const flows = cashflows(args[0] ?? null);
        const finance = toNumber(scalar(args[1] ?? null));
        const reinvest = toNumber(scalar(args[2] ?? null));
        if (isError(flows)) return flows;
        if (isError(finance)) return finance;
        if (isError(reinvest)) return reinvest;
        const n = flows.length;
        const positive = flows.reduce((t, f, i) => t + (f > 0 ? f * (1 + reinvest) ** (n - 1 - i) : 0), 0);
        const negative = flows.reduce((t, f, i) => t + (f < 0 ? f / (1 + finance) ** i : 0), 0);
        if (positive === 0 || negative === 0) return ERR("#DIV/0!");
        return (-positive / negative) ** (1 / (n - 1)) - 1;
    },
    SLN: numeric(3, (cost, salvage, life) => (life === 0 ? ERR("#DIV/0!") : (cost - salvage) / life)),
    SYD: numeric(4, (cost, salvage, life, per) =>
        per < 1 || per > life ? Number.NaN : ((cost - salvage) * (life - per + 1) * 2) / (life * (life + 1)),
    ),
    DDB: numeric(4, (cost, salvage, life, per, factor = 2) => {
        if (per < 1 || per > life) return Number.NaN;
        let value = cost;
        let depreciation = 0;
        for (let p = 1; p <= per; p++) {
            depreciation = Math.min(value * (factor / life), Math.max(0, value - salvage));
            value -= depreciation;
        }
        return depreciation;
    }),
    DB: numeric(4, (cost, salvage, life, per, month = 12) => {
        if (cost <= 0 || life <= 0 || per < 1 || per > life + 1) return Number.NaN;
        const rate = Math.round((1 - (salvage / cost) ** (1 / life)) * 1000) / 1000;
        let total = (cost * rate * month) / 12;
        if (per === 1) return total;
        let depreciation = 0;
        for (let p = 2; p <= per; p++) {
            depreciation =
                p === life + 1 ? ((cost - total) * rate * (12 - month)) / 12 : (cost - total) * rate;
            total += depreciation;
        }
        return depreciation;
    }),
    EFFECT: numeric(2, (rate, n) =>
        rate <= 0 || n < 1 ? Number.NaN : (1 + rate / Math.trunc(n)) ** Math.trunc(n) - 1,
    ),
    NOMINAL: numeric(2, (rate, n) =>
        rate <= 0 || n < 1 ? Number.NaN : Math.trunc(n) * ((1 + rate) ** (1 / Math.trunc(n)) - 1),
    ),
    FVSCHEDULE: (args) => {
        const principal = toNumber(scalar(args[0] ?? null));
        if (isError(principal)) return principal;
        const rates = cashflows(args[1] ?? null);
        return isError(rates) ? rates : rates.reduce((value, r) => value * (1 + r), principal);
    },
    PDURATION: numeric(3, (rate, pv, fv) =>
        rate <= 0 || pv <= 0 || fv <= 0 ? Number.NaN : Math.log(fv / pv) / Math.log(1 + rate),
    ),
    RRI: numeric(3, (n, pv, fv) => (n <= 0 || pv === 0 ? Number.NaN : (fv / pv) ** (1 / n) - 1)),

    // Engineering
    BIN2DEC: fromBase(2, /^[01]+$/),
    OCT2DEC: fromBase(8, /^[0-7]+$/),
    HEX2DEC: fromBase(16, /^[0-9A-F]+$/),
    DEC2BIN: toBase(2, -512, 511),
    DEC2OCT: toBase(8, -536870912, 536870911),
    DEC2HEX: toBase(16, -549755813888, 549755813887),
    DELTA: numeric(1, (a, b = 0) => (a === b ? 1 : 0)),
    GESTEP: numeric(1, (a, step = 0) => (a >= step ? 1 : 0)),
};

/** The core functions SUBTOTAL/AGGREGATE delegate to; set by `formula.ts`. */
let CORE_LOOKUP: (name: string) => Fn = () => () => ERR("#VALUE!");
export function setCoreFunctions(lookup: (name: string) => Fn | undefined): void {
    CORE_LOOKUP = (name) => lookup(name) ?? (() => ERR("#VALUE!"));
}

const SUBTOTAL_FUNCTIONS: Record<number, string> = {
    1: "AVERAGE",
    2: "COUNT",
    3: "COUNTA",
    4: "MAX",
    5: "MIN",
    6: "PRODUCT",
    7: "STDEV.S",
    8: "STDEV.P",
    9: "SUM",
    10: "VAR.S",
    11: "VAR.P",
};
const AGGREGATE_FUNCTIONS: Record<number, string> = {
    ...SUBTOTAL_FUNCTIONS,
    12: "MEDIAN",
    13: "MODE.SNGL",
    14: "LARGE",
    15: "SMALL",
    16: "PERCENTILE.INC",
    17: "QUARTILE.INC",
    18: "PERCENTILE.EXC",
    19: "QUARTILE.EXC",
};

const CP1252 = new Map(
    [
        ...new TextDecoder("windows-1252").decode(
            new Uint8Array(Array.from({ length: 128 }, (_, i) => i + 128)),
        ),
    ].map((c, i) => [c, i + 128]),
);

function sqrtOf(v: NumberOrError): NumberOrError {
    return isError(v) ? v : Math.sqrt(v);
}

function sumPairs(args: Value[], f: (x: number, y: number) => number): Value {
    const p = pairs(args);
    return isError(p) ? p : sum(p.xs.map((x, i) => f(x, p.ys[i])));
}

function mode(xs: number[]): NumberOrError {
    const counts = new Map<number, number>();
    let best: number | undefined;
    let bestCount = 1;
    for (const x of xs) {
        const n = (counts.get(x) ?? 0) + 1;
        counts.set(x, n);
        if (n > bestCount) {
            best = x;
            bestCount = n;
        }
    }
    return best === undefined ? ERR("#N/A") : best;
}

function rank(args: Value[], average: boolean): Value {
    const x = toNumber(scalar(args[0] ?? null));
    const list = numbers([args[1] ?? null]);
    const order = numberArg(args, 2, 0);
    if (isError(x)) return x;
    if (isError(list)) return list;
    if (isError(order)) return order;
    const better = list.filter((v) => (order ? v < x : v > x)).length;
    const ties = list.filter((v) => v === x).length;
    if (ties === 0) return ERR("#N/A");
    return average ? better + (ties + 1) / 2 : better + 1;
}

function percentileFn(args: Value[], exclusive: boolean): Value {
    const input = listAndK(args);
    return isError(input) ? input : percentile(input.list, input.k, exclusive);
}

function quartile(args: Value[], exclusive: boolean): Value {
    const input = listAndK(args);
    if (isError(input)) return input;
    const q = Math.trunc(input.k);
    if (q < (exclusive ? 1 : 0) || q > (exclusive ? 3 : 4)) return ERR("#NUM!");
    return percentile(input.list, q / 4, exclusive);
}

function percentRank(args: Value[]): Value {
    const input = listAndK(args);
    if (isError(input)) return input;
    const digits = numberArg(args, 2, 3);
    if (isError(digits)) return digits;
    const sorted = [...input.list].sort((a, b) => a - b);
    const x = input.k;
    if (sorted.length === 0 || x < sorted[0] || x > sorted[sorted.length - 1]) return ERR("#N/A");
    const below = sorted.filter((v) => v < x).length;
    let position = below;
    if (sorted[below] !== x) {
        const lo = sorted[below - 1];
        const hi = sorted[below];
        position = below - 1 + (x - lo) / (hi - lo);
    }
    const factor = 10 ** Math.trunc(digits);
    return Math.floor((position / (sorted.length - 1)) * factor) / factor;
}

function correlation(args: Value[]): NumberOrError {
    const p = pairs(args);
    if (isError(p)) return p;
    const c = covariance(p.xs, p.ys, false);
    const vx = variance(p.xs, false);
    const vy = variance(p.ys, false);
    if (isError(c) || isError(vx) || isError(vy) || vx === 0 || vy === 0) return ERR("#DIV/0!");
    return c / Math.sqrt(vx * vy);
}

function forecast(args: Value[]): Value {
    const x = toNumber(scalar(args[0] ?? null));
    if (isError(x)) return x;
    const p = pairs([args[1] ?? null, args[2] ?? null]);
    if (isError(p)) return p;
    // pairs(known_y, known_x): xs are the y values, ys the x values.
    const vx = variance(p.ys, false);
    if (isError(vx) || vx === 0) return ERR("#DIV/0!");
    const c = covariance(p.ys, p.xs, false);
    if (isError(c)) return c;
    const slope = c / vx;
    return mean(p.xs) + slope * (x - mean(p.ys));
}

function isoWeek(serial: number): number {
    const d = serialDate(toDay(serial));
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - day + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    return (
        1 +
        Math.round(
            ((target.getTime() - firstThursday.getTime()) / 86400000 -
                3 +
                ((firstThursday.getUTCDay() + 6) % 7)) /
                7,
        )
    );
}

function textAround(args: Value[], before: boolean): Value {
    const text = textOf(args, 0);
    if (isError(text)) return text;
    const delimiters = flatten([args[1] ?? null]).map(toText);
    const bad = delimiters.find(isError);
    if (bad) return bad;
    const instance = numberArg(args, 2, 1);
    const insensitive = numberArg(args, 3, 0);
    const matchEnd = numberArg(args, 4, 0);
    if (isError(instance)) return instance;
    if (isError(insensitive)) return insensitive;
    if (isError(matchEnd)) return matchEnd;
    const n = Math.trunc(instance);
    if (n === 0) return ERR("#VALUE!");
    const hay = insensitive ? text.toLowerCase() : text;
    const needles = (delimiters as string[]).map((d) => (insensitive ? d.toLowerCase() : d));
    const positions: { at: number; length: number }[] = [];
    for (let i = 0; i < hay.length; i++) {
        const needle = needles.find((d) => d !== "" && hay.startsWith(d, i));
        if (needle !== undefined) positions.push({ at: i, length: needle.length });
    }
    if (needles.includes("")) positions.unshift({ at: 0, length: 0 });
    const pick = n > 0 ? positions[n - 1] : positions[positions.length + n];
    if (pick === undefined) {
        if (matchEnd) return n > 0 ? (before ? text : "") : before ? "" : text;
        return args.length > 5 ? (args[5] ?? null) : ERR("#N/A");
    }
    return before ? text.slice(0, pick.at) : text.slice(pick.at + pick.length);
}

function regex(args: Value[], f: (re: RegExp, text: string) => Scalar, flagsAt = 2): Value {
    const text = textOf(args, 0);
    const pattern = textOf(args, 1);
    if (isError(text)) return text;
    if (isError(pattern)) return pattern;
    const insensitive = args.length > flagsAt ? toNumber(scalar(args[flagsAt])) === 1 : false;
    try {
        return f(new RegExp(pattern, insensitive ? "i" : ""), text);
    } catch {
        return ERR("#VALUE!");
    }
}

export const LIBRARY: Record<string, Fn> = { ...ARRAY_FUNCTIONS, ...MORE };

/**
 * Per-value functions: given an array argument the evaluator applies them to each element
 * (LEN(A2:A9), MONTH(Dates), ROUND(Prices, 2)), broadcasting rows and columns.
 */
export const ELEMENTWISE = new Set([
    // core math / text / dates / information (formula.ts)
    "ABS",
    "SQRT",
    "INT",
    "EXP",
    "LN",
    "LOG10",
    "SIN",
    "COS",
    "TAN",
    "ASIN",
    "ACOS",
    "ATAN",
    "RADIANS",
    "DEGREES",
    "SIGN",
    "ATAN2",
    "LOG",
    "POWER",
    "MOD",
    "ROUND",
    "ROUNDUP",
    "ROUNDDOWN",
    "TRUNC",
    "NOT",
    "LEN",
    "UPPER",
    "LOWER",
    "TRIM",
    "LEFT",
    "RIGHT",
    "MID",
    "CLEAN",
    "PROPER",
    "EXACT",
    "TEXT",
    "VALUE",
    "SUBSTITUTE",
    "REPT",
    "FIND",
    "SEARCH",
    "DATE",
    "TIME",
    "YEAR",
    "MONTH",
    "DAY",
    "HOUR",
    "MINUTE",
    "SECOND",
    "EDATE",
    "EOMONTH",
    "DAYS",
    "ISNUMBER",
    "ISTEXT",
    "ISBLANK",
    "ISERROR",
    "ISNA",
    // library
    "CEILING",
    "CEILING.MATH",
    "CEILING.PRECISE",
    "FLOOR",
    "FLOOR.MATH",
    "FLOOR.PRECISE",
    "MROUND",
    "EVEN",
    "ODD",
    "FACT",
    "FACTDOUBLE",
    "COMBIN",
    "COMBINA",
    "PERMUT",
    "QUOTIENT",
    "SINH",
    "COSH",
    "TANH",
    "ASINH",
    "ACOSH",
    "ATANH",
    "COT",
    "SEC",
    "CSC",
    "SQRTPI",
    "BASE",
    "DECIMAL",
    "ISERR",
    "ISLOGICAL",
    "ISNONTEXT",
    "ISEVEN",
    "ISODD",
    "ERROR.TYPE",
    "N",
    "T",
    "CHAR",
    "CODE",
    "UNICHAR",
    "UNICODE",
    "REPLACE",
    "FIXED",
    "DOLLAR",
    "NUMBERVALUE",
    "WEEKDAY",
    "WEEKNUM",
    "ISOWEEKNUM",
    "DATEDIF",
    "DATEVALUE",
    "TIMEVALUE",
    "YEARFRAC",
    "DAYS360",
    "PMT",
    "FV",
    "PV",
    "NPER",
    "IPMT",
    "PPMT",
    "SLN",
    "SYD",
    "DDB",
    "DB",
    "EFFECT",
    "NOMINAL",
    "PDURATION",
    "RRI",
    "BIN2DEC",
    "OCT2DEC",
    "HEX2DEC",
    "DEC2BIN",
    "DEC2OCT",
    "DEC2HEX",
    "DELTA",
    "GESTEP",
    "STANDARDIZE",
    "NORM.S.DIST",
    "NORMSDIST",
    "NORM.INV",
    "NORMINV",
    "NORM.S.INV",
    "NORMSINV",
    "REGEXTEST",
    "REGEXEXTRACT",
    "REGEXREPLACE",
    "VALUETOTEXT",
]);
