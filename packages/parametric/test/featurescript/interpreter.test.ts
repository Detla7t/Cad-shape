// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsSyntaxError } from "../../src/featurescript/lang/errors";
import { FsMap, FsQuantity, type FsValue, toDisplayString } from "../../src/featurescript/lang/values";
import { createInterpreter } from "../../src/featurescript/runtime";

/** Runs `body` as the body of an exported `main()` and returns its result plus the printed log. */
function run(body: string, prelude = ""): { result: FsValue; log: string[] } {
    const log: string[] = [];
    const interpreter = createInterpreter({ print: (text) => log.push(text) });
    const module = interpreter.load({
        path: "test",
        source: `FeatureScript 2384;\nimport(path : "onshape/std/common.fs", version : "2384.0");\n${prelude}\nexport function main() {\n${body}\n}`,
    });
    const result = interpreter.callFunction(module.exports.get("main"), []);
    return { result, log };
}

const value = (body: string, prelude = "") => run(body, prelude).result;
const text = (body: string, prelude = "") => toDisplayString(value(body, prelude));

describe("expressions", () => {
    test.each([
        ["return 1 + 2 * 3;", 7],
        ["return 2 ^ 3 ^ 2;", 512],
        ["return -2 ^ 2;", -4],
        ["return (1 + 2) * 3;", 9],
        ["return 7 % 3;", 1],
        ["return -7 % 3;", 2],
        ["return 10 / 4;", 2.5],
        ["return 3 > 2 && 2 >= 2 && 1 != 2;", true],
        ["return true ? 1 : 2;", 1],
        ['return "a" ~ 1 ~ true;', "a1true"],
    ])("%s", (source, expected) => {
        expect(value(source)).toEqual(expected);
    });

    test("logical operators short-circuit", () => {
        expect(value("return false && undefinedFunction();")).toBe(false);
        expect(value("return true || undefinedFunction();")).toBe(true);
    });

    test("conditions must be booleans", () => {
        expect(() => value("if (1) { return 1; } return 2;")).toThrow(/must be a boolean/);
    });
});

describe("units", () => {
    test("lengths add in SI and print in meters", () => {
        const result = value("return 1 * inch + 1 * millimeter;");
        expect(result).toBeInstanceOf(FsQuantity);
        expect((result as FsQuantity).value).toBeCloseTo(0.0264, 12);
        expect(text("return 2 * meter;")).toBe("2 meter");
    });

    test("dividing like units yields a plain number", () => {
        expect(value("return (2 * inch) / inch;")).toBeCloseTo(2, 12);
    });

    test("mismatched units are rejected", () => {
        expect(() => value("return 1 * inch + 1 * degree;")).toThrow(/Cannot add/);
    });

    test("trigonometry takes angles", () => {
        expect(value("return sin(30 * degree);")).toBeCloseTo(0.5, 12);
        expect(text("return atan2(1 * inch, 1 * inch) / degree;")).toBe("45");
    });

    test("powers and roots scale exponents", () => {
        expect(text("return sqrt((3 * meter) ^ 2 + (4 * meter) ^ 2);")).toBe("5 meter");
    });

    test("bounds predicates read the std bound specs", () => {
        expect(value("return isLength(10 * millimeter, NONNEGATIVE_LENGTH_BOUNDS);")).toBe(true);
        expect(value("return isLength(-10 * millimeter, NONNEGATIVE_LENGTH_BOUNDS);")).toBe(false);
        expect(value("return isAngle(30 * degree, ANGLE_360_BOUNDS);")).toBe(true);
        expect(value("return isInteger(3, POSITIVE_COUNT_BOUNDS);")).toBe(true);
        expect(value("return isInteger(0, POSITIVE_COUNT_BOUNDS);")).toBe(false);
    });
});

describe("value semantics", () => {
    test("arrays copy on assignment", () => {
        expect(text("var a = [1, 2]; var b = a; b[0] = 9; return [a, b];")).toBe("[ [ 1, 2 ], [ 9, 2 ] ]");
    });

    test("nested map writes only touch the written path", () => {
        expect(text('var a = { "x" : { "y" : 1 } }; var b = a; b.x.y = 2; return [a.x.y, b.x.y];')).toBe(
            "[ 1, 2 ]",
        );
    });

    test("arguments are values", () => {
        const prelude = "function poke(arr) { arr[0] = 99; return arr; }";
        expect(text("var a = [1]; const b = poke(a); return [a, b];", prelude)).toBe("[ [ 1 ], [ 99 ] ]");
    });

    test("boxes are shared references", () => {
        const prelude = "function bump(b is box) { b[] = b[] + 1; }";
        expect(value("var b = new box(1); bump(b); bump(b); return b[];", prelude)).toBe(3);
    });

    test("constants cannot be modified", () => {
        expect(() => value("const a = [1]; a[0] = 2; return a;")).toThrow(/constant/);
    });

    test("compound assignment and string building in loops", () => {
        expect(value('var s = ""; for (var i = 0; i < 4; i += 1) { s ~= i; } return s;')).toBe("0123");
    });

    test("maps accept non-string keys", () => {
        expect(value('var m = {}; m[1 * inch] = "a"; return m[0.0254 * meter];')).toBe("a");
    });
});

describe("control flow", () => {
    test("for-in walks arrays and maps", () => {
        expect(value("var sum = 0; for (var x in [1, 2, 3]) { sum += x; } return sum;")).toBe(6);
        expect(
            value('var keys = ""; for (var k, v in { "a" : 1, "b" : 2 }) { keys ~= k ~ v; } return keys;'),
        ).toBe("a1b2");
    });

    test("break and continue", () => {
        expect(value("var n = 0; while (true) { n += 1; if (n < 5) continue; break; } return n;")).toBe(5);
    });

    test("do-while runs at least once", () => {
        expect(value("var n = 10; do { n += 1; } while (n < 5); return n;")).toBe(11);
    });

    test("try/catch binds the thrown value", () => {
        expect(value('try { throw regenError("boom"); } catch (e) { return e.message; } return "no";')).toBe(
            "boom",
        );
    });

    test("internal errors are catchable as regenError-like maps", () => {
        expect(value("try { var a = [1]; return a[5]; } catch (e) { return e.message; }")).toMatch(
            /out of bounds/,
        );
    });

    test("try expressions yield undefined on failure", () => {
        expect(value("return try silent([1][3]);")).toBeUndefined();
    });

    test("runaway loops abort and cannot be caught", () => {
        const interpreter = createInterpreter({ maxSteps: 10_000 });
        const module = interpreter.load({
            path: "t",
            source: "export function main() { try { while (true) {} } catch { } }",
        });
        expect(() => interpreter.callFunction(module.exports.get("main"), [])).toThrow(/Execution limit/);
    });
});

describe("functions, types and overloads", () => {
    test("closures capture their environment", () => {
        const prelude = "function adder(n) { return function(x) { return x + n; }; }";
        expect(text("const add2 = adder(2); return mapArray([1, 2], add2);", prelude)).toBe("[ 3, 4 ]");
    });

    test("parameter types are checked", () => {
        const prelude = "function twice(x is number) returns number { return x * 2; }";
        expect(value("return twice(3);", prelude)).toBe(6);
        expect(() => value('return twice("a");', prelude)).toThrow(/must be number/);
    });

    test("overloads dispatch on parameter types", () => {
        const prelude = `
            function describe(x is number) { return "number"; }
            function describe(x is string) { return "string"; }
            function describe(x is map) { return "map"; }`;
        expect(text('return [describe(1), describe("s"), describe({})];', prelude)).toBe(
            '[ "number", "string", "map" ]',
        );
    });

    test("user types tag values through `as` and check with `is`", () => {
        const prelude = `
            export predicate canBePoint(value) { value is map; value.x is number; value.y is number; }
            export type Point typecheck canBePoint;
            export operator+(a is Point, b is Point) returns Point { return { "x" : a.x + b.x, "y" : a.y + b.y } as Point; }
            export function toString(value is Point) { return "(" ~ value.x ~ ", " ~ value.y ~ ")"; }`;
        expect(
            text(
                'const p = { "x" : 1, "y" : 2 } as Point; return [p is Point, p is map, { "x" : 1 } is Point];',
                prelude,
            ),
        ).toBe("[ true, true, false ]");
        expect(value('const p = { "x" : 1, "y" : 2 } as Point; return toString(p + p);', prelude)).toBe(
            "(2, 4)",
        );
        expect(value("return toString(5);", prelude)).toBe("5");
        expect(() => value('return { "x" : "no" } as Point;', prelude)).toThrow(/typecheck/);
    });

    test("enums compare by identity and print by name", () => {
        const prelude = 'export enum Mode { annotation { "Name" : "Fast" } FAST, SLOW }';
        expect(
            value("return Mode.FAST == Mode.FAST && Mode.FAST != Mode.SLOW && Mode.SLOW is Mode;", prelude),
        ).toBe(true);
        expect(text("return Mode.SLOW;", prelude)).toBe("SLOW");
    });

    test("preconditions reject bad arguments", () => {
        const prelude = "function positive(x) precondition { x > 0; } { return x; }";
        expect(value("return positive(1);", prelude)).toBe(1);
        expect(() => value("return positive(-1);", prelude)).toThrow(/Precondition of positive failed/);
    });

    test("recursion works and is depth-limited", () => {
        const prelude =
            "function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); } function forever(n) { return forever(n + 1); }";
        expect(value("return fact(10);", prelude)).toBe(3628800);
        expect(() => value("return forever(0);", prelude)).toThrow(/Call depth/);
    });

    test("printing goes to the log", () => {
        expect(run('println("x = " ~ 3); print(1, 2);').log).toEqual(["x = 3", "12"]);
    });
});

describe("std geometry", () => {
    test("vectors carry units element-wise", () => {
        expect(text("return vector(1, 2, 3) * inch + vector(0, 0, 1) * inch;")).toBe(
            "[ 0.0254 meter, 0.0508 meter, 0.1016 meter ]",
        );
        expect(text("return norm(vector(3, 4) * meter);")).toBe("5 meter");
        expect(text("return cross(X_DIRECTION, Y_DIRECTION);")).toBe("[ 0, 0, 1 ]");
        expect(value("return dot(vector(1, 2, 3), vector(4, 5, 6));")).toBe(32);
    });

    test("transforms compose and apply to points", () => {
        const result = text(
            "const t = rotationAround(line(WORLD_ORIGIN, Z_DIRECTION), 90 * degree) * transform(vector(1, 0, 0) * meter); return t * (vector(1, 0, 0) * meter);",
        );
        // translate to (2,0,0), then rotate about Z → (0,2,0)
        const numbers = result.match(/-?\d[\d.]*(?:e-?\d+)?/g)!.map(Number);
        expect(numbers[0]).toBeCloseTo(0, 9);
        expect(numbers[1]).toBeCloseTo(2, 9);
        expect(numbers[2]).toBeCloseTo(0, 9);
    });

    test("planes convert between local and world coordinates", () => {
        const result = value(
            "const p = plane(vector(0, 0, 1) * meter, Z_DIRECTION, X_DIRECTION); return planeToWorld(p, vector(1, 2) * meter);",
        );
        expect(toDisplayString(result)).toBe("[ 1 meter, 2 meter, 1 meter ]");
    });

    test("Ids append with +", () => {
        expect(text('return newId() + "a" + "b";')).toBe('[ "a", "b" ]');
        expect(value('return (newId() + "a") is Id;')).toBe(true);
    });
});

describe("std containers", () => {
    test("array helpers", () => {
        expect(
            text(
                "return [size([1, 2]), append([1], 2), concatenate([1], [2, 3]), reverse([1, 2]), subArray([1, 2, 3], 1)];",
            ),
        ).toBe("[ 2, [ 1, 2 ], [ 1, 2, 3 ], [ 2, 1 ], [ 2, 3 ] ]");
        expect(text("return sort([3, 1, 2], function(a, b) { return a - b; });")).toBe("[ 1, 2, 3 ]");
        expect(text("return filter(range(1, 6), function(x) { return x % 2 == 0; });")).toBe("[ 2, 4, 6 ]");
        expect(text("return range(0 * meter, 1 * meter, 3);")).toBe("[ 0 meter, 0.5 meter, 1 meter ]");
    });

    test("map helpers", () => {
        const result = value('return mergeMaps({ "a" : 1, "b" : { "c" : 1 } }, { "b" : { "d" : 2 } });');
        expect(result).toBeInstanceOf(FsMap);
        expect(toDisplayString(result)).toBe("{ a : 1, b : { c : 1, d : 2 } }");
        expect(text('return keys({ "a" : 1, "b" : 2 });')).toBe('[ "a", "b" ]');
    });
});

describe("language forms Onshape's std uses", () => {
    test.each([
        // `switch` evaluates only the matching case; no match is undefined.
        ['return switch (2) { 1 : "one", 2 : "two" };', "two"],
        ['return switch (3) { 1 : "one", 2 : "two" };', undefined],
        // Arrow functions: expression bodies, typed parameters, map-literal bodies.
        ["const twice = x => x * 2; return twice(4);", 8],
        ["const add = (a is number, b is number) returns number => a + b; return add(2, 3);", 5],
        ['const wrap = (i) => { "index" : i }; return wrap(7).index;', 7],
        ["const f = (n) => { const m = n + 1; return m * 2; }; return f(1);", 4],
        // `a->f(b)` calls `f(a, b)`.
        ["return [3, 1, 2]->size();", 3],
        // `??` and `?.`.
        ["var m = {}; return m.missing ?? 5;", 5],
        ["var m = undefined; return m?.a.b;", undefined],
        ['var m = { "a" : { "b" : 1 } }; return m?.a.b;', 1],
        // Bare identifier map keys are strings; other keys are expressions.
        ["const k = 2; return { a : 1, (k) : 3 }[2];", 3],
        ['return { a : 1 }["a"];', 1],
    ])("%s", (source, expected) => {
        expect(value(source)).toEqual(expected);
    });

    test("`as` binds tighter than arithmetic", () => {
        expect(text("return [1, 2] as Vector * 2;")).toBe("[ 2, 4 ]");
    });

    test("maps iterate in key order, and one loop variable walks key/value entries", () => {
        expect(
            text(
                'var out = ""; for (var e in { "c" : 3, "a" : 1, "b" : 2 }) out ~= e.key ~ e.value; return out;',
            ),
        ).toBe("a1b2c3");
    });

    test("storing undefined removes a key", () => {
        expect(value('var m = { "a" : 1, "b" : 2 }; m.a = undefined; return size(m);')).toBe(1);
        expect(value('return size({ "a" : undefined });')).toBe(0);
    });

    test("a one-expression precondition guards a function", () => {
        const prelude = "function half(x is number) precondition x > 0; { return x / 2; }";
        expect(value("return half(4);", prelude)).toBe(2);
        expect(() => value("return half(-4);", prelude)).toThrow(/Precondition of half failed/);
    });

    test("the most specific overload wins, whatever the declaration order", () => {
        const prelude =
            'function kind(v) { return "any"; } function kind(v is map) { return "map"; } function kind(v is Vector) { return "vector"; }';
        expect(value("return [kind(1), kind({}), kind(vector(1, 2))];", prelude)).toEqual(
            value('return ["any", "map", "vector"];'),
        );
    });

    test("enum values convert from their names, and compare equal to them", () => {
        const prelude = "enum Mode { FAST, SLOW }";
        expect(value('return ("SLOW" as Mode) == Mode.SLOW;', prelude)).toBe(true);
        expect(value('return Mode["FAST"] == "FAST";', prelude)).toBe(true);
        expect(value('return Mode["NOPE"];', prelude)).toBeUndefined();
    });

    test("a constant may refer to one declared after it", () => {
        expect(value("return LATER + 1;", "const EARLIER = LATER * 2; const LATER = 20;")).toBe(21);
        expect(value("return EARLIER;", "const EARLIER = LATER * 2; const LATER = 20;")).toBe(40);
    });

    test("inf is a language constant", () => {
        expect(value("return inf > 1e300;")).toBe(true);
    });
});

describe("syntax errors", () => {
    test("report the line and column", () => {
        const interpreter = createInterpreter();
        let error: unknown;
        try {
            interpreter.load({
                path: "bad",
                source: "FeatureScript 1;\nexport function f() {\n  return 1 +;\n}",
            });
        } catch (err) {
            error = err;
        }
        expect(error).toBeInstanceOf(FsSyntaxError);
        expect((error as FsSyntaxError).pos).toEqual({ line: 3, column: 13, file: "bad" });
    });
});
