// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { type IConverter, Result } from "../foundation";
import { I18n, type I18nKeys } from "../i18n";
import { BoundingBox, XYZ } from "../math";
import { formatDocumentValue } from "../parameters/documentUnits";
import { LENGTH_UNITS } from "../parameters/unitSpec";
import { property } from "../property";
import { serializable, serialize } from "../serialize";
import { Combobox } from "../ui";
import { Annotation } from "./annotation";
import type { INode } from "./node";

/**
 * Model-based definition (ASME Y14.41 / ISO 16792) annotations: the notes, dimensions,
 * feature control frames and datum feature symbols of a drawing, placed in the 3D scene.
 * Each is a plain node anchored to a point on the model (`anchor`) with its text frame at
 * `position`; the renderer draws the leader, terminator and frame, always facing the camera.
 */
export const PmiKinds = ["note", "flag", "dimension", "gdt", "datum"] as const;
export type PmiKind = (typeof PmiKinds)[number];

/** What a leader ends with on the model: an arrowhead (edges), a dot (faces) or nothing. */
export const PmiTerminators = ["arrow", "dot", "none"] as const;
export type PmiTerminator = (typeof PmiTerminators)[number];

export const PmiDimensionTypes = ["linear", "diameter", "radius"] as const;
export type PmiDimensionType = (typeof PmiDimensionTypes)[number];

/** The symbols of ASME Y14.5 dimensioning that are not geometric characteristics. */
export const PMI_SYMBOLS = Object.freeze({
    diameter: "⌀",
    radius: "R",
    sphericalDiameter: "S⌀",
    plusMinus: "±",
    degree: "°",
    depth: "↧",
    counterbore: "⌴",
    countersink: "⌵",
    mmc: "Ⓜ",
    lmc: "Ⓛ",
    freeState: "Ⓕ",
    projected: "Ⓟ",
    tangentPlane: "Ⓣ",
    unequal: "Ⓤ",
});

export interface GdtSymbol {
    readonly symbol: string;
    readonly name: I18nKeys;
}

/** The fourteen geometric characteristic symbols of ASME Y14.5-2018, in the table's order. */
export const GDT_SYMBOLS: readonly GdtSymbol[] = Object.freeze([
    { symbol: "⏤", name: "gdt.straightness" },
    { symbol: "⏥", name: "gdt.flatness" },
    { symbol: "○", name: "gdt.circularity" },
    { symbol: "⌭", name: "gdt.cylindricity" },
    { symbol: "⌒", name: "gdt.profileLine" },
    { symbol: "⌓", name: "gdt.profileSurface" },
    { symbol: "∠", name: "gdt.angularity" },
    { symbol: "⟂", name: "gdt.perpendicularity" },
    { symbol: "∥", name: "gdt.parallelism" },
    { symbol: "⌖", name: "gdt.position" },
    { symbol: "◎", name: "gdt.concentricity" },
    { symbol: "⌯", name: "gdt.symmetry" },
    { symbol: "↗", name: "gdt.circularRunout" },
    { symbol: "⌰", name: "gdt.totalRunout" },
]);

/** A symbol reads "⌖ Position" in the combobox; the stored value stays the bare symbol. */
export class GdtSymbolConverter implements IConverter<string> {
    convert(value: string): Result<string> {
        const symbol = GDT_SYMBOLS.find((item) => item.symbol === value);
        return Result.ok(symbol === undefined ? value : `${symbol.symbol}  ${I18n.translate(symbol.name)}`);
    }

    convertBack(value: string): Result<string> {
        const trimmed = value.trim();
        const symbol =
            GDT_SYMBOLS.find((item) => item.symbol === trimmed) ??
            GDT_SYMBOLS.find((item) => trimmed.startsWith(item.symbol)) ??
            GDT_SYMBOLS.find((item) => I18n.translate(item.name).toLowerCase() === trimmed.toLowerCase());
        return symbol === undefined
            ? Result.err(`unknown geometric characteristic: ${value}`)
            : Result.ok(symbol.symbol);
    }
}

class TerminatorConverter implements IConverter<PmiTerminator> {
    convert(value: PmiTerminator): Result<string> {
        return Result.ok(I18n.translate(`annotation.terminator.${value}` as I18nKeys));
    }
    convertBack(value: string): Result<PmiTerminator> {
        const found = PmiTerminators.find((item) => item === value);
        return found === undefined ? Result.err(`unknown terminator ${value}`) : Result.ok(found);
    }
}

const gdtSymbolCombobox = Combobox.from(
    GDT_SYMBOLS.map((item) => item.symbol),
    new GdtSymbolConverter(),
);
const terminatorCombobox = Combobox.from([...PmiTerminators], new TerminatorConverter());

export interface PmiAnnotationOptions {
    document: IDocument;
    name?: string;
    id?: string;
    color?: number;
    visible?: boolean;
    /** The point on the model the annotation refers to (leader tip, dimension start, datum base). */
    anchor: XYZ;
    /** Where the text frame sits in the scene. */
    position: XYZ;
    /** A locked annotation cannot be dragged in the viewport. */
    locked?: boolean;
    /** The frame's text size in pixels (`PMI_TEXT_SIZE` by default). */
    textSize?: number;
    /** The leader and dimension lines' width in pixels (`PMI_LINE_WIDTH` by default). */
    lineWidth?: number;
}

/** The default text size of a frame, in pixels. */
export const PMI_TEXT_SIZE = 15;
/** The default width of an annotation's lines, in pixels. */
export const PMI_LINE_WIDTH = 1;

export abstract class PmiAnnotation extends Annotation {
    declare readonly annotationType: "pmi";
    abstract readonly kind: PmiKind;

    @serialize()
    @property("annotation.anchor")
    get anchor(): XYZ {
        return this.getPrivateValue("anchor");
    }
    set anchor(value: XYZ) {
        this.setProperty("anchor", value);
    }

    @serialize()
    @property("annotation.position")
    get position(): XYZ {
        return this.getPrivateValue("position");
    }
    set position(value: XYZ) {
        this.setProperty("position", value);
    }

    /** Locked: the frame stays where it is when dragged. */
    @serialize()
    @property("annotation.locked")
    get locked(): boolean {
        return this.getPrivateValue("locked");
    }
    set locked(value: boolean) {
        this.setProperty("locked", value);
    }

    /** The frame's text size in pixels. */
    @serialize()
    @property("annotation.textSize")
    get textSize(): number {
        return this.getPrivateValue("textSize");
    }
    set textSize(value: number) {
        this.setProperty("textSize", Math.max(6, Math.min(72, Number(value) || PMI_TEXT_SIZE)));
    }

    /** The width of the leader and dimension lines in pixels. */
    @serialize()
    @property("annotation.lineWidth")
    get lineWidth(): number {
        return this.getPrivateValue("lineWidth");
    }
    set lineWidth(value: number) {
        this.setProperty("lineWidth", Math.max(0.5, Math.min(8, Number(value) || PMI_LINE_WIDTH)));
    }

    constructor(options: PmiAnnotationOptions, defaultName: string) {
        super({
            document: options.document,
            annotationType: "pmi",
            name: options.name ?? defaultName,
            id: options.id,
            color: options.color ?? 0x3b2f8f,
            visible: options.visible,
        });
        this.setPrivateValue("anchor", options.anchor);
        this.setPrivateValue("position", options.position);
        this.setPrivateValue("locked", options.locked ?? false);
        this.setPrivateValue("textSize", options.textSize ?? PMI_TEXT_SIZE);
        this.setPrivateValue("lineWidth", options.lineWidth ?? PMI_LINE_WIDTH);
    }

    /** The one-line reading of the annotation (what a flat drawing would print). */
    abstract text(): string;

    /** How the leader meets the model. Datum feature symbols always end in their triangle. */
    get terminator(): PmiTerminator {
        return "arrow";
    }

    /** True when a leader runs from the frame to the anchor. */
    get hasLeader(): boolean {
        return true;
    }

    get icon(): string {
        return "icon-annotation";
    }

    override display(): I18nKeys {
        return "annotation.pmi";
    }

    override boundingBox(): BoundingBox | undefined {
        return BoundingBox.fromPoints([this.anchor, this.position]);
    }
}

export interface PmiNoteOptions extends PmiAnnotationOptions {
    text: string;
    /** False for a general note: the text sits at `position` with no leader. */
    leader?: boolean;
    terminator?: PmiTerminator;
}

/** A leader note ("DEBURR ALL EDGES") or, without its leader, a general note block. */
@serializable({ id: "PmiNote" })
export class PmiNote extends PmiAnnotation {
    readonly kind = "note";

    @serialize()
    @property("annotation.text")
    get content(): string {
        return this.getPrivateValue("content");
    }
    set content(value: string) {
        this.setProperty("content", value);
    }

    @serialize()
    @property("annotation.leader")
    get leader(): boolean {
        return this.getPrivateValue("leader", true);
    }
    set leader(value: boolean) {
        this.setProperty("leader", value);
    }

    @serialize()
    @property("annotation.terminator", { combobox: terminatorCombobox })
    override get terminator(): PmiTerminator {
        return this.getPrivateValue("terminator", "dot");
    }
    override set terminator(value: PmiTerminator) {
        this.setProperty("terminator", value);
    }

    constructor(options: PmiNoteOptions) {
        super(options, "Note");
        this.setPrivateValue("content", options.text);
        if (options.leader !== undefined) this.setPrivateValue("leader", options.leader);
        if (options.terminator !== undefined) this.setPrivateValue("terminator", options.terminator);
    }

    override get hasLeader(): boolean {
        return this.leader;
    }

    override text(): string {
        return this.content;
    }

    /** The note's lines: real newlines or a typed `\n` both break a line. */
    lines(): string[] {
        return this.content.split(/\r?\n|\\n/).map((line) => line.trim());
    }
}

export interface PmiFlagOptions extends PmiAnnotationOptions {
    text: string;
    terminator?: PmiTerminator;
}

/** A flag note: a number in a hexagon that points at the feature its general note is about. */
@serializable({ id: "PmiFlag" })
export class PmiFlag extends PmiAnnotation {
    readonly kind = "flag";

    @serialize()
    @property("annotation.text")
    get content(): string {
        return this.getPrivateValue("content");
    }
    set content(value: string) {
        this.setProperty("content", value);
    }

    @serialize()
    @property("annotation.terminator", { combobox: terminatorCombobox })
    override get terminator(): PmiTerminator {
        return this.getPrivateValue("terminator", "arrow");
    }
    override set terminator(value: PmiTerminator) {
        this.setProperty("terminator", value);
    }

    constructor(options: PmiFlagOptions) {
        super(options, "Flag note");
        this.setPrivateValue("content", options.text);
        if (options.terminator !== undefined) this.setPrivateValue("terminator", options.terminator);
    }

    override text(): string {
        return this.content;
    }
}

export interface PmiDimensionOptions extends PmiAnnotationOptions {
    dimensionType?: PmiDimensionType;
    /** The measured size in millimetres (a diameter for `diameter`, a radius for `radius`). */
    value: number;
    /** Linear: the second measured point. */
    anchor2?: XYZ;
    /** Diameter and radius: the circle's axis; `anchor` is then its centre. */
    axis?: XYZ;
    prefix?: string;
    tolerance?: string;
    suffix?: string;
}

/**
 * A toleranced size: "3X ⌀5±0.05 ⌵10±0.1". Linear dimensions measure between `anchor` and
 * `anchor2` with their dimension line through `position`; diameters and radii lead from the
 * circle (centre `anchor`, normal `axis`) to the frame.
 */
@serializable({ id: "PmiDimension" })
export class PmiDimension extends PmiAnnotation {
    readonly kind = "dimension";

    @serialize()
    get dimensionType(): PmiDimensionType {
        return this.getPrivateValue("dimensionType", "linear");
    }
    set dimensionType(value: PmiDimensionType) {
        this.setProperty("dimensionType", value);
    }

    @serialize()
    @property("annotation.prefix")
    get prefix(): string {
        return this.getPrivateValue("prefix", "");
    }
    set prefix(value: string) {
        this.setProperty("prefix", value);
    }

    @serialize()
    @property("annotation.value")
    get value(): number {
        return this.getPrivateValue("value");
    }
    set value(value: number) {
        this.setProperty("value", value);
    }

    @serialize()
    @property("annotation.tolerance")
    get tolerance(): string {
        return this.getPrivateValue("tolerance", "");
    }
    set tolerance(value: string) {
        this.setProperty("tolerance", value);
    }

    @serialize()
    @property("annotation.suffix")
    get suffix(): string {
        return this.getPrivateValue("suffix", "");
    }
    set suffix(value: string) {
        this.setProperty("suffix", value);
    }

    @serialize()
    @property("annotation.anchor2")
    get anchor2(): XYZ {
        return this.getPrivateValue("anchor2", this.anchor);
    }
    set anchor2(value: XYZ) {
        this.setProperty("anchor2", value);
    }

    @serialize()
    get axis(): XYZ {
        return this.getPrivateValue("axis", XYZ.unitZ);
    }
    set axis(value: XYZ) {
        this.setProperty("axis", value);
    }

    constructor(options: PmiDimensionOptions) {
        super(options, "Dimension");
        this.setPrivateValue("value", options.value);
        if (options.dimensionType !== undefined) this.setPrivateValue("dimensionType", options.dimensionType);
        if (options.anchor2 !== undefined) this.setPrivateValue("anchor2", options.anchor2);
        if (options.axis !== undefined) this.setPrivateValue("axis", options.axis);
        if (options.prefix !== undefined) this.setPrivateValue("prefix", options.prefix);
        if (options.tolerance !== undefined) this.setPrivateValue("tolerance", options.tolerance);
        if (options.suffix !== undefined) this.setPrivateValue("suffix", options.suffix);
    }

    /** The size in the document's display units, without a unit suffix (the notes state it). */
    formattedValue(): string {
        return formatDocumentValue(this.value, this.document, LENGTH_UNITS, false);
    }

    override text(): string {
        const symbol =
            this.dimensionType === "diameter"
                ? PMI_SYMBOLS.diameter
                : this.dimensionType === "radius"
                  ? PMI_SYMBOLS.radius
                  : "";
        return [
            this.prefix.trim(),
            `${symbol}${this.formattedValue()}${this.tolerance.trim()}`,
            this.suffix.trim(),
        ]
            .filter((part) => part !== "")
            .join(" ");
    }

    override boundingBox(): BoundingBox | undefined {
        return BoundingBox.fromPoints([this.anchor, this.anchor2, this.position]);
    }
}

export interface PmiFeatureControlFrameOptions extends PmiAnnotationOptions {
    symbol?: string;
    tolerance?: string;
    modifier?: string;
    datums?: string;
    terminator?: PmiTerminator;
}

/** A feature control frame: geometric characteristic, tolerance (with modifiers) and datums. */
@serializable({ id: "PmiFeatureControlFrame" })
export class PmiFeatureControlFrame extends PmiAnnotation {
    readonly kind = "gdt";

    @serialize()
    @property("annotation.symbol", { combobox: gdtSymbolCombobox })
    get symbol(): string {
        return this.getPrivateValue("symbol", "⌖");
    }
    set symbol(value: string) {
        this.setProperty("symbol", value);
    }

    @serialize()
    @property("annotation.tolerance")
    get tolerance(): string {
        return this.getPrivateValue("tolerance", "");
    }
    set tolerance(value: string) {
        this.setProperty("tolerance", value);
    }

    @serialize()
    @property("annotation.modifier")
    get modifier(): string {
        return this.getPrivateValue("modifier", "");
    }
    set modifier(value: string) {
        this.setProperty("modifier", value);
    }

    @serialize()
    @property("annotation.datums")
    get datums(): string {
        return this.getPrivateValue("datums", "");
    }
    set datums(value: string) {
        this.setProperty("datums", value);
    }

    @serialize()
    @property("annotation.terminator", { combobox: terminatorCombobox })
    override get terminator(): PmiTerminator {
        return this.getPrivateValue("terminator", "dot");
    }
    override set terminator(value: PmiTerminator) {
        this.setProperty("terminator", value);
    }

    constructor(options: PmiFeatureControlFrameOptions) {
        super(options, "Feature control frame");
        if (options.symbol !== undefined) this.setPrivateValue("symbol", options.symbol);
        if (options.tolerance !== undefined) this.setPrivateValue("tolerance", options.tolerance);
        if (options.modifier !== undefined) this.setPrivateValue("modifier", options.modifier);
        if (options.datums !== undefined) this.setPrivateValue("datums", options.datums);
        if (options.terminator !== undefined) this.setPrivateValue("terminator", options.terminator);
    }

    /** The datum references in order, split on spaces, commas or bars ("A B", "A|B-C"). */
    datumList(): string[] {
        return this.datums
            .split(/[\s,|]+/)
            .map((datum) => datum.trim())
            .filter((datum) => datum !== "");
    }

    /** The frame's compartments, left to right. */
    cells(): string[] {
        const tolerance = [this.tolerance.trim(), this.modifier.trim()]
            .filter((part) => part !== "")
            .join(" ");
        return [this.symbol, tolerance, ...this.datumList()];
    }

    override text(): string {
        return this.cells().join(" | ");
    }
}

export interface PmiDatumOptions extends PmiAnnotationOptions {
    label: string;
}

/** A datum feature symbol: the boxed letter whose leader ends in a filled triangle on the feature. */
@serializable({ id: "PmiDatum" })
export class PmiDatum extends PmiAnnotation {
    readonly kind = "datum";

    @serialize()
    @property("annotation.datumLabel")
    get label(): string {
        return this.getPrivateValue("label");
    }
    set label(value: string) {
        this.setProperty("label", value);
    }

    constructor(options: PmiDatumOptions) {
        super(options, `Datum ${options.label}`);
        this.setPrivateValue("label", options.label);
    }

    override text(): string {
        return this.label;
    }
}

export function isPmiAnnotation(node: unknown): node is PmiAnnotation {
    return node instanceof PmiAnnotation;
}

/** ASME Y14.5 skips I, O and Q; after Z the labels double (AA, AB, …). */
export function datumLabelAt(index: number): string {
    const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
    const letter = letters[index % letters.length];
    return letter.repeat(Math.floor(index / letters.length) + 1);
}

/** The first unused datum label in the document. */
export function nextDatumLabel(document: IDocument): string {
    const used = new Set(
        document.modelManager
            .findNodes((node: INode) => node instanceof PmiDatum)
            .map((node) => (node as PmiDatum).label),
    );
    for (let index = 0; ; index++) {
        const label = datumLabelAt(index);
        if (!used.has(label)) return label;
    }
}

/** One past the highest flag number in the document. */
export function nextFlagNumber(document: IDocument): number {
    let highest = 0;
    for (const node of document.modelManager.findNodes((node: INode) => node instanceof PmiFlag)) {
        const value = Number((node as PmiFlag).content);
        if (Number.isInteger(value) && value > highest) highest = value;
    }
    return highest + 1;
}

export type PmiTerminatorShape = PmiTerminator | "triangle";

export interface PmiTerminatorPlacement {
    /** Where the terminator meets the model (arrow tip, dot centre, triangle base). */
    point: XYZ;
    /** The point the terminator's body extends toward (along the leader or dimension line). */
    toward: XYZ;
    shape: PmiTerminatorShape;
}

export interface PmiGeometry {
    /** Leader, extension and dimension lines, in world coordinates. */
    segments: [XYZ, XYZ][];
    /** Where the text frame is placed. */
    labelPoint: XYZ;
    /**
     * `leader`: the frame starts at the leader's end on the side away from the anchor;
     * `above`: the frame is centred above the point (a dimension line's text);
     * `start`: the frame's top-left corner sits on the point (a general note, a drawing's
     * note block).
     */
    labelAlign: "leader" | "above" | "start";
    /** The point the frame leads away from, for `leader` alignment. */
    labelFrom: XYZ;
    terminators: PmiTerminatorPlacement[];
}

/** A unit vector perpendicular to `axis`, preferring `hint`'s component in that plane. */
function perpendicular(axis: XYZ, hint: XYZ): XYZ {
    const n = axis.normalize() ?? XYZ.unitZ;
    const inPlane = hint.sub(n.multiply(hint.dot(n)));
    const unit = inPlane.normalize();
    if (unit !== undefined) return unit;
    const seed = Math.abs(n.x) < 0.9 ? XYZ.unitX : XYZ.unitY;
    return n.cross(seed).normalize() ?? XYZ.unitX;
}

/**
 * The lines and markers an annotation draws, from its anchors and frame position alone, so
 * the renderer and the drawing export share one definition of what each kind looks like.
 */
export function pmiGeometry(annotation: PmiAnnotation): PmiGeometry {
    const { anchor, position } = annotation;
    if (annotation instanceof PmiDimension) return dimensionGeometry(annotation);
    if (!annotation.hasLeader) {
        return {
            segments: [],
            labelPoint: position,
            labelAlign: "start",
            labelFrom: position,
            terminators: [],
        };
    }
    const shape: PmiTerminatorShape = annotation instanceof PmiDatum ? "triangle" : annotation.terminator;
    return {
        segments: [[anchor, position]],
        labelPoint: position,
        labelAlign: "leader",
        labelFrom: anchor,
        terminators: shape === "none" ? [] : [{ point: anchor, toward: position, shape }],
    };
}

function dimensionGeometry(dimension: PmiDimension): PmiGeometry {
    const { anchor, position } = dimension;
    if (dimension.dimensionType !== "linear") {
        const radius = dimension.dimensionType === "diameter" ? dimension.value / 2 : dimension.value;
        const direction = perpendicular(dimension.axis, position.sub(anchor));
        const onCircle = anchor.add(direction.multiply(radius));
        return {
            segments: [[onCircle, position]],
            labelPoint: position,
            labelAlign: "leader",
            labelFrom: onCircle,
            terminators: [{ point: onCircle, toward: position, shape: "arrow" }],
        };
    }
    const direction = dimension.anchor2.sub(anchor).normalize();
    if (direction === undefined) {
        return {
            segments: [[anchor, position]],
            labelPoint: position,
            labelAlign: "leader",
            labelFrom: anchor,
            terminators: [{ point: anchor, toward: position, shape: "arrow" }],
        };
    }
    const foot = (point: XYZ) => position.add(direction.multiply(point.sub(position).dot(direction)));
    const foot1 = foot(anchor);
    const foot2 = foot(dimension.anchor2);
    return {
        segments: [
            [anchor, foot1],
            [dimension.anchor2, foot2],
            [foot1, foot2],
        ],
        labelPoint: XYZ.center(foot1, foot2),
        labelAlign: "above",
        labelFrom: foot1,
        terminators: [
            { point: foot1, toward: foot2, shape: "arrow" },
            { point: foot2, toward: foot1, shape: "arrow" },
        ],
    };
}
