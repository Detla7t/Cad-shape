// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { compileStudioSource } from "../../../src/featurescript/studioCompiler";
import { diagnosticsFor, offsetOf } from "../../../src/featurescript/ui/ide/diagnostics";
import { HEADER } from "./_helpers";

/** Compiles a studio source the way the editor does (no other studios). */
function compile(name: string, source: string) {
    return compileStudioSource(`id-${name}`, name, source, () => undefined);
}

describe("compile errors as editor diagnostics", () => {
    test("a syntax error marks the token the parser stopped at", () => {
        const source = `${HEADER}export function f()\n{\n    var x = 1\n    return x;\n}\n`;
        const compiled = compile("Syntax", source);
        expect(compiled.error).toMatch(/Expected ";"/);
        expect(compiled.file).toBe("Syntax");
        const [diagnostic] = diagnosticsFor(source, compiled, "Syntax");
        expect(diagnostic.severity).toBe("error");
        expect(source.slice(diagnostic.from, diagnostic.to)).toBe("return");
        // The marker carries the message without the location the marker already shows.
        expect(diagnostic.message).toBe('Expected ";" but found "return"');
    });

    test("a runtime error while loading marks the failing expression", () => {
        const source = `${HEADER}export const X = undefinedName + 1;\n`;
        const compiled = compile("Runtime", source);
        expect(compiled.error).toBeDefined();
        const [diagnostic] = diagnosticsFor(source, compiled, "Runtime");
        expect(source.slice(diagnostic.from, diagnostic.to)).toBe("undefinedName");
    });

    test("an error at the end of a line marks the character before the break", () => {
        const source = "a\nbc\n";
        const [diagnostic] = diagnosticsFor(source, { error: "boom", line: 2, column: 3, file: "S" }, "S");
        expect([diagnostic.from, diagnostic.to]).toEqual([3, 4]);
    });

    test("an error inside another module is pinned to the studio's frame in the stack", () => {
        const source = `${HEADER}function g()\n{\n    return h();\n}\n`;
        const error = "Boom (Other:3:5)\n  at h (Other:1:1)\n  at g (Here:3:1)";
        const [diagnostic] = diagnosticsFor(source, { error, line: 3, column: 5, file: "Other" }, "Here");
        expect(diagnostic.from).toBe(offsetOf(source, 3, 1));
        expect(source.slice(diagnostic.from, diagnostic.to)).toBe("function");
        expect(diagnostic.message).toBe(error);
    });

    test("without a studio frame, the import of the failing module is marked", () => {
        const source = `${HEADER}import(path : "Fasteners", version : "");\n`;
        const [diagnostic] = diagnosticsFor(
            source,
            { error: "Bad", line: 9, column: 1, file: "Fasteners" },
            "Here",
        );
        expect(source.slice(diagnostic.from, diagnostic.to)).toBe('"Fasteners"');
    });

    test("a std module failure falls back to the std import", () => {
        const [diagnostic] = diagnosticsFor(
            HEADER,
            { error: "x", line: 1, column: 1, file: "onshape/std/geometry.fs" },
            "S",
        );
        expect(HEADER.slice(diagnostic.from, diagnostic.to)).toBe('"onshape/std/geometry.fs"');
    });

    test("no error, no diagnostics", () => {
        const source = `${HEADER}export const X = 1;\n`;
        const compiled = compile("Fine", source);
        expect(compiled.error).toBeUndefined();
        expect(diagnosticsFor(source, compiled, "Fine")).toEqual([]);
    });

    test("offsetOf clamps the column into the line and rejects lines past the end", () => {
        expect(offsetOf("ab\ncd", 2, 99)).toBe(5);
        expect(offsetOf("ab\ncd", 3, 1)).toBeUndefined();
    });
});
