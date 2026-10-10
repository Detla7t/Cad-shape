// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DialogButton,
    type DownloadedFile,
    type I18nKeys,
    PubSub,
    setDownloadDelivery,
} from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { type Drawing, type DrawingSelection, readDxf, writeDxf } from "@chili3d/drawing";
import { importDxf } from "../src/cad/dxfToDrawing";
import { DocumentFileNode } from "../src/documentFileNode";
import { exportDrawingFile, showExportDrawingDialog } from "../src/ui/exportDialog";
import { chooseExportSelection, createDrawingViewer } from "../src/ui/viewers/drawingViewer";

// Black and a green override on Cut, a red override on Cut (the same red as Bend, ByLayer).
const colored: Drawing = {
    units: "mm",
    layers: [
        { name: "Cut", aci: 7, color: "#000000" },
        { name: "Bend", aci: 1, color: "#FF0000", dashed: true },
    ],
    entities: [
        { kind: "line", layer: "Cut", a: [0, 0], b: [40, 0] },
        { kind: "line", layer: "Cut", a: [0, 10], b: [40, 10], color: "#00ff00" },
        { kind: "circle", layer: "Cut", center: [20, 5], radius: 2, color: "#f00" },
        { kind: "arc", layer: "Bend", center: [0, 0], radius: 5, startAngle: 0, endAngle: 90 },
    ],
};
const single: Drawing = {
    units: "mm",
    layers: [{ name: "0", aci: 7, color: "#000000" }],
    entities: [{ kind: "line", layer: "0", a: [0, 0], b: [40, 0] }],
};

const files: DownloadedFile[] = [];
beforeEach(() => {
    files.length = 0;
    setDownloadDelivery((file) => {
        files.push(file);
        return true;
    });
});
afterEach(() => setDownloadDelivery(undefined));

const entitiesOf = (text: string) => readDxf(text).entities.map((entity) => `${entity.type}@${entity.layer}`);

describe("exporting a drawing with a selection", () => {
    test.each<[string, DrawingSelection, string[]]>([
        ["the red override and red ByLayer", { colors: ["#ff0000"] }, ["CIRCLE@Cut", "ARC@Bend"]],
        ["black only", { colors: ["#000000"] }, ["LINE@Cut"]],
        ["layer AND colour", { layers: ["Cut"], colors: ["#FF0000"] }, ["CIRCLE@Cut"]],
        ["a layer without that colour", { layers: ["Bend"], colors: ["#00ff00"] }, []],
        ["no lists", {}, ["LINE@Cut", "LINE@Cut", "CIRCLE@Cut", "ARC@Bend"]],
    ])("DXF keeps %s", async (_name, selection, expected) => {
        await exportDrawingFile(colored, {
            fileName: "Plate.dxf",
            format: ".dxf",
            units: "mm",
            properties: {},
            selection,
        });
        expect(files.map((file) => file.name)).toEqual(["Plate.dxf"]);
        expect(entitiesOf(await files[0].blob.text())).toEqual(expected);
    });

    test("the DXF circle keeps its override as ACI 1 while the ByLayer arc carries none", async () => {
        await exportDrawingFile(colored, {
            fileName: "Plate.dxf",
            format: ".dxf",
            units: "mm",
            properties: {},
            selection: { colors: ["#ff0000"] },
        });
        const [circle, arc] = readDxf(await files[0].blob.text()).entities;
        expect(circle.values[62]).toBe(1);
        expect(arc.values[62]).toBeUndefined();
    });

    test("SVG keeps the green override only", async () => {
        await exportDrawingFile(colored, {
            fileName: "Plate.svg",
            format: ".svg",
            units: "mm",
            properties: {},
            selection: { colors: ["#00ff00"] },
        });
        const svg = await files[0].blob.text();
        expect(svg.match(/<line /g)).toHaveLength(1);
        expect(svg).toContain('stroke="#00ff00"');
        expect(svg).not.toContain("<circle");
        expect(svg).not.toContain("<path");
    });
});

type Shown = { content: HTMLElement; buttons: DialogButton[] };
function showDialog(drawing: Drawing, format: ".dxf" | ".svg" = ".dxf"): Shown {
    let shown: Shown | undefined;
    const onDialog = (_title: I18nKeys, content: HTMLElement, buttons?: DialogButton[] | (() => void)) => {
        shown = { content, buttons: buttons as DialogButton[] };
    };
    PubSub.default.sub("showDialog", onDialog);
    try {
        showExportDrawingDialog({
            document: new TestDocument(),
            name: "Plate",
            drawing: () => drawing,
            format,
        });
    } finally {
        PubSub.default.remove("showDialog", onDialog);
    }
    expect(shown).not.toBeUndefined();
    return shown!;
}
const colorBoxes = (root: ParentNode) =>
    [...root.querySelectorAll<HTMLInputElement>('input[aria-label^="documents.exportDialog.colors: "]')].map(
        (box) => box.value,
    );

describe("the export dialog", () => {
    test("lists each colour with a swatch and a count, all ticked, and exports the ticked ones", async () => {
        const { content, buttons } = showDialog(colored);
        expect(colorBoxes(content)).toEqual(["#000000", "#00ff00", "#ff0000"]);
        const red = content.querySelector<HTMLInputElement>(
            'input[aria-label="documents.exportDialog.colors: #ff0000"]',
        );
        expect(red).not.toBeNull();
        expect(red!.checked).toBe(true);
        const row = red!.closest("label")!;
        expect(row.textContent).toContain("(2)");
        expect((row.querySelector("span") as HTMLElement).style.backgroundColor).not.toBe("");

        red!.checked = false;
        red!.dispatchEvent(new Event("change"));
        const cut = content.querySelector<HTMLInputElement>(
            'input[aria-label="documents.exportDialog.layers: Cut"]',
        );
        expect(cut).not.toBeNull();
        await buttons[0].onclick!();
        expect(files.map((file) => file.name)).toEqual(["Plate.dxf"]);
        expect(entitiesOf(await files[0].blob.text())).toEqual(["LINE@Cut", "LINE@Cut"]);
    });

    test("layers and colours combine: Cut alone without black leaves the green line", async () => {
        const { content, buttons } = showDialog(colored, ".svg");
        content.querySelector<HTMLInputElement>(
            'input[aria-label="documents.exportDialog.layers: Bend"]',
        )!.checked = false;
        content.querySelector<HTMLInputElement>(
            'input[aria-label="documents.exportDialog.colors: #000000"]',
        )!.checked = false;
        await buttons[0].onclick!();
        const svg = await files[0].blob.text();
        expect(svg.match(/<line /g)).toHaveLength(1);
        expect(svg).toContain('stroke="#00ff00"');
        expect(svg).toContain('stroke="#ff0000"');
        expect(svg).not.toContain("<path");
    });

    test("one colour, one layer: no choice to offer", () => {
        const { content } = showDialog(single);
        expect(colorBoxes(content)).toEqual([]);
        expect(content.querySelector('input[aria-label^="documents.exportDialog.layers: "]')).toBeNull();
    });
});

/** Happy-DOM's dialog may lack a modal mode; stand in plain open/close and return the restorer. */
function stubModalDialogs(): () => void {
    const proto = HTMLDialogElement.prototype;
    const saved = { showModal: proto.showModal, close: proto.close };
    proto.showModal = function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
    };
    proto.close = function (this: HTMLDialogElement) {
        this.removeAttribute("open");
    };
    return () => {
        proto.showModal = saved.showModal;
        proto.close = saved.close;
    };
}
const selectionPanel = () => {
    const found = document.body.querySelector<HTMLDialogElement>(
        'dialog[aria-label="documents.export.selection"]',
    );
    expect(found).not.toBeNull();
    return found!;
};
const buttonNamed = (root: ParentNode, text: string) => {
    const found = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
    expect(found).not.toBeUndefined();
    return found!;
};
const untick = (root: ParentNode, label: string) => {
    const box = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    expect(box).not.toBeNull();
    box!.checked = false;
};

describe("chooseExportSelection", () => {
    let restore: (() => void) | undefined;
    beforeEach(() => {
        restore = stubModalDialogs();
    });
    afterEach(() => {
        restore?.();
        for (const panel of document.body.querySelectorAll("dialog")) panel.remove();
    });

    test("a single layer and colour resolve at once with an empty selection", async () => {
        await expect(chooseExportSelection(single)).resolves.toEqual({});
        expect(document.body.querySelector("dialog")).toBeNull();
    });

    test("OK resolves the ticked colours; layers stay unrestricted", async () => {
        const chosen = chooseExportSelection(colored);
        const dialog = selectionPanel();
        expect(colorBoxes(dialog)).toEqual(["#000000", "#00ff00", "#ff0000"]);
        untick(dialog, "documents.exportDialog.colors: #000000");
        buttonNamed(dialog, "common.confirm").click();
        await expect(chosen).resolves.toEqual({ layers: undefined, colors: ["#00ff00", "#ff0000"] });
        expect(document.body.querySelector("dialog")).toBeNull();
    });

    test("Cancel resolves undefined", async () => {
        const chosen = chooseExportSelection(colored);
        buttonNamed(selectionPanel(), "common.cancel").click();
        await expect(chosen).resolves.toBeUndefined();
    });
});

describe("the drawing viewer's exports", () => {
    test("DXF and SVG go through the selection dialog, and cancelling aborts", async () => {
        const restore = stubModalDialogs();
        const doc = new TestDocument();
        const node = new DocumentFileNode({
            document: doc,
            fileName: "Plate.dxf",
            format: "dxf",
            text: writeDxf(colored),
        });
        const viewer = createDrawingViewer({ node, document: doc, changed: () => {} });
        try {
            for (let i = 0; i < 5; i++) await Promise.resolve();
            const pick = (extension: string, color: string | undefined) => {
                const entry = viewer.exports!().find((candidate) => candidate.extension === extension);
                expect(entry).not.toBeUndefined();
                const produced = entry!.produce();
                const dialog = selectionPanel();
                if (color === undefined) {
                    buttonNamed(dialog, "common.cancel").click();
                } else {
                    untick(dialog, `documents.exportDialog.colors: ${color}`);
                    buttonNamed(dialog, "common.confirm").click();
                }
                return produced;
            };
            // Imported back, the red circle is ACI 1 (#ff0000) and Cut is ACI 7 (black).
            const dxf = (await pick(".dxf", "#ff0000")) as string;
            expect(entitiesOf(dxf)).toEqual(["LINE@Cut", "LINE@Cut"]);
            const svg = (await pick(".svg", "#000000")) as string;
            expect(svg.match(/<line /g)).toHaveLength(1);
            expect(svg).toMatch(/<circle [^>]*stroke="#ff0000"/);
            expect(svg).toContain("<path");
            await expect(pick(".dxf", undefined)).rejects.toThrow("documents.export.cancelled");
        } finally {
            restore();
            viewer.dispose?.();
            for (const panel of document.body.querySelectorAll("dialog")) panel.remove();
        }
    });
});
describe("DXF import colours", () => {
    const tables =
        "0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\nCut\n70\n0\n62\n5\n0\nENDTAB\n0\nENDSEC";
    const line = (...color: [number, number][]) =>
        `0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nCut\n${color.map(([c, v]) => `${c}\n${v}\n`).join("")}10\n0\n20\n0\n11\n1\n21\n0\n0\nENDSEC\n0\nEOF\n`;

    test.each<[string, [number, number][], string | undefined]>([
        ["ACI 3 is green", [[62, 3]], "#00ff00"],
        ["ByLayer (256) is no override", [[62, 256]], undefined],
        ["no 62 is no override", [], undefined],
        [
            "a true colour wins over the ACI",
            [
                [62, 3],
                [420, 0x123456],
            ],
            "#123456",
        ],
    ])("%s", (_name, color, expected) => {
        const imported = importDxf(`${tables}\n${line(...color)}`);
        expect(imported.isOk).toBe(true);
        const [entity] = imported.value.drawing.entities;
        expect(entity.layer).toBe("Cut");
        expect(entity.color).toBe(expected);
        expect(imported.value.drawing.layers).toEqual([
            expect.objectContaining({ name: "Cut", aci: 5, color: "#0000ff" }),
        ]);
    });

    test("ByBlock (0) takes the INSERT's colour, ByLayer inside the block keeps none", () => {
        const blocks =
            "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\nB\n70\n0\n10\n0\n20\n0\n" +
            "0\nCIRCLE\n8\n0\n62\n0\n10\n0\n20\n0\n40\n1\n" +
            "0\nCIRCLE\n8\n0\n10\n5\n20\n0\n40\n1\n0\nENDBLK\n0\nENDSEC";
        const text = `${blocks}\n0\nSECTION\n2\nENTITIES\n0\nINSERT\n8\n0\n62\n1\n2\nB\n10\n0\n20\n0\n0\nENDSEC\n0\nEOF\n`;
        const imported = importDxf(text);
        expect(imported.isOk).toBe(true);
        expect(imported.value.drawing.entities.map((entity) => entity.color)).toEqual(["#ff0000", undefined]);
    });
});
