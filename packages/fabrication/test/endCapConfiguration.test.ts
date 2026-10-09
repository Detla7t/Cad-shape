// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { evaluateDocumentScope } from "@chili3d/core";
import {
    configuredEndCapValues,
    endCapConfigurationInputs,
    END_CAP_INPUT_NAMES as N,
    resolveEndCapValues,
} from "../src/app/endCapConfiguration";

const resolve = (active: Record<string, string | boolean> = {}) =>
    resolveEndCapValues(
        configuredEndCapValues(),
        evaluateDocumentScope({ inputs: endCapConfigurationInputs(), active }, []).scope,
    );

describe("end cap configuration", () => {
    test('defaults to the Onshape document\'s 9 5/8" x 6 5/8" reducer', () => {
        const result = resolve();
        expect(result.isOk).toBe(true);
        expect(result.value).toEqual({ reducing: true, od: 9.625, id: 6.625, wallHeight: undefined });
    });

    test("the Endcap checkbox makes a plain cap of the OD", () => {
        expect(resolve({ [N.endcap]: true, [N.od]: '16"' }).value).toEqual({ reducing: false, od: 16 });
    });

    test("Custom sizes and a custom finish wall height come from their variables", () => {
        const result = resolve({
            [N.od]: "Custom",
            [N.customOd]: "13.5 in",
            [N.id]: "Custom",
            [N.customId]: "7 in",
            [N.wall]: true,
            [N.finishWall]: "3.25 in",
        });
        expect(result.value).toEqual({ reducing: true, od: 13.5, id: 7, wallHeight: 3.25 });
    });

    test("every preset label resolves to its size", () => {
        for (const option of ['4"', '5 9/16"', '10 3/4"', '24"']) {
            const result = resolve({ [N.endcap]: true, [N.od]: option });
            expect(result.isOk).toBe(true);
        }
        expect(resolve({ [N.endcap]: true, [N.od]: '5 9/16"' }).value).toEqual({
            reducing: false,
            od: 5.5625,
        });
    });

    test("list options keep Onshape's option ids, and inputs show only when they apply", () => {
        const inputs = endCapConfigurationInputs();
        const od = inputs.find((input) => input.name === N.od);
        expect(od?.kind === "list" && od.options.find((o) => o.name === '9 5/8"')?.id).toBe("_9_5_8_");
        expect(inputs.find((input) => input.name === N.id)?.visibility?.conditions[0]).toEqual({
            inputId: "endcap-endcap",
            operator: "is",
            values: [false],
        });
    });
});
