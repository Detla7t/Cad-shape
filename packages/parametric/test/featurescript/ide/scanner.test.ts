// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    isClosedString,
    normalizeNewlines,
    scanTokens,
    stringValue,
    tokenIndexAt,
    tokenIndexBefore,
} from "../../../src/featurescript/ui/ide/scanner";

const kinds = (source: string) => scanTokens(source).map((token) => [token.kind, token.text]);

describe("scanTokens", () => {
    test("keeps comments, telling doc comments apart", () => {
        expect(kinds("// line\n/* block */ /** doc */ x")).toEqual([
            ["comment", "// line"],
            ["comment", "/* block */"],
            ["doc", "/** doc */"],
            ["ident", "x"],
        ]);
    });

    test("an empty /**/ is a plain comment, not a doc comment", () => {
        expect(kinds("/**/")).toEqual([["comment", "/**/"]]);
    });

    test("strings keep their quotes and escapes; an unterminated one ends at the line", () => {
        expect(kinds('"a\\"b" \'c\' "open\nnext')).toEqual([
            ["string", '"a\\"b"'],
            ["string", "'c'"],
            ["string", '"open'],
            ["ident", "next"],
        ]);
    });

    test("numbers with fractions and exponents; units are identifiers", () => {
        expect(kinds("5 * millimeter + .5e-3 * inch")).toEqual([
            ["number", "5"],
            ["punct", "*"],
            ["ident", "millimeter"],
            ["punct", "+"],
            ["number", ".5e-3"],
            ["punct", "*"],
            ["ident", "inch"],
        ]);
    });

    test("keywords, @builtins and the longest punctuation", () => {
        expect(kinds("export const x = @opExtrude; a ||= b?.c :: d")).toEqual([
            ["keyword", "export"],
            ["keyword", "const"],
            ["ident", "x"],
            ["punct", "="],
            ["builtin", "@opExtrude"],
            ["punct", ";"],
            ["ident", "a"],
            ["punct", "||="],
            ["ident", "b"],
            ["punct", "?."],
            ["ident", "c"],
            ["punct", "::"],
            ["ident", "d"],
        ]);
    });

    test("`? .5` is a conditional followed by a number, not optional chaining", () => {
        expect(kinds("c ? .5 : 1")).toEqual([
            ["ident", "c"],
            ["punct", "?"],
            ["number", ".5"],
            ["punct", ":"],
            ["number", "1"],
        ]);
    });

    test("never throws on characters the language rejects", () => {
        expect(kinds("a $ b")).toEqual([
            ["ident", "a"],
            ["punct", "$"],
            ["ident", "b"],
        ]);
    });

    test("an unterminated block comment runs to the end", () => {
        const tokens = scanTokens("x /** never closed\n y");
        expect(tokens.map((token) => token.kind)).toEqual(["ident", "doc"]);
        expect(tokens[1].to).toBe("x /** never closed\n y".length);
    });
});

describe("token lookup", () => {
    const tokens = scanTokens("foo(bar, baz)");

    test("tokenIndexAt prefers the word starting at a boundary over the punctuation ending there", () => {
        expect(tokens[tokenIndexAt(tokens, 4)].text).toBe("bar");
        expect(tokens[tokenIndexAt(tokens, 7)].text).toBe("bar");
        expect(tokens[tokenIndexAt(tokens, 1)].text).toBe("foo");
    });

    test("tokenIndexBefore finds the last token ending at or before a position", () => {
        expect(tokens[tokenIndexBefore(tokens, 8)].text).toBe(",");
        expect(tokenIndexBefore(tokens, 0)).toBe(-1);
    });
});

describe("string helpers", () => {
    test.each([
        ['"abc"', true],
        ['"ab\\"', false],
        ['"ab\\\\"', true],
        ['"open', false],
        ['"', false],
    ])("isClosedString(%s) is %s", (text, closed) => {
        expect(isClosedString(text)).toBe(closed);
    });

    test("stringValue decodes escapes and drops the quotes", () => {
        expect(stringValue('"a\\tb\\u0041\\"c"')).toBe('a\tbA"c');
        expect(stringValue('"unterminated')).toBe("unterminated");
    });

    test("normalizeNewlines turns CRLF and CR into LF", () => {
        expect(normalizeNewlines("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    });
});
