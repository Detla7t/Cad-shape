// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Onshape's own FeatureScript standard library (version 3083, 276 modules, ~150k lines)
 * run on this interpreter: every module parses, `geometry.fs` loads with its whole import
 * graph, and the examples std documents (`@example \`expr\` returns \`value\``) evaluate
 * to the values its documentation states.
 */

import { parseExpression, parseProgram } from "../src/lang/parser";
import { FsMap, type FsValue, toDisplayString } from "../src/lang/values";
import { createOnshapeInterpreter } from "../src/onshape/onshapeStd";
import { describeError } from "../src/runtime";
import { ONSHAPE_STD, STD_BUNDLE } from "./_helpers/onshapeStd";

const GEOMETRY = 'FeatureScript 3083;\nimport(path : "onshape/std/geometry.fs", version : "3083.0");\n';

test("every std module parses", () => {
    const failures: string[] = [];
    for (const [name, source] of Object.entries(STD_BUNDLE.files)) {
        try {
            parseProgram(source, name);
        } catch (error) {
            failures.push(`${name}: ${(error as Error).message}`);
        }
    }
    expect(Object.keys(STD_BUNDLE.files)).toHaveLength(276);
    expect(failures).toEqual([]);
});

test("geometry.fs loads with its whole import graph, and std arithmetic runs on it", () => {
    const interpreter = createOnshapeInterpreter({ std: ONSHAPE_STD });
    const module = interpreter.load({
        path: "probe",
        source: `${GEOMETRY}export const x = toString(2 * inch + 1 * centimeter);\n`,
    });
    expect(module.exports.get("x")).toBe("0.0608 meter");
});

interface DocExample {
    readonly file: string;
    readonly expression: string;
    readonly expected: string;
    readonly mode: "exact" | "approx" | "throws";
}

/** Two documented examples carry typos in std itself: an unquoted string result and a misspelled name. */
const DOC_TYPOS: Record<string, string> = {
    "X~X~a": '"X~X~a"',
    'splitByRegex("foo", "")': 'splitByRegexp("foo", "")',
};

function docExamples(): DocExample[] {
    const examples: DocExample[] = [];
    const result =
        /@example `([^`]+)`\s*(?:\*\s*)?(returns approximately|equals approximately|returns the number|returns|is equivalent to|is|equals|evaluates to)\s*(?:\*\s*)?`([^`]+)`/g;
    for (const [file, source] of Object.entries(STD_BUNDLE.files)) {
        for (const match of source.matchAll(result)) {
            examples.push({
                file,
                expression: DOC_TYPOS[match[1]] ?? match[1],
                expected: DOC_TYPOS[match[3]] ?? match[3],
                mode: match[2].includes("approximately") ? "approx" : "exact",
            });
        }
        for (const match of source.matchAll(/@example `([^`]+)` throws an error/g)) {
            examples.push({ file, expression: match[1], expected: "", mode: "throws" });
        }
    }
    return examples;
}

test("std's documented examples evaluate to their documented results", () => {
    const interpreter = createOnshapeInterpreter({ std: ONSHAPE_STD });
    const env = interpreter.load({ path: "examples", source: GEOMETRY }).env;
    const evaluate = (source: string) => interpreter.evaluate(parseExpression(source), env);
    const magnitude = (v: FsValue) =>
        typeof v === "number"
            ? v
            : v instanceof FsMap && typeof v.field("value") === "number"
              ? (v.field("value") as number)
              : undefined;
    const examples = docExamples();
    const failures: string[] = [];
    for (const example of examples) {
        const label = `${example.file}: ${example.expression}`;
        try {
            if (example.mode === "throws") {
                let threw = false;
                try {
                    evaluate(example.expression);
                } catch {
                    threw = true;
                }
                if (!threw) failures.push(`${label} should throw`);
                continue;
            }
            const actual = evaluate(example.expression);
            const expected = example.expected.trim();
            let ok: boolean;
            if (expected === "-inf") ok = actual === Number.NEGATIVE_INFINITY;
            else if (expected.endsWith("...")) ok = toDisplayString(actual).startsWith(expected.slice(0, -3));
            else {
                const wanted = evaluate(expected);
                ok = interpreter.binary("==", actual, wanted) === true;
                const a = magnitude(actual);
                const b = magnitude(wanted);
                const tolerance = example.mode === "approx" ? 1e-6 : 1e-9;
                if (!ok && a !== undefined && b !== undefined)
                    ok = Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
            }
            if (!ok)
                failures.push(`${label} gave ${toDisplayString(actual)}, documented ${example.expected}`);
        } catch (error) {
            failures.push(`${label} failed: ${describeError(error).error}`);
        }
    }
    expect(examples.length).toBe(115);
    expect(failures).toEqual([]);
});
