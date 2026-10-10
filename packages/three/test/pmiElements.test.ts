// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PmiDatum, PmiDimension, PmiFeatureControlFrame, PmiFlag, PmiNote, XYZ } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { buildPmiFrame } from "../src/pmiElements";
import style from "../src/threePmi.module.css";

const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });

/** The module's CSS with its local class names, as the bundler emits it. */
function moduleCss(): string {
    const source = readFileSync(resolve(import.meta.dirname, "../src/threePmi.module.css"), "utf8");
    const names = style as unknown as Record<string, string>;
    return source.replace(/\.([a-zA-Z][\w-]*)/g, (match, name: string) =>
        names[name] === undefined ? match : `.${names[name]}`,
    );
}

describe("PMI frames", () => {
    afterEach(() => {
        document.head.replaceChildren();
        document.body.replaceChildren();
    });

    test("every kind's text keeps the annotation's ink under the dark theme's global text colour", () => {
        const sheet = document.createElement("style");
        // the app's global rule (mainWindow.module.css) in the dark theme
        sheet.textContent = `p, span, div { color: #ffffff; }\n${moduleCss()}`;
        document.head.append(sheet);
        const doc = new TestDocument();
        const anchor = p(0, 0, 0);
        const position = p(10, 0, 0);
        const color = 0x3b2f8f;
        const annotations = [
            new PmiNote({ document: doc, anchor, position, color, text: "NOTE" }),
            new PmiFlag({ document: doc, anchor, position, color, text: "1" }),
            new PmiFeatureControlFrame({
                document: doc,
                anchor,
                position,
                color,
                tolerance: "0.1",
                datums: "A",
            }),
            new PmiDatum({ document: doc, anchor, position, color, label: "A" }),
            new PmiDimension({ document: doc, anchor, position, color, anchor2: p(20, 0, 0), value: 10 }),
        ];
        for (const annotation of annotations) {
            const frame = buildPmiFrame(annotation);
            document.body.append(frame);
            const texts = [...frame.querySelectorAll("span, div")] as HTMLElement[];
            expect(texts.length).toBeGreaterThan(0);
            for (const text of texts) {
                expect([annotation.kind, getComputedStyle(text).color]).toEqual([annotation.kind, "#3b2f8f"]);
            }
        }
    });
});
