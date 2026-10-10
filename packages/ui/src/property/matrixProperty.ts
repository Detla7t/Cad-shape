// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    Config,
    documentUnit,
    formatDocumentValue,
    type GroupNode,
    type IConverter,
    type IDocument,
    LENGTH_UNITS,
    Matrix4,
    PubSub,
    Result,
    UNITLESS,
    type UnitSpec,
    unitSpecEquals,
    unitSuffix,
    type VisualNode,
    type XYZLike,
} from "@chili3d/core";
import { InputProperty } from "./input";
import { PropertyBase } from "./propertyBase";

/**
 * The Matrix rows of the properties panel: translation, scale and rotation of the first
 * selected node, written in the document's units and precision (Preferences ▸ Units, the
 * decimal comma) and re-rendered when those change. Edits apply to every selected node.
 */
export class MatrixProperty extends PropertyBase {
    readonly first: VisualNode | GroupNode;

    constructor(
        readonly document: IDocument,
        geometries: (VisualNode | GroupNode)[],
        className: string,
    ) {
        super(geometries);
        this.first = geometries[0];
        this.className = className;
        this.render();
    }

    private render() {
        this.replaceChildren(
            new InputProperty(this.document, [this.first], {
                name: "transform",
                display: "transform.translation",
                converter: new TranslationConverter(this.first, this.document),
            }),
            new InputProperty(this.document, [this.first], {
                name: "transform",
                display: "transform.scale",
                converter: new ScalingConverter(this.first, this.document),
            }),
            new InputProperty(this.document, [this.first], {
                name: "transform",
                display: "transform.rotation",
                converter: new RotateConverter(this.first, this.document),
            }),
        );
    }

    private readonly onPropertyChanged = (property: keyof (VisualNode | GroupNode)) => {
        if (property === "transform") {
            this.objects.forEach((obj) => {
                if (obj === this.first) return;
                obj.transform = this.first.transform;
            });
        }
    };

    private readonly onUnitsChanged = (document: IDocument) => {
        if (document === this.document) this.render();
    };

    private readonly onConfigChanged = (property: keyof Config) => {
        if (property === "preferences") this.render();
    };

    connectedCallback() {
        (this.first as VisualNode).onPropertyChanged(this.onPropertyChanged);
        PubSub.default.sub("documentUnitsChanged", this.onUnitsChanged);
        Config.instance.onPropertyChanged(this.onConfigChanged);
    }

    disconnectedCallback() {
        (this.first as VisualNode).removePropertyChanged(this.onPropertyChanged);
        PubSub.default.remove("documentUnitsChanged", this.onUnitsChanged);
        Config.instance.removePropertyChanged(this.onConfigChanged);
    }
}

customElements.define("matrix-property", MatrixProperty);

/**
 * Three components in the document's unit and precision: `10.00, 20.00, 30.00 mm`,
 * `90.0, 0.0, 0.0°`, `1.00, 1.00, 1.00`. With the decimal comma preference the components are
 * separated by semicolons (`1,50; 2,50; 3,50 mm`). Input accepts either separator (commas
 * cannot separate with the decimal comma), and a unit named at the end — `1, 2, 3 in` — takes
 * over from the document's unit.
 */
export function formatMatrixComponents(
    values: readonly [number, number, number],
    document: IDocument,
    unit: UnitSpec,
): string {
    const parts = values.map((value) => formatDocumentValue(value, document, unit, false));
    const text = parts.join(Config.instance.preferences.decimalComma ? "; " : ", ");
    const { suffix } = documentUnit(document, unit);
    if (suffix === "") return text;
    return suffix === "deg" ? `${text}°` : `${text} ${suffix}`;
}

/** The three numbers of `text` in model units (millimetres, degrees); see `formatMatrixComponents`. */
export function parseMatrixComponents(
    text: string,
    document: IDocument,
    unit: UnitSpec,
): Result<XYZLike, string> {
    const decimalComma = Config.instance.preferences.decimalComma;
    let body = text.trim();
    let factor = documentUnit(document, unit).factor;
    const named = /([a-zA-Zµ°]+)\s*$/.exec(body);
    if (named !== null) {
        const known = unitSuffix(named[1]);
        if (known !== undefined && unitSpecEquals(known.unit, unit)) {
            factor = known.factor;
            body = body.slice(0, named.index).trim();
        }
    }
    const numbers = body
        .split(decimalComma ? /[;\s]+/ : /[,;\s]+/)
        .filter((part) => part !== "")
        .map((part) => Number(decimalComma ? part.replace(",", ".") : part));
    if (numbers.length !== 3 || numbers.some((value) => !Number.isFinite(value))) {
        return Result.err("invalid number of values");
    }
    return Result.ok({ x: numbers[0] * factor, y: numbers[1] * factor, z: numbers[2] * factor });
}

export abstract class MatrixConverter implements IConverter<Matrix4, string> {
    constructor(
        readonly geometry: VisualNode | GroupNode,
        readonly document: IDocument,
        readonly unit: UnitSpec,
    ) {}

    convert(value: Matrix4): Result<string, string> {
        return Result.ok(formatMatrixComponents(this.convertFrom(value), this.document, this.unit));
    }

    /** The components in model units: millimetres, degrees, or plain factors. */
    protected abstract convertFrom(value: Matrix4): [number, number, number];
    protected abstract convertTo(values: XYZLike): Matrix4;

    convertBack(value: string): Result<Matrix4, string> {
        const parsed = parseMatrixComponents(value, this.document, this.unit);
        if (!parsed.isOk) return Result.err(parsed.error);
        return Result.ok(this.convertTo(parsed.value));
    }
}

export class TranslationConverter extends MatrixConverter {
    constructor(geometry: VisualNode | GroupNode, document: IDocument) {
        super(geometry, document, LENGTH_UNITS);
    }
    protected convertFrom(matrix: Matrix4): [number, number, number] {
        const position = matrix.translationPart();
        return [position.x, position.y, position.z];
    }
    protected convertTo(values: XYZLike): Matrix4 {
        const rotation = this.geometry.transform.getEulerAngles();
        const scale = this.geometry.transform.getScale();
        return Matrix4.createFromTRS(values, rotation, scale);
    }
}

export class ScalingConverter extends MatrixConverter {
    constructor(geometry: VisualNode | GroupNode, document: IDocument) {
        super(geometry, document, UNITLESS);
    }
    protected convertFrom(matrix: Matrix4): [number, number, number] {
        const s = matrix.getScale();
        return [s.x, s.y, s.z];
    }
    protected convertTo(values: XYZLike): Matrix4 {
        const rotation = this.geometry.transform.getEulerAngles();
        const translation = this.geometry.transform.translationPart();
        return Matrix4.createFromTRS(translation, rotation, values);
    }
}

export class RotateConverter extends MatrixConverter {
    constructor(geometry: VisualNode | GroupNode, document: IDocument) {
        super(geometry, document, ANGLE_UNITS);
    }
    protected convertFrom(matrix: Matrix4): [number, number, number] {
        const s = matrix.getEulerAngles();
        return [(s.pitch * 180) / Math.PI, (s.yaw * 180) / Math.PI, (s.roll * 180) / Math.PI];
    }
    protected convertTo(values: XYZLike): Matrix4 {
        const scale = this.geometry.transform.getScale();
        const translation = this.geometry.transform.translationPart();
        return Matrix4.createFromTRS(
            translation,
            {
                pitch: (values.x * Math.PI) / 180,
                yaw: (values.y * Math.PI) / 180,
                roll: (values.z * Math.PI) / 180,
            },
            scale,
        );
    }
}
