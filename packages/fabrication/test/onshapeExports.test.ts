// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Optional conformance sweep against a folder of the End Cap Configurator's DXF exports
 * (`{od} End Cap.dxf`, `{od} x {id} Reducing End Cap.dxf`, inches):
 *
 *     ENDCAP_REFERENCE_DIR=/path/to/exports npx rstest packages/fabrication/test/onshapeExports.test.ts
 *
 * Skipped without the variable; the always-on cases are in endCap.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDxf } from "@chili3d/drawing";
import { DUCT_SIZES, type EndCapParams, endCapPattern, type Segment, sameGeometry } from "../src";

const directory = process.env["ENDCAP_REFERENCE_DIR"];

/** File names round sizes to two decimals (`5.56in`): back to the preset they came from. */
function size(text: string): number {
    const value = Number(text);
    return DUCT_SIZES.find((preset) => Math.abs(preset.inches - value) < 0.006)?.inches ?? value;
}

function capOf(file: string): EndCapParams | undefined {
    const match = /^([\d.]+)in(?: x ([\d.]+)in Reducing)? End Cap\.dxf$/.exec(file);
    if (match === null) return undefined;
    return match[2] === undefined
        ? { reducing: false, od: size(match[1]) }
        : { reducing: true, od: size(match[1]), id: size(match[2]) };
}

function segmentsOf(text: string): Segment[] {
    return readDxf(text).entities.map((entity): Segment => {
        const v = entity.values as Record<number, number>;
        return entity.type === "ARC"
            ? { kind: "arc", center: [v[10], v[20]], radius: v[40], startAngle: v[50], endAngle: v[51] }
            : { kind: "line", a: [v[10], v[20]], b: [v[11], v[21]] };
    });
}

describe.skipIf(directory === undefined)("Onshape End Cap Configurator exports", () => {
    const files = directory === undefined ? [] : readdirSync(directory).filter((f) => capOf(f) !== undefined);

    test("the folder holds exports", () => {
        expect(files.length).toBeGreaterThan(0);
    });

    test.each(files)("%s", (file) => {
        const params = capOf(file)!;
        const pattern = endCapPattern(params);
        expect(pattern.isOk).toBe(true);
        const generated = pattern.isOk ? pattern.value.parts.flatMap((p) => [...p.outline]) : [];
        const reference = segmentsOf(readFileSync(join(directory!, file), "utf8"));
        expect(sameGeometry(generated, reference, 1e-6)).toBe(true);
    });
});
