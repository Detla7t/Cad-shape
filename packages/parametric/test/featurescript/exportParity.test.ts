// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { compareBytes } from "../../../../scripts/compare-cad-exports.mjs";

test("raw exports with identical bytes have identical SHA-256 hashes", () => {
    const result = compareBytes(Buffer.from([0, 255, 13, 10]), Buffer.from([0, 255, 13, 10]));
    expect(result.equal).toBe(true);
    expect(result.firstDifference).toBeNull();
    expect(result.onshape.sha256).toBe(result.chili3d.sha256);
});

test.each([
    { name: "line endings", reference: "HEADER;\r\n", actual: "HEADER;\n", offset: 7 },
    { name: "trailing whitespace", reference: "ENDSEC;", actual: "ENDSEC; ", offset: 7 },
    { name: "numeric spelling", reference: "(1.,0.,0.)", actual: "(1.0,0.,0.)", offset: 3 },
    {
        name: "timestamp metadata",
        reference: "2026-10-08T12:00:00",
        actual: "2026-10-08T12:00:01",
        offset: 18,
    },
])("raw comparison rejects different $name", ({ reference, actual, offset }) => {
    const result = compareBytes(Buffer.from(reference), Buffer.from(actual));
    expect(result.equal).toBe(false);
    expect(result.firstDifference?.offset).toBe(offset);
    expect(result.onshape.sha256).not.toBe(result.chili3d.sha256);
});
