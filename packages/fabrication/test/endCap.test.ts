// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readDxf } from "@chili3d/drawing";
import {
    DUCT_SIZES,
    defaultWallHeight,
    type EndCapParams,
    endCapDxf,
    endCapName,
    endCapPattern,
    flangeAllowance,
    formatFractionalInches,
    onshapeConfiguration,
    parseInches,
    presetEndCaps,
    type Segment,
    sameGeometry,
    toDrawing,
} from "../src";
import reference from "./fixtures/onshapeEndCaps.json";

interface FixtureCase {
    readonly file: string;
    readonly reducing: boolean;
    readonly od: number;
    readonly id: number | null;
    readonly entities: Segment[];
}

const fixtures = reference as unknown as { cases: FixtureCase[] };

function pattern(params: EndCapParams) {
    const result = endCapPattern(params);
    if (!result.isOk) throw new Error(result.error);
    return result.value;
}

const outline = (params: EndCapParams) => pattern(params).parts.flatMap((part) => [...part.outline]);

describe("end cap flat patterns", () => {
    test.each(fixtures.cases)("$file matches the Onshape export", (fixture) => {
        const params: EndCapParams = {
            reducing: fixture.reducing,
            od: fixture.od,
            id: fixture.id ?? undefined,
        };
        expect(sameGeometry(outline(params), fixture.entities)).toBe(true);
    });

    test("a moved edge no longer matches", () => {
        const reference = fixtures.cases[0];
        const moved = reference.entities.map((s, i) =>
            i === 0 && s.kind === "line" ? { ...s, b: [s.b[0] + 0.01, s.b[1]] as const } : s,
        );
        expect(sameGeometry(outline({ reducing: false, od: reference.od }), moved)).toBe(false);
    });

    test("a plain cap is two half discs, a reducing cap adds two collar strips", () => {
        expect(pattern({ reducing: false, od: 16 }).parts.map((p) => p.name)).toEqual([
            "Half",
            "Half with seam",
        ]);
        expect(pattern({ reducing: true, od: 16, id: 8.625 }).parts.map((p) => p.name)).toEqual([
            "Half",
            "Half with seam",
            "Collar",
            "Collar with lap",
        ]);
    });

    test("the flange allowance steps up with the duct size", () => {
        expect(DUCT_SIZES.map((size) => flangeAllowance(size.inches))).toEqual([
            0.375, 0.375, 0.375, 0.5, 0.5, 0.5, 0.5, 0.625, 0.625, 0.625, 0.625, 0.75, 0.75, 0.75, 0.75, 0.75,
            1, 1, 1, 1, 1, 1,
        ]);
        const rim = pattern({ reducing: false, od: 16 }).parts[0].bendLines[0];
        expect(rim).toEqual({ kind: "arc", center: [0, 0], radius: 8, startAngle: 180, endAngle: 0 });
    });

    test("the collar is the finish wall height plus 13/16 tall, and follows a custom wall height", () => {
        const height = (params: EndCapParams) => {
            const ys = pattern(params).parts[2].outline.flatMap((s) =>
                s.kind === "line" ? [s.a[1], s.b[1]] : [],
            );
            return Math.max(...ys) - Math.min(...ys);
        };
        expect(defaultWallHeight(6.625)).toBe(2.125);
        expect(defaultWallHeight(7.625)).toBe(2.875);
        expect(height({ reducing: true, od: 12.75, id: 5 })).toBeCloseTo(3.6875, 12);
        expect(height({ reducing: true, od: 12.75, id: 5, wallHeight: 4 })).toBeCloseTo(4.8125, 12);
    });

    test.each([
        [{ reducing: true, od: 10, id: 12 }, "smaller than the outside diameter"],
        [{ reducing: true, od: 10 }, "needs an inside diameter"],
        [{ reducing: false, od: 1.5 }, "over 2 in"],
        [{ reducing: true, od: 10, id: 6, wallHeight: 0.5 }, "at least 11/16"],
    ] satisfies [EndCapParams, string][])("%o is refused", (params, message) => {
        const result = endCapPattern(params);
        expect(result.isOk).toBe(false);
        expect(result.isOk ? "" : result.error).toContain(message);
    });
});

describe("end cap naming and presets", () => {
    test("sizes carry Onshape's labels and configuration ids", () => {
        expect(DUCT_SIZES.map((size) => size.label)).toEqual([
            '4"',
            '4 1/2"',
            '5"',
            '5 9/16"',
            '6 5/8"',
            '7 5/8"',
            '8 5/8"',
            '9 5/8"',
            '10 3/4"',
            '11 3/4"',
            '12 3/4"',
            '14"',
            '15"',
            '16"',
            '17"',
            '18"',
            '19"',
            '20"',
            '21"',
            '22"',
            '23"',
            '24"',
        ]);
        expect(onshapeConfiguration({ reducing: true, od: 9.625, id: 6.625 })).toBe(
            "Endcap=false;OD_Table=_9_5_8_;List_tBoS7KHF1hLsDf=_6_5_8_",
        );
        expect(onshapeConfiguration({ reducing: true, od: 5, id: 4.5 })).toBe(
            "Endcap=false;OD_Table=_5_;List_tBoS7KHF1hLsDf=Copy_of_4_",
        );
        expect(onshapeConfiguration({ reducing: false, od: 9.7 })).toBeUndefined();
    });

    test("file names follow the export profile's templates", () => {
        expect(endCapName({ reducing: false, od: 16 })).toBe("16in End Cap");
        expect(endCapName({ reducing: true, od: 9.625, id: 5.5625 })).toBe(
            "9.63in x 5.56in Reducing End Cap",
        );
    });

    test("the preset set is every size plus every smaller-inside-larger pair", () => {
        const caps = presetEndCaps();
        expect(caps).toHaveLength(22 + (22 * 21) / 2);
        expect(caps.every((cap) => endCapPattern(cap).isOk)).toBe(true);
    });

    test("inch text reads and writes the way a shop writes it", () => {
        expect(formatFractionalInches(5.5625)).toBe('5 9/16"');
        expect(formatFractionalInches(0.75)).toBe('3/4"');
        expect(parseInches("9 5/8")).toBe(9.625);
        expect(parseInches('9-5/8"')).toBe(9.625);
        expect(parseInches("3/4 in")).toBe(0.75);
        expect(parseInches("abc")).toBeUndefined();
    });
});

describe("end cap DXF", () => {
    test("is written in inches on Onshape's layer, bend lines only on request", () => {
        const file = endCapDxf({ reducing: true, od: 9.625, id: 6.625 });
        expect(file.isOk).toBe(true);
        const { name, text } = file.isOk ? file.value : { name: "", text: "" };
        expect(name).toBe("9.63in x 6.63in Reducing End Cap.dxf");
        const content = readDxf(text);
        expect(content.header["$INSUNITS"]).toBe(1);
        expect(new Set(content.entities.map((e) => e.layer))).toEqual(new Set(["ModelSketch_Visible"]));
        expect(content.entities).toHaveLength(outline({ reducing: true, od: 9.625, id: 6.625 }).length);

        const withBends = toDrawing(pattern({ reducing: false, od: 16 }), { bendLines: true });
        expect(withBends.entities.filter((e) => e.layer === "Bend")).toHaveLength(2);
    });
});
