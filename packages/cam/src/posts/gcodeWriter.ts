// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The shared G-code writer every post builds on — mills, 2D cutting, wire EDM here, and
 * the 5-axis and printer posts of the other CAM modules: number formatting per controller,
 * modal suppression (motion group, plane, feed, unchanged coordinates), optional line
 * numbers, and the comment style. It knows nothing of toolpaths; posts decide what to say,
 * the writer decides how it is spelled.
 */

/** How a controller spells numbers. */
export interface NumberFormat {
    /** Digits after the decimal point (rounded). */
    readonly decimals: number;
    /** Always write a decimal point: `10.` (Fanuc, Haas) rather than `10`. */
    readonly forceDecimal?: boolean;
    /** Keep trailing zeros (`10.000`); trimmed by default (`10.`, `10`, `1.5`). */
    readonly trailingZeros?: boolean;
    /** `0.5` (default) or `.5`. */
    readonly leadingZero?: boolean;
}

/** Fanuc-style coordinates: three decimals, trimmed, always a point (`X10.`, `X-0.25`). */
export const FANUC_FORMAT: NumberFormat = { decimals: 3, forceDecimal: true };
/** Plain trimmed coordinates (`X10`, `X1.5`): LinuxCNC, GRBL, most hobby controllers. */
export const PLAIN_FORMAT: NumberFormat = { decimals: 3 };
/** Whole numbers: spindle speeds, tool numbers, milliseconds. */
export const INTEGER_FORMAT: NumberFormat = { decimals: 0 };

/** `value` spelled per `format`; never `-0`. */
export function formatGCodeNumber(value: number, format: NumberFormat): string {
    if (!Number.isFinite(value)) throw new Error(`G-code: cannot write the number ${value}`);
    let text = Math.abs(value).toFixed(Math.max(0, format.decimals));
    const negative = value < 0 && Number(text) !== 0;
    if (!format.trailingZeros && text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
    if (format.forceDecimal && !text.includes(".")) text += ".";
    if (format.leadingZero === false && text.startsWith("0.") && text.length > 2) text = text.slice(1);
    return negative ? `-${text}` : text;
}

export type CommentStyle = "parens" | "semicolon" | "none";

export interface LineNumberOptions {
    readonly start: number;
    readonly increment: number;
    /** Wraps back to `start` past this (Fanuc: N99999). */
    readonly max?: number;
}

export interface GCodeWriterOptions {
    /** Coordinates (X Y Z U V I J K R …). */
    readonly format: NumberFormat;
    /** Feeds; the coordinate format with one decimal when absent. */
    readonly feedFormat?: NumberFormat;
    /** Spindle speeds and powers; whole numbers when absent. */
    readonly spindleFormat?: NumberFormat;
    /** `N` words on motion and code blocks (not on comment lines); off when absent. */
    readonly lineNumbers?: LineNumberOptions | false;
    readonly comments?: CommentStyle;
    /** Fanuc and Haas reject lower case in comments on some controls. */
    readonly uppercaseComments?: boolean;
    readonly newline?: string;
}

/** Axis words the writer tracks modally. */
export type AxisLetter = "X" | "Y" | "Z" | "U" | "V" | "W" | "A" | "B" | "C" | "E";

/** One word of a block: a ready string, or nothing (dropped). */
export type Word = string | undefined | false;

/**
 * Accumulates a program. `block(...)` writes one line from its non-empty words (numbered
 * when line numbers are on); the `*Word` helpers return a word only when it changes the
 * controller's modal state, so a post writes `writer.block(writer.motion("G1"),
 * writer.axis("X", x), writer.feed(f))` and gets `X10.` alone on the second line of a run.
 */
export class GCodeWriter {
    readonly options: GCodeWriterOptions;
    private readonly lines: string[] = [];
    private readonly modal = new Map<string, string>();
    private readonly axes = new Map<AxisLetter, string>();
    private lastFeed: string | undefined;
    private lineNumber: number;

    constructor(options: GCodeWriterOptions) {
        this.options = options;
        this.lineNumber = options.lineNumbers ? options.lineNumbers.start : 0;
    }

    /** A coordinate value, formatted. */
    num(value: number): string {
        return formatGCodeNumber(value, this.options.format);
    }

    feedNum(value: number): string {
        return formatGCodeNumber(value, this.options.feedFormat ?? { ...this.options.format, decimals: 1 });
    }

    spindleNum(value: number): string {
        return formatGCodeNumber(value, this.options.spindleFormat ?? INTEGER_FORMAT);
    }

    /** Writes one block of the non-empty words; nothing when every word is empty. */
    block(...words: Word[]): void {
        const text = words
            .filter((word): word is string => typeof word === "string" && word !== "")
            .join(" ");
        if (text === "") return;
        this.lines.push(this.numbered(text));
    }

    /** A comment on its own line (never numbered), in the controller's comment style. */
    comment(text: string): void {
        const spelled = this.commentText(text);
        if (spelled !== undefined) this.lines.push(spelled);
    }

    /** A comment spelled for appending to a block, or undefined when comments are off. */
    commentText(text: string): string | undefined {
        const style = this.options.comments ?? "parens";
        if (style === "none") return undefined;
        let clean = text
            .replace(/[()]/g, "")
            .replace(/[\r\n]+/g, " ")
            .trim();
        if (this.options.uppercaseComments) clean = clean.toUpperCase();
        if (clean === "") return undefined;
        return style === "parens" ? `(${clean})` : `; ${clean}`;
    }

    /** A line written verbatim: `%`, a program number, a pass-through code. */
    raw(text: string): void {
        for (const line of text.split(/\r?\n/)) this.lines.push(line);
    }

    /** The word `code` of modal `group` (motion, plane, cycle, …) when it changes, else nothing. */
    modalWord(group: string, code: string): string | undefined {
        if (this.modal.get(group) === code) return undefined;
        this.modal.set(group, code);
        return code;
    }

    /** The motion group word: G0 G1 G2 G3, a cycle code — written when it changes. */
    motion(code: string): string | undefined {
        return this.modalWord("motion", code);
    }

    /** Forgets a modal group, so its next word is written again (after G80, a tool change). */
    resetModal(group: string): void {
        this.modal.delete(group);
    }

    /** The coordinate word when the formatted value changes, or always with `force`. */
    axis(letter: AxisLetter, value: number | undefined, force = false): string | undefined {
        if (value === undefined) return undefined;
        const formatted = this.num(value);
        if (!force && this.axes.get(letter) === formatted) return undefined;
        this.axes.set(letter, formatted);
        return `${letter}${formatted}`;
    }

    /** Forgets the coordinates, so the next words are all written (after G28, a cycle, G92). */
    forgetAxes(...letters: AxisLetter[]): void {
        if (letters.length === 0) this.axes.clear();
        for (const letter of letters) this.axes.delete(letter);
    }

    /** Records an axis value the controller now holds without writing it (a G92 preset). */
    setAxis(letter: AxisLetter, value: number): void {
        this.axes.set(letter, this.num(value));
    }

    /** `F<feed>` when it changes. */
    feed(value: number | undefined): string | undefined {
        if (value === undefined) return undefined;
        const formatted = this.feedNum(value);
        if (this.lastFeed === formatted) return undefined;
        this.lastFeed = formatted;
        return `F${formatted}`;
    }

    forgetFeed(): void {
        this.lastFeed = undefined;
    }

    /** A non-modal word: `I1.5`, `R2.`, `Q1.`. */
    word(letter: string, value: number): string {
        return `${letter}${this.num(value)}`;
    }

    get lineCount(): number {
        return this.lines.length;
    }

    toString(): string {
        const newline = this.options.newline ?? "\n";
        return this.lines.join(newline) + newline;
    }

    private numbered(text: string): string {
        const numbers = this.options.lineNumbers;
        if (!numbers) return text;
        const n = this.lineNumber;
        this.lineNumber += numbers.increment;
        if (numbers.max !== undefined && this.lineNumber > numbers.max) this.lineNumber = numbers.start;
        return `N${n} ${text}`;
    }
}

/** Reads a typed option, falling back when it is missing or of another type. */
export function optionOf<T extends string | number | boolean>(
    options: Readonly<Record<string, unknown>> | undefined,
    key: string,
    fallback: T,
): Widen<T> {
    const value = options?.[key];
    return (typeof value === typeof fallback ? value : fallback) as Widen<T>;
}

type Widen<T> = T extends string ? string : T extends number ? number : boolean;
