// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, defaultUserPreferences, type IDocument, Matrix4, setDocumentUnits } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, rs, test } from "@rstest/core";
import {
    MatrixProperty,
    parseMatrixComponents,
    RotateConverter,
    ScalingConverter,
    TranslationConverter,
} from "../src/property/matrixProperty";

/** A geometry with a real Matrix4 transform (getEulerAngles and getScale for convertBack). */
function createMockGeometry(transform?: Matrix4) {
    return { transform: transform ?? Matrix4.identity() };
}

/** A document with the default units: millimetres and degrees, 2 and 1 decimals. */
function mmDocument(displayUnits?: Record<string, unknown>): IDocument {
    return { userData: displayUnits ? { displayUnits } : {} } as unknown as IDocument;
}

const saved = Config.instance.preferences;
afterEach(() => {
    Config.instance.preferences = saved;
});

describe("TranslationConverter", () => {
    test("writes the translation in the document's length unit and precision", () => {
        const matrix = Matrix4.fromTranslation(10, 20, 30);
        const converter = new TranslationConverter(createMockGeometry(matrix) as any, mmDocument());
        const result = converter.convert(matrix);
        expect(result.isOk).toBe(true);
        expect(result.value).toBe("10.00, 20.00, 30.00 mm");

        const inches = new TranslationConverter(
            createMockGeometry(matrix) as any,
            mmDocument({ length: "in", lengthPrecision: 3 }),
        );
        expect(inches.convert(Matrix4.fromTranslation(25.4, -50.8, 0)).value).toBe("1.000, -2.000, 0.000 in");
    });

    test("the decimal comma preference writes commas and separates with semicolons", () => {
        Config.instance.preferences = { ...defaultUserPreferences(), decimalComma: true };
        const converter = new TranslationConverter(createMockGeometry() as any, mmDocument());
        expect(converter.convert(Matrix4.fromTranslation(1.5, 2, 3)).value).toBe("1,50; 2,00; 3,00 mm");
    });

    test("parses the components in the document's unit, or in the unit named at the end", () => {
        const converter = new TranslationConverter(createMockGeometry() as any, mmDocument());
        const parsed = converter.convertBack("10.5, 20.5, 30.5");
        expect(parsed.isOk).toBe(true);
        expect(parsed.value).toBeInstanceOf(Matrix4);
        expect(parsed.value.translationPart()).toMatchObject({ x: 10.5, y: 20.5, z: 30.5 });

        const inches = new TranslationConverter(
            createMockGeometry() as any,
            mmDocument({ length: "in", lengthPrecision: 3 }),
        );
        const named = inches.convertBack("1, 2, 3 in").value.translationPart();
        expect(named.x).toBeCloseTo(25.4);
        expect(named.y).toBeCloseTo(50.8);
        expect(named.z).toBeCloseTo(76.2);
        expect(inches.convertBack("1.000, 0.000, 0.000 in").value.translationPart().x).toBeCloseTo(25.4);
        // Bare numbers are inches too; a named millimetre takes over.
        expect(inches.convertBack("2, 0, 0").value.translationPart().x).toBeCloseTo(50.8);
        expect(inches.convertBack("2, 0, 0 mm").value.translationPart().x).toBeCloseTo(2);
    });

    test("preserves the geometry's rotation and scale", () => {
        const transform = Matrix4.fromEuler(0.5, 0.3, 0);
        const converter = new TranslationConverter(createMockGeometry(transform) as any, mmDocument());
        const result = converter.convertBack("10, 20, 30");
        expect(result.isOk).toBe(true);
        expect(result.value.getEulerAngles().pitch).toBeCloseTo(0.5);
        expect(result.value.translationPart()).toMatchObject({ x: 10, y: 20, z: 30 });
    });
});

describe("ScalingConverter", () => {
    test("writes plain factors with the length precision and parses them back", () => {
        const matrix = Matrix4.fromScale(2, 3, 4);
        const converter = new ScalingConverter(createMockGeometry(matrix) as any, mmDocument());
        expect(converter.convert(matrix).value).toBe("2.00, 3.00, 4.00");
        expect(converter.convert(Matrix4.identity()).value).toBe("1.00, 1.00, 1.00");
        const parsed = converter.convertBack("1.5, 2.5, 3.5");
        expect(parsed.isOk).toBe(true);
        expect(parsed.value.getScale()).toMatchObject({ x: 1.5, y: 2.5, z: 3.5 });
        // A unit makes no sense on a factor.
        expect(converter.convertBack("1, 2, 3 mm").isOk).toBe(false);
    });
});

describe("RotateConverter", () => {
    test("writes euler angles in the document's angle unit and precision", () => {
        const matrix = Matrix4.fromEuler(Math.PI / 6, Math.PI / 4, 0);
        const converter = new RotateConverter(createMockGeometry(matrix) as any, mmDocument());
        expect(converter.convert(matrix).value).toBe("30.0, 45.0, 0.0°");
        expect(converter.convert(Matrix4.fromEuler(-Math.PI / 4, 0, 0)).value).toBe("-45.0, 0.0, 0.0°");
        const radians = new RotateConverter(
            createMockGeometry(matrix) as any,
            mmDocument({ angle: "rad", anglePrecision: 3 }),
        );
        expect(radians.convert(matrix).value).toBe("0.524, 0.785, 0.000 rad");
    });

    test("parses degrees, radians and a named unit back into the matrix", () => {
        const converter = new RotateConverter(createMockGeometry() as any, mmDocument());
        const degrees = converter.convertBack("45, 30, 60");
        expect(degrees.isOk).toBe(true);
        expect(degrees.value.getEulerAngles().pitch).toBeCloseTo(Math.PI / 4);
        const radians = new RotateConverter(createMockGeometry() as any, mmDocument({ angle: "rad" }));
        expect(radians.convertBack("1.5708, 0, 0").value.getEulerAngles().pitch).toBeCloseTo(Math.PI / 2, 3);
        expect(radians.convertBack("90, 0, 0°").value.getEulerAngles().pitch).toBeCloseTo(Math.PI / 2);
    });
});

describe("parseMatrixComponents", () => {
    const parse = (text: string) => parseMatrixComponents(text, mmDocument(), { length: 1, angle: 0 });

    test.each([
        ["1, 2", "two numbers"],
        ["", "nothing"],
        ["a, b, c", "letters"],
        ["1, two, 3", "a word among numbers"],
        ["1, 2, 3, 4", "four numbers"],
        ["42", "one number"],
    ])("refuses %s (%s)", (text) => {
        const result = parse(text);
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("invalid number of values");
    });

    test("accepts commas, semicolons and spaces around the numbers", () => {
        expect(parse("  10  ,  20  ,  30  ").value).toEqual({ x: 10, y: 20, z: 30 });
        expect(parse("10; 20; 30").value).toEqual({ x: 10, y: 20, z: 30 });
        expect(parse("10 20 30 mm").value).toEqual({ x: 10, y: 20, z: 30 });
    });

    test("with the decimal comma, commas are decimals and semicolons separate", () => {
        Config.instance.preferences = { ...defaultUserPreferences(), decimalComma: true };
        expect(parse("1,5; 2; 3 mm").value).toEqual({ x: 1.5, y: 2, z: 3 });
        expect(parse("1,5 2,5 3,5").value).toEqual({ x: 1.5, y: 2.5, z: 3.5 });
    });
});

describe("MatrixProperty", () => {
    test("the rows follow the document's units and the decimal preference", () => {
        const storage = rs.spyOn(Config.instance, "saveToStorage").mockImplementation(() => {});
        Config.instance.preferences = defaultUserPreferences();
        const document = new TestDocument();
        const geometry = {
            transform: Matrix4.fromTranslation(25.4, 0, 0),
            onPropertyChanged: () => {},
            removePropertyChanged: () => {},
        };
        const property = new MatrixProperty(document, [geometry as any], "matrix");
        globalThis.document.body.append(property);
        const values = () => [...property.querySelectorAll("input")].map((input) => input.value);
        try {
            expect(values()).toEqual(["25.40, 0.00, 0.00 mm", "1.00, 1.00, 1.00", "0.0, 0.0, 0.0°"]);
            setDocumentUnits(document, { length: "in", angle: "rad", lengthPrecision: 3, anglePrecision: 2 });
            expect(values()).toEqual([
                "1.000, 0.000, 0.000 in",
                "1.000, 1.000, 1.000",
                "0.00, 0.00, 0.00 rad",
            ]);
            Config.instance.preferences = { ...Config.instance.preferences, decimalComma: true };
            expect(values()).toEqual([
                "1,000; 0,000; 0,000 in",
                "1,000; 1,000; 1,000",
                "0,00; 0,00; 0,00 rad",
            ]);
        } finally {
            property.remove();
            document.dispose();
            storage.mockRestore();
        }
    });
});
