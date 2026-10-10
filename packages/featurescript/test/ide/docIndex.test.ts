// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { scanDeclarations } from "../../src/ide/declarations";
import { docSummaryLine, parseDocComment } from "../../src/ide/docComment";
import { StdIndex } from "../../src/ide/stdIndex";
import { ONSHAPE_STD } from "../_helpers/onshapeStd";
import { STD_INDEX } from "./_helpers";

describe("parseDocComment", () => {
    const doc = parseDocComment(`/**
 * Makes a slot. The slot is
 * cut through everything.
 *
 * Second paragraph.
 * @param id : @autocomplete \`id + "slot1"\`
 * @param definition {{
 *      @field path {Query} : The edges to follow.
 *      @field width {ValueWithUnits} : @optional
 *              How wide. @eg \`5 * millimeter\`
 *      @field depth {ValueWithUnits} : @requiredif {\`blind\` is \`true\`.}
 *              How deep.
 * }}
 * @param flip : @optional Whether to flip.
 * @return {Query} : The slot faces.
 * @example \`slot(context, id, {})\` makes a slot
 * @seealso [opExtrude]
 * @internal
 */`);

    test("summary keeps paragraphs and joins wrapped lines", () => {
        expect(doc.summary).toBe("Makes a slot. The slot is cut through everything.\n\nSecond paragraph.");
        expect(docSummaryLine(doc)).toBe("Makes a slot.");
    });

    test("params, with an @autocomplete example and @optional", () => {
        expect(doc.params.map((param) => param.name)).toEqual(["id", "definition", "flip"]);
        expect(doc.params[0].autocomplete).toBe('`id + "slot1"`');
        expect(doc.params[2]).toMatchObject({ optional: true, text: "Whether to flip." });
    });

    test("definition fields with types, @optional, @requiredif and @eg", () => {
        const fields = doc.params[1].fields;
        expect(fields.map((field) => [field.name, field.type])).toEqual([
            ["path", "Query"],
            ["width", "ValueWithUnits"],
            ["depth", "ValueWithUnits"],
        ]);
        expect(fields[0]).toMatchObject({ text: "The edges to follow.", optional: false });
        expect(fields[1]).toMatchObject({
            text: "How wide.",
            optional: true,
            examples: ["`5 * millimeter`"],
        });
        expect(fields[2]).toMatchObject({ text: "How deep.", requiredIf: "`blind` is `true`." });
    });

    test("return, example, see-also and the internal marker", () => {
        expect(doc.returns).toEqual({ type: "Query", text: "The slot faces." });
        expect(doc.examples).toEqual(["`slot(context, id, {})` makes a slot"]);
        expect(doc.seeAlso).toEqual(["[opExtrude]"]);
        expect(doc.internal).toBe(true);
    });

    test("enum @value entries", () => {
        const values = parseDocComment(
            "/**\n * Sides.\n * @value LEFT : The left\n *    side.\n * @value RIGHT : Right.\n */",
        ).values;
        expect([...values]).toEqual([
            ["LEFT", "The left side."],
            ["RIGHT", "Right."],
        ]);
    });
});

describe("StdIndex on Onshape's std 3083", () => {
    const exports = STD_INDEX.exportsOf("geometry.fs");

    test("geometry.fs passes on the std surface through its export imports", () => {
        expect(exports.size).toBeGreaterThan(1500);
        for (const name of [
            "opExtrude",
            "extrude",
            "qCreatedBy",
            "BoundingType",
            "Context",
            "LENGTH_BOUNDS",
            "millimeter",
        ]) {
            expect(exports.has(name)).toBe(true);
        }
        // Non-exported helpers of std modules stay private: extrude.fs declares this one without `export`.
        const extrudeModule = STD_INDEX.module("extrude.fs");
        expect(
            extrudeModule?.declarations.some((declaration) => declaration.name === "extrudeWithDraft"),
        ).toBe(true);
        expect(exports.has("extrudeWithDraft")).toBe(false);
    });

    test("opExtrude: module, signature, doc summary and definition fields", () => {
        const [entry] = exports.get("opExtrude") ?? [];
        expect(entry.module).toBe("geomOperations.fs");
        expect(entry.declaration.kind).toBe("function");
        expect(entry.declaration.signature?.params).toEqual([
            { name: "context", type: "Context" },
            { name: "id", type: "Id" },
            { name: "definition", type: "map" },
        ]);
        const doc = STD_INDEX.doc(entry.declaration);
        expect(doc?.summary).toMatch(/^Extrudes one or more edges or faces in a given direction/);
        expect(doc?.params.find((param) => param.name === "id")?.autocomplete).toBe('`id + "extrude1"`');
        const fields = doc?.params.find((param) => param.name === "definition")?.fields ?? [];
        expect(fields.slice(0, 3).map((field) => field.name)).toEqual(["entities", "direction", "endBound"]);
        expect(fields.find((field) => field.name === "endDepth")?.requiredIf).toBe("`endBound` is `BLIND`.");
        expect(fields.find((field) => field.name === "startBound")?.optional).toBe(true);
    });

    test("the declaration's offsets point at its name in the module source", () => {
        const [entry] = exports.get("opExtrude") ?? [];
        const source = STD_INDEX.module(entry.module)?.source ?? "";
        expect(source.slice(entry.declaration.nameFrom, entry.declaration.nameTo)).toBe("opExtrude");
        expect(source.includes("\r")).toBe(false);
    });

    test("overloads reached through several export paths are listed once each", () => {
        const vector = exports.get("vector") ?? [];
        expect(vector.map((entry) => entry.declaration.signature?.params.map((param) => param.name))).toEqual(
            [["value"], ["x", "y"], ["x", "y", "z"]],
        );
        const createdBy = exports.get("qCreatedBy") ?? [];
        expect(new Set(createdBy.map((entry) => entry.declaration)).size).toBe(createdBy.length);
    });

    test("a std feature: kind, display name and the parameters its precondition declares", () => {
        const [entry] = exports.get("extrude") ?? [];
        expect(entry.declaration.kind).toBe("feature");
        expect(entry.declaration.annotation?.get("Feature Type Name")).toBe("Extrude");
        const entities = entry.declaration.fields?.find((field) => field.name === "entities");
        expect(entities).toMatchObject({ type: "Query", label: "Faces and sketch regions to extrude" });
    });

    test("an enum's members, their annotation names and @value docs", () => {
        const [entry] = exports.get("BoundingType") ?? [];
        expect(entry.declaration.members?.slice(0, 3).map((member) => [member.name, member.label])).toEqual([
            ["BLIND", "Blind"],
            ["UP_TO_NEXT", "Up to next"],
            ["UP_TO_SURFACE", "Up to face"],
        ]);
        expect(STD_INDEX.doc(entry.declaration)?.values.get("BLIND")).toBe("Extrude a specific distance.");
    });

    test("std's documented examples are part of the doc", () => {
        const [entry] = exports.get("makeArray") ?? [];
        expect(STD_INDEX.doc(entry.declaration)?.examples).toContain("`makeArray(3, 0)` returns `[0, 0, 0]`");
    });

    test("warm scans the closure in slices and lists the modules for import completion", async () => {
        const index = new StdIndex(ONSHAPE_STD);
        let slices = 0;
        await index.warm(
            "geometry.fs",
            async () => {
                slices++;
            },
            2,
        );
        expect(slices).toBeGreaterThan(1);
        expect(index.scannedModules()).toContain("geomOperations.fs");
        expect(index.isScanned("extrude.fs")).toBe(true);
        // The same warm-up is shared by later callers.
        expect(index.warm("geometry.fs")).toBe(index.warm("geometry.fs"));
    });
});

describe("export rules", () => {
    const files: Record<string, string> = {
        "base.fs":
            "export function f(x is number) { return 1; }\nfunction hidden() {}\nexport const SHARED = 1;",
        "other.fs": "export function f(x is string) { return 2; }",
        "top.fs":
            'export import(path : "onshape/std/base.fs", version : "");\nexport import(path : "onshape/std/other.fs", version : "");\nexport const SHARED = 2;',
        "plain.fs": 'import(path : "onshape/std/base.fs", version : "");\nexport const MINE = 3;',
    };
    const index = new StdIndex({ version: 1, read: (file) => files[file] });

    test("overloads merge across export imports; non-exported names stay out", () => {
        const exports = index.exportsOf("top.fs");
        expect(exports.get("f")?.map((entry) => entry.module)).toEqual(["base.fs", "other.fs"]);
        expect(exports.has("hidden")).toBe(false);
    });

    test("a module's own declaration shadows an imported one", () => {
        expect(
            index
                .exportsOf("top.fs")
                .get("SHARED")
                ?.map((entry) => entry.module),
        ).toEqual(["top.fs"]);
    });

    test("a plain import is not passed on", () => {
        expect([...index.exportsOf("plain.fs").keys()]).toEqual(["MINE"]);
    });
});

describe("scanDeclarations", () => {
    test("tolerates half-typed code and keeps the declarations around it", () => {
        const declarations = scanDeclarations(
            "FeatureScript 3083;\nexport const A = 1;\nexport function broken(x is\nexport const B = foo(;\n/** Doc. */\nexport enum E { X, Y }\n",
        );
        const names = declarations.map((declaration) => declaration.name);
        expect(names).toContain("A");
        expect(names).toContain("broken");
        expect(names).toContain("E");
        expect(declarations.find((declaration) => declaration.name === "E")?.doc).toBe("/** Doc. */");
    });
});
