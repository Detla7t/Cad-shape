// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, ReferencePlaneNode } from "@chili3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { CreateReferencePlane } from "../src/sketch/commands/referencePlaneCommands";
import "./sketch/setup";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(length: "mm" | "in") {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc) as any;
    doc.userData = { displayUnits: { length, angle: "deg", lengthPrecision: 3, anglePrecision: 1 } };
    const view = createMockView({ document: doc });
    (view as { dom?: HTMLElement }).dom = document.createElement("div");
    (view as { workplane: Plane }).workplane = Plane.XY;
    (app as { activeView?: unknown }).activeView = view;
    document.body.append(view.dom!);
    return { app, doc, view };
}

const panel = () => document.querySelector<HTMLFormElement>('form[aria-label="Create reference plane"]');
const offsetInput = () => panel()!.querySelector<HTMLInputElement>('input[aria-label="plane.offset"]')!;
const planes = (doc: TestDocument) =>
    doc.modelManager.findNodes().filter((n): n is ReferencePlaneNode => n instanceof ReferencePlaneNode);

describe("reference plane panel", () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    test("the offset shows the document unit and accepts a value typed in it", async () => {
        const { app, doc } = setup("in");
        const run = new CreateReferencePlane().execute(app as any);
        await tick();
        const offset = offsetInput();
        // 25 mm, shown in inches
        expect(offset.value).toBe("0.984 in");
        offset.value = "1 in";
        offset.dispatchEvent(new Event("input"));
        panel()!.requestSubmit();
        await run;
        expect(planes(doc).map((p) => p.offset)).toEqual([25.4]);
        expect(panel()).toBeNull();
    });

    test("a millimetre document keeps millimetres, and a bad value blocks the plane", async () => {
        const { app, doc } = setup("mm");
        const run = new CreateReferencePlane().execute(app as any);
        await tick();
        const offset = offsetInput();
        expect(offset.value).toBe("25.000 mm");
        offset.value = "twelve";
        offset.dispatchEvent(new Event("input"));
        expect(offset.checkValidity()).toBe(false);
        panel()!.requestSubmit();
        await tick();
        expect(planes(doc)).toEqual([]);
        expect(panel()).not.toBeNull();
        offset.value = "40";
        offset.dispatchEvent(new Event("input"));
        panel()!.requestSubmit();
        await run;
        expect(planes(doc).map((p) => p.offset)).toEqual([40]);
    });
});
