// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { decodeOnshape, differences } from "../../../scripts/onshape-conformance.mjs";

const scalar = (value: unknown) => ({ btType: "com.belmonttech.serialize.fsvalue.BTFSValueNumber", value });

test("Onshape response decoding preserves nested vectors and numeric measurements", () => {
    const raw = {
        btType: "com.belmonttech.serialize.fsvalue.BTFSValueMap",
        value: [
            {
                key: { btType: "com.belmonttech.serialize.fsvalue.BTFSValueString", value: "center" },
                value: {
                    btType: "com.belmonttech.serialize.fsvalue.BTFSValueArray",
                    value: [scalar(2), scalar(3), scalar(4)],
                },
            },
        ],
    };
    expect(decodeOnshape(raw)).toEqual({ center: [2, 3, 4] });
});

test.each([
    null,
    { btType: "unknown", value: 0 },
    scalar(Number.NaN),
    scalar(Infinity),
    scalar(undefined),
    scalar("3"),
    { btType: "com.belmonttech.serialize.fsvalue.BTFSValueBoolean", value: "false" },
])("a missing or nonfinite Onshape result never becomes a passing reference: %s", (raw) => {
    expect(() => decodeOnshape(raw)).toThrow();
});

test("geometry comparisons tolerate rounding but require exact topology and detect missing fields", () => {
    expect(differences({ volume: 100, edges: 4 }, { volume: 100.00001, edges: 4 })).toEqual([]);
    expect(
        differences({ volume: 100, edges: 4 }, { volume: 101, edges: 5 }).map((s: string) => s.split(":")[0]),
    ).toEqual(["$.edges", "$.volume"]);
    expect(differences({ point: [1, 2, 3] }, { point: [1, 2] })).toEqual([
        "$.point: array length/type differs",
    ]);
    expect(differences({ count: 1 }, {}).map((s: string) => s.split(":")[0])).toEqual(["$.count"]);
    expect(differences(1, Number.NaN)).toHaveLength(1);
    expect(differences(undefined, undefined)).toEqual(["$: missing result or field"]);
});
