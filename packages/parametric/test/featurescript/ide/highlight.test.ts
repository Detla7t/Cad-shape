// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { StringStream } from "@codemirror/language";
import {
    type FsStreamState,
    fsStreamParser,
    fsToken,
    startState,
} from "../../../src/featurescript/ui/ide/language";

/** Runs the stream tokenizer over `source` line by line: the styled tokens, whitespace skipped. */
function highlight(source: string, state: FsStreamState = startState()): [string, string][] {
    const result: [string, string][] = [];
    for (const line of source.split("\n")) {
        const stream = new StringStream(line, 4, 4);
        while (!stream.eol()) {
            const style = fsToken(stream, state);
            const text = line.slice(stream.start, stream.pos);
            if (stream.pos === stream.start) throw new Error(`no progress at ${stream.pos} in ${line}`);
            stream.start = stream.pos;
            if (style !== null) result.push([text, style]);
        }
    }
    return result;
}

function styleOf(source: string, text: string): string | undefined {
    return highlight(source).find(([token]) => token === text)?.[1];
}

describe("FeatureScript highlighting", () => {
    test("keywords by role: control flow, declarations, module, operator keywords", () => {
        const tokens = highlight("export function f() { if (x) return y; for (var i in a) {} }");
        expect(tokens).toContainEqual(["export", "moduleKeyword"]);
        expect(tokens).toContainEqual(["function", "definitionKeyword"]);
        expect(tokens).toContainEqual(["if", "controlKeyword"]);
        expect(tokens).toContainEqual(["return", "controlKeyword"]);
        expect(tokens).toContainEqual(["var", "definitionKeyword"]);
        expect(tokens).toContainEqual(["in", "controlKeyword"]);
    });

    test("types after `is`, `returns`, `as` and `typecheck`, including namespaced ones", () => {
        const source = "function f(context is Context, q is Std::Query) returns map { return x as Vector; }";
        expect(styleOf(source, "Context")).toBe("typeName");
        expect(styleOf(source, "Query")).toBe("typeName");
        expect(styleOf(source, "map")).toBe("typeName");
        expect(styleOf(source, "Vector")).toBe("typeName");
        expect(styleOf("type Foo typecheck canBeFoo;", "canBeFoo")).toBe("typeName");
        expect(styleOf("x is undefined", "undefined")).toBe("typeName");
        expect(styleOf("y = undefined;", "undefined")).toBe("null");
    });

    test("declared names: functions, variables and types", () => {
        expect(styleOf("function slot(x) {}", "slot")).toBe("variableName.function.definition");
        expect(styleOf("const width = 1;", "width")).toBe("variableName.definition");
        expect(styleOf("export enum Side { LEFT }", "Side")).toBe("typeName.definition");
    });

    test("annotations: the keyword, their keys, and plain map keys and values as strings", () => {
        const source = 'annotation { "Name" : "Width", "UIHint" : UIHint.REMEMBER_PREVIOUS_VALUE }';
        expect(styleOf(source, "annotation")).toBe("meta");
        expect(styleOf(source, '"Name"')).toBe("attributeName");
        expect(styleOf(source, '"UIHint"')).toBe("attributeName");
        expect(styleOf(source, '"Width"')).toBe("string");
        expect(styleOf('opExtrude(context, id, { "entities" : q });', '"entities"')).toBe("string");
    });

    test("an annotation map nested in a call still marks only its own keys", () => {
        const source = 'annotation { "Name" : f({ "inner" : 1 }) }';
        expect(styleOf(source, '"Name"')).toBe("attributeName");
        expect(styleOf(source, '"inner"')).toBe("string");
    });

    test("@builtins, numbers, units and constants", () => {
        const source = "const d = @opExtrude; x = 2.5e-3 * millimeter + LENGTH_BOUNDS + 3 * degree;";
        expect(styleOf(source, "@opExtrude")).toBe("variableName.standard");
        expect(styleOf(source, "2.5e-3")).toBe("number");
        expect(styleOf(source, "millimeter")).toBe("unit");
        expect(styleOf(source, "degree")).toBe("unit");
        expect(styleOf(source, "LENGTH_BOUNDS")).toBe("variableName.constant");
    });

    test("string escapes are their own tokens", () => {
        expect(highlight('"a\\nb"')).toEqual([
            ['"a', "string"],
            ["\\n", "escape"],
            ['b"', "string"],
        ]);
        expect(highlight('"\\u0041"')).toEqual([
            ['"', "string"],
            ["\\u0041", "escape"],
            ['"', "string"],
        ]);
    });

    test("calls, members, enum values and PascalCase type names", () => {
        const source = "qCreatedBy(id, EntityType.FACE); v.x; foo.bar();";
        expect(styleOf(source, "qCreatedBy")).toBe("variableName.function");
        expect(styleOf(source, "EntityType")).toBe("typeName");
        expect(styleOf(source, "FACE")).toBe("variableName.constant");
        expect(styleOf(source, "x")).toBe("propertyName");
        expect(styleOf(source, "bar")).toBe("propertyName.function");
    });

    test("comments: line, block across lines, and doc comments with their @tags", () => {
        const tokens = highlight("/**\n * Summary.\n * @param id : the id\n */\nx // tail");
        expect(tokens).toContainEqual(["/**", "docComment"]);
        expect(tokens).toContainEqual(["@param", "labelName"]);
        expect(tokens.find(([text]) => text.includes("Summary"))?.[1]).toBe("docComment");
        expect(tokens).toContainEqual(["// tail", "comment"]);
        expect(tokens).toContainEqual(["x", "variableName"]);
        const block = highlight("/* a\n b */ y");
        expect(block.map(([, style]) => style)).toEqual(["comment", "comment", "variableName"]);
    });

    test("operators and brackets", () => {
        const tokens = highlight("a += b -> f(c) ?? d;");
        expect(tokens).toContainEqual(["+=", "operator"]);
        expect(tokens).toContainEqual(["->", "operator"]);
        expect(tokens).toContainEqual(["??", "operator"]);
        expect(tokens).toContainEqual(["(", "bracket"]);
        expect(tokens).toContainEqual([";", "punctuation"]);
    });

    test("an unterminated string ends with its line", () => {
        const tokens = highlight('x = "open\ny;');
        expect(tokens).toContainEqual(['"open', "string"]);
        expect(tokens).toContainEqual(["y", "variableName"]);
    });
});

describe("FeatureScript indentation", () => {
    const indent = (before: string, textAfter: string) => {
        const state = startState();
        highlight(before, state);
        const indentFn = fsStreamParser.indent;
        if (indentFn === undefined) throw new Error("no indent");
        return indentFn(state, textAfter, { unit: 4 } as never);
    };

    test("one unit inside the line that opened the bracket", () => {
        expect(
            indent(
                "export const f = defineFeature(function(context is Context, id is Id, definition is map)",
                "precondition",
            ),
        ).toBe(4);
        expect(indent("function f()\n{", "return 1;")).toBe(4);
        expect(indent("function f()\n{\n    if (x)\n    {", "y();")).toBe(8);
    });

    test("two brackets opened on one line indent their contents two units", () => {
        expect(indent('    {\n        newSketch(context, id + "s", {', '"sketchPlane" : p')).toBe(16);
    });

    test("a line starting with a closer lines up with the line that opened it", () => {
        expect(indent("x = defineFeature(function()\n    {", "});")).toBe(4);
        expect(indent('    {\n        newSketch(context, id + "s", {\n                "a" : 1', "});")).toBe(
            8,
        );
        expect(indent("function f()\n{", "}")).toBe(0);
    });

    test("inside a block comment aligns the stars one column in", () => {
        expect(indent("function f()\n{\n    /**", "* more")).toBe(5);
    });
});
