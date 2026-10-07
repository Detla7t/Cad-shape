// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { definitionAt, signatureAt, targetAt } from "../../../src/featurescript/ui/ide/navigation";
import { analyze, HEADER, STD_INDEX, withCursor } from "./_helpers";

const STUDIO = `${HEADER}
annotation { "Feature Type Name" : "Slot" }
export const slot = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Width" }
        isLength(definition.width, LENGTH_BOUNDS);
    }
    {
        const half = definition.width / 2;
        opExtrude(context, id + "e", { "entities" : qCreatedBy(id, EntityType.FACE), "endBound" : BoundingType.BLIND });
        println(helper(half));
    });

function helper(a is number) returns number
{
    return a;
}
`;

/** The language-service request at the `occurrence`-th match of `text` in STUDIO, `offset` characters in. */
function at(text: string, offset = 1, occurrence = 0) {
    let index = -1;
    for (let n = 0; n <= occurrence; n++) index = STUDIO.indexOf(text, index + 1);
    if (index < 0) throw new Error(`${text} not found`);
    return { ...analyze(STUDIO), pos: index + offset };
}

describe("hover targets", () => {
    test("a std function", () => {
        const target = targetAt(at("opExtrude("));
        expect(target?.kind).toBe("symbol");
        expect(target?.kind === "symbol" ? target.symbol.origin : undefined).toEqual({
            kind: "std",
            module: "geomOperations.fs",
        });
        expect(STUDIO.slice(target?.from, target?.to)).toBe("opExtrude");
    });

    test("an enum member, with its @value doc", () => {
        const target = targetAt(at("BLIND", 2));
        expect(target).toMatchObject({ kind: "enumMember", text: "Extrude a specific distance." });
    });

    test("a feature parameter through `definition.`", () => {
        const target = targetAt(at("definition.width / 2", "definition.".length + 1));
        expect(target?.kind).toBe("field");
        expect(target?.kind === "field" ? [target.field.label, target.field.type] : []).toEqual([
            "Width",
            "length",
        ]);
    });

    test("a definition-map key of a std op", () => {
        const target = targetAt(at('"entities"', 2));
        expect(target?.kind).toBe("docField");
        expect(target?.kind === "docField" ? target.field.text : "").toBe("Edges and faces to extrude.");
    });

    test("an annotation key", () => {
        const target = targetAt(at('"Feature Type Name"', 3));
        expect(target).toMatchObject({ kind: "annotationKey", key: "Feature Type Name" });
    });

    test("a local constant", () => {
        const target = targetAt(at("helper(half)", "helper(".length + 1));
        expect(target).toMatchObject({ kind: "local", local: { name: "half", kind: "constant" } });
    });

    test("nothing for keywords, numbers or unknown names", () => {
        expect(targetAt(at("return a"))).toBeUndefined();
        expect(targetAt(at("/ 2", 2))).toBeUndefined();
    });
});

describe("go to definition", () => {
    test("a local constant jumps to its declaration", () => {
        const location = definitionAt(at("helper(half)", "helper(".length + 1));
        expect(location?.kind).toBe("local");
        expect(STUDIO.slice(location?.from, location?.to)).toBe("half");
        expect(location?.from).toBe(STUDIO.indexOf("half ="));
    });

    test("a function of the studio jumps to its name", () => {
        const location = definitionAt(at("helper(half)", 2));
        expect(location).toEqual({
            kind: "local",
            from: STUDIO.indexOf("helper(a"),
            to: STUDIO.indexOf("helper(a") + "helper".length,
        });
    });

    test("a feature parameter jumps to where the precondition declares it", () => {
        const location = definitionAt(at("definition.width / 2", "definition.".length + 1));
        expect(location?.kind).toBe("local");
        expect(location?.from).toBe(STUDIO.indexOf("definition.width, LENGTH_BOUNDS") + "definition.".length);
    });

    test("a std symbol opens its module at the declared name", () => {
        const location = definitionAt(at("qCreatedBy"));
        expect(location?.kind).toBe("std");
        if (location?.kind !== "std") throw new Error("expected a std location");
        expect(location.module).toBe("query.fs");
        const source = STD_INDEX.module(location.module)?.source ?? "";
        expect(source.slice(location.from, location.to)).toBe("qCreatedBy");
    });

    test("an enum member opens the std enum at that member", () => {
        const location = definitionAt(at("BLIND", 2));
        if (location?.kind !== "std") throw new Error("expected a std location");
        expect(STD_INDEX.module(location.module)?.source.slice(location.from, location.to)).toBe("BLIND");
    });

    test("a symbol of an imported studio opens that studio", () => {
        const source = `${HEADER}import(path : "Fasteners", version : "");\nexport function f() { boltHole(); }`;
        const fasteners = {
            id: "s2",
            name: "Fasteners",
            source: `${HEADER}\nexport function boltHole() { }`,
        };
        const { pos } = withCursor(source.replace("boltHole(", "bolt‸Hole("));
        const location = definitionAt({ ...analyze(source, [fasteners]), pos });
        expect(location).toMatchObject({ kind: "studio", studioId: "s2", studioName: "Fasteners" });
        expect(fasteners.source.slice(location?.from, location?.to)).toBe("boltHole");
    });
});

describe("signature help", () => {
    test("the active argument of a std call", () => {
        const help = signatureAt(at('id + "e"', 2));
        expect(help?.symbol.name).toBe("opExtrude");
        expect(help?.argument).toBe(1);
        expect(help?.signatures[0].params.map((param) => param.name)).toEqual([
            "context",
            "id",
            "definition",
        ]);
        expect(help?.open).toBe(STUDIO.indexOf("opExtrude(") + "opExtrude".length);
    });

    test("inside the definition map the map's argument stays active", () => {
        const help = signatureAt(at('"endBound"', 2));
        expect(help?.symbol.name).toBe("opExtrude");
        expect(help?.argument).toBe(2);
    });

    test("the innermost call wins, and the overload that fits the argument count is active", () => {
        const help = signatureAt(at("EntityType.FACE", 1));
        expect(help?.symbol.name).toBe("qCreatedBy");
        expect(help?.argument).toBe(1);
        expect(help?.signatures[help.active].params.length).toBeGreaterThan(1);
    });

    test("not inside a block or outside any call", () => {
        expect(signatureAt(at("const half"))).toBeUndefined();
        expect(signatureAt(at("return a"))).toBeUndefined();
    });
});
