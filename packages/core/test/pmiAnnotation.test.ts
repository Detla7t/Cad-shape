// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { XYZ } from "../src/math";
import { Node } from "../src/model/node";
import { isNodeIcon } from "../src/model/nodeIcon";
import {
    datumLabelAt,
    GDT_SYMBOLS,
    GdtSymbolConverter,
    nextDatumLabel,
    nextFlagNumber,
    PmiDatum,
    PmiDimension,
    PmiFeatureControlFrame,
    PmiFlag,
    PmiNote,
    pmiGeometry,
} from "../src/model/pmiAnnotation";
import { PropertyUtils } from "../src/property";
import { Serializer } from "../src/serialize";
import { TestDocument } from "../test-utils";

const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });
const near = (a: XYZ, b: XYZ) => a.distanceTo(b) < 1e-9;

describe("PMI annotation nodes", () => {
    test("the fourteen geometric characteristics read as symbol plus name and parse back", () => {
        expect(GDT_SYMBOLS).toHaveLength(14);
        expect(new Set(GDT_SYMBOLS.map((item) => item.symbol)).size).toBe(14);
        const converter = new GdtSymbolConverter();
        // the test locale is the identity locale: a key translates to itself
        expect(converter.convert("⌖").unchecked()).toBe("⌖  gdt.position");
        expect(converter.convertBack("⌖  gdt.position").unchecked()).toBe("⌖");
        expect(converter.convertBack("⏥").unchecked()).toBe("⏥");
        expect(converter.convertBack("nonsense").isOk).toBe(false);
    });

    test("a note splits its lines on newlines, typed or real, and a general note has no leader", () => {
        const doc = new TestDocument();
        const note = new PmiNote({
            document: doc,
            anchor: p(0, 0, 0),
            position: p(10, 5, 0),
            text: "UNLESS OTHERWISE SPECIFIED:\\nALL DIMENSIONS ARE IN MILLIMETERS\nBREAK EDGES",
        });
        expect(note.lines()).toEqual([
            "UNLESS OTHERWISE SPECIFIED:",
            "ALL DIMENSIONS ARE IN MILLIMETERS",
            "BREAK EDGES",
        ]);
        expect(note.kind).toBe("note");
        expect(note.hasLeader).toBe(true);
        expect(note.terminator).toBe("dot");
        note.leader = false;
        expect(note.hasLeader).toBe(false);
        expect(note.name).toBe("Note");
        expect(isNodeIcon(note) && note.icon).toBe("icon-annotation");
        expect(note.display()).toBe("annotation.pmi");
        const names = PropertyUtils.getProperties(Object.getPrototypeOf(note), Node.prototype).map(
            (x) => x.name,
        );
        expect(names).toEqual(
            expect.arrayContaining(["color", "anchor", "position", "content", "leader", "terminator"]),
        );
    });

    test("a dimension prints prefix, symbol, the value in document units, tolerance and suffix", () => {
        const doc = new TestDocument();
        const dimension = new PmiDimension({
            document: doc,
            anchor: p(0, 0, 0),
            axis: XYZ.unitZ,
            position: p(20, 0, 0),
            dimensionType: "diameter",
            value: 5,
            prefix: "3X",
            tolerance: "±0.05",
            suffix: "⌵10±0.1",
        });
        expect(dimension.text()).toBe("3X ⌀5.00±0.05 ⌵10±0.1");
        dimension.dimensionType = "radius";
        dimension.prefix = "";
        dimension.suffix = "";
        expect(dimension.text()).toBe("R5.00±0.05");
        dimension.dimensionType = "linear";
        dimension.tolerance = "";
        doc.userData = { displayUnits: { length: "in", lengthPrecision: 3 } };
        expect(dimension.text()).toBe("0.197");
    });

    test("a feature control frame's compartments are the symbol, the tolerance with its modifier and each datum", () => {
        const doc = new TestDocument();
        const frame = new PmiFeatureControlFrame({
            document: doc,
            anchor: p(0, 0, 0),
            position: p(5, 5, 5),
            symbol: "⌖",
            tolerance: "⌀0.1",
            modifier: "Ⓜ",
            datums: "A | B-C, D",
        });
        expect(frame.cells()).toEqual(["⌖", "⌀0.1 Ⓜ", "A", "B-C", "D"]);
        expect(frame.text()).toBe("⌖ | ⌀0.1 Ⓜ | A | B-C | D");
        expect(frame.kind).toBe("gdt");
    });

    test("datum labels skip I, O and Q, double after Z and take the first free letter", () => {
        expect([0, 1, 7, 8, 12, 13, 14, 22].map(datumLabelAt)).toEqual([
            "A",
            "B",
            "H",
            "J",
            "N",
            "P",
            "R",
            "Z",
        ]);
        expect(datumLabelAt(23)).toBe("AA");
        const doc = new TestDocument();
        expect(nextDatumLabel(doc)).toBe("A");
        doc.modelManager.addNode(
            new PmiDatum({ document: doc, anchor: p(0, 0, 0), position: p(1, 1, 1), label: "A" }),
            new PmiDatum({ document: doc, anchor: p(0, 0, 0), position: p(1, 1, 1), label: "B" }),
        );
        expect(nextDatumLabel(doc)).toBe("C");
        expect(nextFlagNumber(doc)).toBe(1);
        doc.modelManager.addNode(
            new PmiFlag({ document: doc, anchor: p(0, 0, 0), position: p(1, 1, 1), text: "1" }),
            new PmiFlag({ document: doc, anchor: p(0, 0, 0), position: p(1, 1, 1), text: "3" }),
        );
        expect(nextFlagNumber(doc)).toBe(4);
    });

    test("lock, text size and line width have defaults, clamp, and save with the node", () => {
        const doc = new TestDocument();
        const note = new PmiNote({ document: doc, anchor: p(0, 0, 0), position: p(1, 0, 0), text: "A" });
        expect(note.locked).toBe(false);
        expect(note.textSize).toBe(15);
        expect(note.lineWidth).toBe(1);
        note.textSize = 200;
        expect(note.textSize).toBe(72);
        note.textSize = Number.NaN;
        expect(note.textSize).toBe(15);
        note.lineWidth = 0;
        expect(note.lineWidth).toBe(1);
        note.lineWidth = 2.5;
        note.locked = true;
        const copy = Serializer.deserializeObject(doc, Serializer.serializeObject(note)) as PmiNote;
        expect([copy.locked, copy.textSize, copy.lineWidth]).toEqual([true, 15, 2.5]);
        const names = PropertyUtils.getProperties(Object.getPrototypeOf(note), Node.prototype).map(
            (x) => x.name,
        );
        expect(names).toEqual(expect.arrayContaining(["locked", "textSize", "lineWidth"]));
    });

    test("annotations serialize by class and come back with their anchors and text", () => {
        const doc = new TestDocument();
        const frame = new PmiFeatureControlFrame({
            document: doc,
            anchor: p(1, 2, 3),
            position: p(4, 5, 6),
            symbol: "⏥",
            tolerance: "0.1",
            datums: "",
            terminator: "arrow",
            color: 0x00ff00,
        });
        const data = Serializer.serializeObject(frame);
        expect(data["__cla$$__"]).toBe("PmiFeatureControlFrame");
        const copy = Serializer.deserializeObject(doc, data) as PmiFeatureControlFrame;
        expect(copy).toBeInstanceOf(PmiFeatureControlFrame);
        expect(copy.cells()).toEqual(["⏥", "0.1"]);
        expect(near(copy.anchor, p(1, 2, 3))).toBe(true);
        expect(near(copy.position, p(4, 5, 6))).toBe(true);
        expect(copy.terminator).toBe("arrow");
        expect(copy.color).toBe(0x00ff00);
        expect(copy.id).toBe(frame.id);

        const note = Serializer.deserializeObject(
            doc,
            Serializer.serializeObject(
                new PmiNote({
                    document: doc,
                    anchor: p(0, 0, 0),
                    position: p(0, 0, 0),
                    text: "A\\nB",
                    leader: false,
                }),
            ),
        ) as PmiNote;
        expect(note.lines()).toEqual(["A", "B"]);
        expect(note.hasLeader).toBe(false);
    });
});

describe("pmiGeometry", () => {
    const doc = new TestDocument();

    test("a leader note draws one line to its frame with the chosen terminator at the anchor", () => {
        const note = new PmiNote({ document: doc, anchor: p(0, 0, 0), position: p(10, 5, 0), text: "NOTE" });
        const geometry = pmiGeometry(note);
        expect(geometry.segments).toHaveLength(1);
        expect(near(geometry.segments[0][0], p(0, 0, 0)) && near(geometry.segments[0][1], p(10, 5, 0))).toBe(
            true,
        );
        expect(geometry.labelAlign).toBe("leader");
        expect(near(geometry.labelFrom, p(0, 0, 0))).toBe(true);
        expect(geometry.terminators).toEqual([{ point: note.anchor, toward: note.position, shape: "dot" }]);
        note.terminator = "none";
        expect(pmiGeometry(note).terminators).toEqual([]);
        note.leader = false;
        const general = pmiGeometry(note);
        expect(general.segments).toEqual([]);
        expect(general.labelAlign).toBe("start");
    });

    test("a datum feature symbol always ends in its triangle", () => {
        const datum = new PmiDatum({ document: doc, anchor: p(0, 0, 0), position: p(0, 0, 8), label: "A" });
        expect(pmiGeometry(datum).terminators).toEqual([
            { point: datum.anchor, toward: datum.position, shape: "triangle" },
        ]);
    });

    test("a linear dimension runs extension lines to a dimension line through the frame point", () => {
        const dimension = new PmiDimension({
            document: doc,
            anchor: p(0, 0, 0),
            anchor2: p(10, 0, 0),
            position: p(3, 5, 0),
            value: 10,
        });
        const geometry = pmiGeometry(dimension);
        expect(geometry.segments).toHaveLength(3);
        const [ext1, ext2, line] = geometry.segments;
        expect(near(ext1[0], p(0, 0, 0)) && near(ext1[1], p(0, 5, 0))).toBe(true);
        expect(near(ext2[0], p(10, 0, 0)) && near(ext2[1], p(10, 5, 0))).toBe(true);
        expect(near(line[0], p(0, 5, 0)) && near(line[1], p(10, 5, 0))).toBe(true);
        expect(near(geometry.labelPoint, p(5, 5, 0))).toBe(true);
        expect(geometry.labelAlign).toBe("above");
        expect(geometry.terminators.map((t) => t.shape)).toEqual(["arrow", "arrow"]);
        expect(
            near(geometry.terminators[0].point, p(0, 5, 0)) &&
                near(geometry.terminators[0].toward, p(10, 5, 0)),
        ).toBe(true);
        expect(
            near(geometry.terminators[1].point, p(10, 5, 0)) &&
                near(geometry.terminators[1].toward, p(0, 5, 0)),
        ).toBe(true);
    });

    test("a diameter leads from the circle point facing the frame, even when the frame sits on the axis", () => {
        const dimension = new PmiDimension({
            document: doc,
            dimensionType: "diameter",
            anchor: p(0, 0, 0),
            axis: XYZ.unitZ,
            position: p(20, 0, 3),
            value: 10,
        });
        const geometry = pmiGeometry(dimension);
        expect(geometry.segments).toHaveLength(1);
        expect(near(geometry.segments[0][0], p(5, 0, 0))).toBe(true);
        expect(near(geometry.segments[0][1], p(20, 0, 3))).toBe(true);
        expect(geometry.labelAlign).toBe("leader");
        expect(geometry.terminators).toEqual([{ point: p(5, 0, 0), toward: p(20, 0, 3), shape: "arrow" }]);

        dimension.position = p(0, 0, 20);
        const onAxis = pmiGeometry(dimension).segments[0][0];
        expect(Math.abs(onAxis.length() - 5)).toBeLessThan(1e-9);
        expect(Math.abs(onAxis.dot(XYZ.unitZ))).toBeLessThan(1e-9);

        dimension.dimensionType = "radius";
        dimension.value = 5;
        dimension.position = p(0, 20, 0);
        expect(near(pmiGeometry(dimension).segments[0][0], p(0, 5, 0))).toBe(true);
    });
});
