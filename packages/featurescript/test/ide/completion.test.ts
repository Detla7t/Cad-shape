// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CompletionItem, completeAt } from "../../src/ide/completion";
import type { StudioSource } from "../../src/ide/symbols";
import { analyze, HEADER, withCursor } from "./_helpers";

function complete(
    marked: string,
    options: {
        explicit?: boolean;
        studios?: StudioSource[];
        studioNames?: string[];
        stdModules?: string[];
    } = {},
) {
    const { source, pos } = withCursor(marked);
    const analysis = analyze(source, options.studios);
    return completeAt({
        ...analysis,
        pos,
        explicit: options.explicit ?? false,
        studioNames: options.studioNames,
        stdModules: options.stdModules,
    });
}

const labels = (items: readonly CompletionItem[] | undefined) => (items ?? []).map((item) => item.label);
const item = (items: readonly CompletionItem[] | undefined, label: string) =>
    items?.find((i) => i.label === label);

const FEATURE = `${HEADER}
annotation { "Feature Type Name" : "Slot" }
export const slot = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Width" }
        isLength(definition.width, LENGTH_BOUNDS);
        annotation { "Name" : "Path", "Filter" : EntityType.EDGE }
        definition.path is Query;
        definition.side is BoundingType;
        ‸PRECONDITION
    }
    {
        var total = 0;
        for (var edge in evaluateQuery(context, definition.path))
        {
            ‸BODY
        }
    });

function helper(a is number) returns number
{
    return a;
}
`;

/** FEATURE with the cursor at one of its marked places, `text` typed there. */
function inFeature(place: "PRECONDITION" | "BODY", text: string): string {
    return FEATURE.replace(`‸${place}`, `${text}‸`).replace(/‸(PRECONDITION|BODY)/g, "");
}

describe("identifier completion", () => {
    test("a std prefix offers std functions with their signature and doc", () => {
        const result = complete(inFeature("BODY", "opExtr"));
        expect(result).not.toBeNull();
        const op = item(result?.items, "opExtrude");
        expect(op?.kind).toBe("function");
        expect(op?.detail).toBe("(context, id, definition)");
        expect(op?.symbol?.origin).toEqual({ kind: "std", module: "geomOperations.fs" });
        expect(result?.from).toBe(withCursor(inFeature("BODY", "opExtr")).pos - "opExtr".length);
    });

    test("std ops with a documented definition map come with a call template of their required fields", () => {
        const template = item(complete(inFeature("BODY", "opExtr"))?.items, "opExtrude(…)");
        expect(template?.kind).toBe("snippet");
        expect(template?.snippet).toContain('opExtrude(context, id + "#{extrude1}", {');
        expect(template?.snippet).toContain('"entities" : #{entities}');
        expect(template?.snippet).not.toContain("startBound");
    });

    test("locals in scope come first: loop variable, var, the feature's parameters", () => {
        const items = complete(inFeature("BODY", "e"))?.items;
        expect(item(items, "edge")).toMatchObject({ kind: "variable", boost: 3 });
        expect(item(items, "total")?.kind).toBe("variable");
        expect(item(items, "definition")).toMatchObject({ kind: "parameter", detail: "map" });
        expect(item(items, "context")).toMatchObject({ kind: "parameter", detail: "Context" });
    });

    test("the studio's own declarations and keywords are offered", () => {
        const items = complete(inFeature("BODY", "h"))?.items;
        expect(item(items, "helper")).toMatchObject({ kind: "function", detail: "(a) → number", boost: 2 });
        expect(item(items, "slot")?.kind).toBe("feature");
        expect(item(items, "while")?.kind).toBe("keyword");
    });

    test("snippets depend on where the cursor is", () => {
        const snippets = (marked: string) =>
            labels(
                complete(marked)?.items.filter(
                    (candidate) => candidate.kind === "snippet" && candidate.symbol === undefined,
                ),
            );
        const body = snippets(inFeature("BODY", "f"));
        expect(body).toEqual(expect.arrayContaining(["for", "for in", "if", "while", "println"]));
        expect(body).not.toContain("length parameter");
        expect(body).not.toContain("feature");
        const precondition = snippets(inFeature("PRECONDITION", "is"));
        expect(precondition).toEqual(
            expect.arrayContaining(["length parameter", "angle parameter", "query parameter"]),
        );
        const top = snippets(`${HEADER}\nfe‸`);
        expect(top).toEqual(expect.arrayContaining(["feature", "function", "import geometry", "enum"]));
        expect(top).not.toContain("for");
    });

    test("the feature snippet is a full defineFeature with a precondition", () => {
        const feature = item(complete(`${HEADER}\nfe‸`)?.items, "feature");
        expect(feature?.snippet).toContain(
            "defineFeature(function(context is Context, id is Id, definition is map)",
        );
        expect(feature?.snippet).toContain("\tprecondition");
        expect(feature?.snippet).toContain("isLength(definition.#{length}, LENGTH_BOUNDS);");
    });

    test("nothing is offered without a prefix unless asked", () => {
        expect(complete(inFeature("BODY", ""))).toBeNull();
        expect(complete(inFeature("BODY", ""), { explicit: true })?.items.length).toBeGreaterThan(100);
    });

    test("nothing to complete in comments, numbers or after a declaring keyword", () => {
        expect(complete(`${HEADER}\n// opExt‸`)).toBeNull();
        expect(complete(`${HEADER}\n/* opExt‸ */`)).toBeNull();
        expect(complete(inFeature("BODY", "var to"))).toBeNull();
        expect(complete(inFeature("BODY", "x = 12‸"))).toBeNull();
    });

    test("exports of an imported studio, with where they come from", () => {
        const studios: StudioSource[] = [
            {
                id: "s2",
                name: "Fasteners",
                source: `${HEADER}export function boltHole(context is Context) { }\nfunction secret() { }`,
            },
        ];
        const source = `${HEADER}import(path : "Fasteners", version : "");\nexport function f() { bolt‸ }`;
        const items = complete(source, { studios })?.items;
        expect(item(items, "boltHole")).toMatchObject({
            kind: "function",
            detail: "(context) · Fasteners",
            boost: 1,
        });
        expect(item(items, "secret")).toBeUndefined();
    });
});

describe("member completion", () => {
    test("enum members after `Enum.`, in declaration order, with their names and docs", () => {
        const result = complete(inFeature("BODY", "BoundingType."));
        expect(labels(result?.items).slice(0, 3)).toEqual(["BLIND", "UP_TO_NEXT", "UP_TO_SURFACE"]);
        expect(item(result?.items, "BLIND")).toMatchObject({
            kind: "enumMember",
            detail: '"Blind"',
            info: "Extrude a specific distance.",
        });
        const boosts = result?.items.map((i) => i.boost ?? 0) ?? [];
        expect(boosts[0]).toBeGreaterThan(boosts[1]);
    });

    test("`definition.` inside a feature lists its precondition parameters", () => {
        const items = complete(inFeature("BODY", "definition.w"))?.items;
        expect(labels(items)).toEqual(["width", "path", "side"]);
        expect(item(items, "width")?.detail).toBe('"Width" length · LENGTH_BOUNDS');
        expect(item(items, "path")?.detail).toBe('"Path" Query');
    });

    test("members of something unknown offer nothing rather than everything", () => {
        expect(complete(inFeature("BODY", "total.x"))).toBeNull();
    });
});

describe("type completion", () => {
    test("after `is`: built-in types, std types and enums", () => {
        const items = complete(inFeature("PRECONDITION", "definition.flip is "), { explicit: false })?.items;
        expect(labels(items)).toEqual(
            expect.arrayContaining(["boolean", "map", "Query", "Context", "BoundingType"]),
        );
        expect(labels(items)).not.toContain("opExtrude");
    });

    test("after `returns` too", () => {
        expect(labels(complete(`${HEADER}\nfunction f() returns Vec‸`)?.items)).toContain("Vector");
    });
});

describe("string completion", () => {
    test('annotation keys inside `annotation { "` ', () => {
        const result = complete(inFeature("PRECONDITION", 'annotation { "‸" }').replace('‸" }‸', '‸" }'));
        expect(labels(result?.items)).toEqual(
            expect.arrayContaining(["Name", "UIHint", "Filter", "MaxNumberOfPicks", "Default"]),
        );
        expect(item(result?.items, "Feature Type Name")?.kind).toBe("annotationKey");
    });

    test("a std op's definition-map keys, in its documented order, with their docs", () => {
        const marked = inFeature("BODY", 'opExtrude(context, id + "e1", { "‸" });').replace(
            '‸" });‸',
            '‸" });',
        );
        const { source, pos } = withCursor(marked);
        const result = complete(marked);
        expect(result?.from).toBe(pos);
        expect(source[result?.to ?? 0]).toBe('"');
        expect(labels(result?.items).slice(0, 3)).toEqual(["entities", "direction", "endBound"]);
        expect(item(result?.items, "endDepth")?.detail).toBe("ValueWithUnits · required if…");
        expect(item(result?.items, "entities")?.info).toBe("Edges and faces to extrude.");
    });

    test("the keys after a first entry, and a studio feature's parameters for its definition map", () => {
        const marked = inFeature(
            "BODY",
            'slot(context, id + "s", { "width" : 1 * millimeter, "p‸" });',
        ).replace('‸" });‸', '‸" });');
        expect(labels(complete(marked)?.items)).toEqual(["width", "path", "side"]);
    });

    test("import paths: other studios and std modules", () => {
        const result = complete(`FeatureScript 3083;\nimport(path : "‸", version : "");`, {
            studioNames: ["Fasteners"],
            stdModules: ["geometry.fs", "vector.fs"],
        });
        expect(labels(result?.items)).toEqual([
            "Fasteners",
            "onshape/std/geometry.fs",
            "onshape/std/vector.fs",
        ]);
    });

    test("a plain string value offers nothing", () => {
        expect(complete(inFeature("BODY", 'println("hel‸");').replace('‸");‸', '‸");'))).toBeNull();
    });
});
