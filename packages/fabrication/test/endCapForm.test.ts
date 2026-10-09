// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CUSTOM_SIZE,
    DEFAULT_END_CAP_FORM,
    endCapFormOf,
    endCapFromSearchParams,
    endCapSearchParams,
    readEndCapForm,
} from "../src/react/endCapForm";

describe("end cap form", () => {
    test("the default form is the configurator's default reducer", () => {
        expect(readEndCapForm(DEFAULT_END_CAP_FORM)).toEqual({
            params: { reducing: true, od: 9.625, id: 6.625, wallHeight: undefined },
            errors: {},
        });
    });

    test("custom sizes and wall heights are read as shop inches", () => {
        const result = readEndCapForm({
            ...DEFAULT_END_CAP_FORM,
            od: CUSTOM_SIZE,
            customOd: '13 1/2"',
            customWallHeight: true,
            wallHeight: "3 1/4",
        });
        expect(result.params).toEqual({ reducing: true, od: 13.5, id: 6.625, wallHeight: 3.25 });
    });

    test("unreadable text is an error on its field; an impossible cap an error of the cap", () => {
        expect(
            readEndCapForm({ ...DEFAULT_END_CAP_FORM, od: CUSTOM_SIZE, customOd: "big" }).errors.od,
        ).toBeDefined();
        const inverted = readEndCapForm({ ...DEFAULT_END_CAP_FORM, od: "5", id: "9.625" });
        expect(inverted.params).toBeUndefined();
        expect(inverted.errors.cap).toContain("smaller than the outside diameter");
    });

    test("a plain cap ignores the ID", () => {
        const result = readEndCapForm({
            ...DEFAULT_END_CAP_FORM,
            endcap: true,
            id: CUSTOM_SIZE,
            customId: "?",
        });
        expect(result.params).toEqual({ reducing: false, od: 9.625, id: undefined, wallHeight: undefined });
    });

    test.each([
        { reducing: true, od: 9.625, id: 6.625 },
        { reducing: false, od: 16 },
        { reducing: true, od: 13.5, id: 7.625, wallHeight: 3.25 },
    ])("%o survives the URL and the form", (params) => {
        const back = endCapFromSearchParams(endCapSearchParams(params));
        expect(back).toEqual({ id: undefined, wallHeight: undefined, ...params });
        expect(readEndCapForm(endCapFormOf(params)).params).toEqual(back);
    });

    test("a link to an impossible cap is ignored", () => {
        expect(endCapFromSearchParams(new URLSearchParams("endcap=reducing&od=6&id=9"))).toBeUndefined();
        expect(endCapFromSearchParams(new URLSearchParams("od=6"))).toBeUndefined();
    });
});
