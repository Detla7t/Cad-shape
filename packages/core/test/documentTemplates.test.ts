// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DocumentTemplate,
    documentTemplates,
    findDocumentTemplate,
    type IDocument,
    Result,
    registerDocumentTemplate,
} from "../src";

function template(id: string, name: string): DocumentTemplate {
    return {
        id,
        name,
        description: "",
        owner: "test",
        create: async () => Result.ok({} as IDocument),
    };
}

describe("document templates", () => {
    test("published templates are listed by name and found by id until withdrawn", () => {
        const withdrawB = registerDocumentTemplate(template("b", "Zeta"));
        const withdrawA = registerDocumentTemplate(template("a", "Alpha"));
        try {
            const names = documentTemplates().map((t) => t.name);
            expect(names.indexOf("Alpha")).toBeLessThan(names.indexOf("Zeta"));
            expect(findDocumentTemplate("a")?.name).toBe("Alpha");
        } finally {
            withdrawA();
            withdrawB();
        }
        expect(findDocumentTemplate("a")).toBeUndefined();
    });

    test("a replaced template is not withdrawn by its predecessor", () => {
        const withdrawOld = registerDocumentTemplate(template("same", "Old"));
        const withdrawNew = registerDocumentTemplate(template("same", "New"));
        try {
            withdrawOld();
            expect(findDocumentTemplate("same")?.name).toBe("New");
        } finally {
            withdrawNew();
        }
    });
});
