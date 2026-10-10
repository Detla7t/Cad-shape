// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { detectFileFormat } from "@chili3d/core";
import { blocksToText, htmlToBlocks, type ParagraphData, type TableData } from "../src/blocks";
import { blocksToDocx, docxToHtml } from "../src/docx";
import { blocksToOdt, odtToHtml } from "../src/odt";
import { sanitizeHtml } from "../src/sanitize";

/** A 1×1 red PNG. */
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const SAMPLE = `
<h1>Duct report</h1>
<p>The <strong>main</strong> run is <em>galvanized</em> and <u>sealed</u>, see <a href="https://example.com/spec">the spec</a>.</p>
<ul><li>Elbows</li><li>Tees<ul><li>reducing</li></ul></li></ul>
<ol><li>Measure</li><li>Cut</li></ol>
<table><tr><th>Part</th><th>Qty</th></tr><tr><td>Elbow 90°</td><td>4</td></tr><tr><td>Tee</td><td>2</td></tr></table>
<p style="text-align: center">Centered <img src="data:image/png;base64,${PNG}" width="20" height="10"></p>
`;

const element = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
};

describe("HTML sanitizer", () => {
    test("inline styles are reduced to text alignment", () => {
        const root = element(
            sanitizeHtml('<p style="color: red; text-align: right; background: url(x)">x</p>'),
        );
        expect(root.querySelector("p")?.getAttribute("style")).toBe("text-align: right");
    });
});

describe("rich text blocks", () => {
    test("the editor's HTML reduces to headings, runs, nested lists, tables and images", () => {
        const blocks = htmlToBlocks(element(SAMPLE));
        const kinds = blocks.map((block) =>
            block.kind === "paragraph"
                ? `${block.style}${block.list ? `/${block.list.ordered ? "ol" : "ul"}${block.list.level}` : ""}`
                : block.kind,
        );
        expect(kinds).toEqual(["h1", "p", "p/ul0", "p/ul0", "p/ul1", "p/ol0", "p/ol0", "table", "p"]);
        const paragraph = blocks[1] as ParagraphData;
        expect(paragraph.runs).toEqual([
            { text: "The " },
            { text: "main", bold: true },
            { text: " run is " },
            { text: "galvanized", italic: true },
            { text: " and " },
            { text: "sealed", underline: true },
            { text: ", see " },
            { text: "the spec", link: "https://example.com/spec" },
            { text: "." },
        ]);
        const table = blocks[7] as TableData;
        expect(table.rows.map((row) => row.map((cell) => cell.paragraphs[0].runs[0]?.text))).toEqual([
            ["Part", "Qty"],
            ["Elbow 90°", "4"],
            ["Tee", "2"],
        ]);
        expect(table.rows[0][0].header).toBe(true);
        const last = blocks[8] as ParagraphData;
        expect(last.align).toBe("center");
        expect(last.runs[1].image).toMatchObject({ type: "png", width: 20, height: 10 });
        expect(blocksToText(blocks)).toContain("Part\tQty\nElbow 90°\t4");
    });
});

describe("DOCX", () => {
    test("write with docx, read with mammoth: text, emphasis, lists, the table and the image survive", async () => {
        const bytes = await blocksToDocx(htmlToBlocks(element(SAMPLE)), "Duct report");
        expect(detectFileFormat("report.bin", bytes)).toMatchObject({ id: "docx", by: "content" });
        const { html } = await docxToHtml(bytes);
        const root = element(html);
        expect(root.querySelector("h1")?.textContent).toBe("Duct report");
        expect(root.querySelector("strong")?.textContent).toBe("main");
        expect(root.querySelector("em")?.textContent).toBe("galvanized");
        expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/spec");
        const bullets = root.querySelector("ul");
        expect(bullets).not.toBeNull();
        expect(Array.from(bullets?.children ?? []).map((li) => li.firstChild?.textContent)).toEqual([
            "Elbows",
            "Tees",
        ]);
        expect(root.querySelector("ul li ul li")?.textContent).toBe("reducing");
        expect(Array.from(root.querySelectorAll("ol > li")).map((li) => li.textContent)).toEqual([
            "Measure",
            "Cut",
        ]);
        const cells = Array.from(root.querySelectorAll("table tr")).map((row) =>
            Array.from(row.querySelectorAll("td, th")).map((cell) => cell.textContent?.trim()),
        );
        expect(cells).toEqual([
            ["Part", "Qty"],
            ["Elbow 90°", "4"],
            ["Tee", "2"],
        ]);
        expect(root.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    });

    test("a second save of what was read gives the same content", async () => {
        const first = await docxToHtml(await blocksToDocx(htmlToBlocks(element(SAMPLE))));
        const second = await docxToHtml(await blocksToDocx(htmlToBlocks(element(first.html))));
        expect(blocksToText(htmlToBlocks(element(second.html)))).toBe(
            blocksToText(htmlToBlocks(element(first.html))),
        );
    });

    test("an empty document is a valid .docx", async () => {
        const bytes = await blocksToDocx([]);
        expect((await docxToHtml(bytes)).html).toBe("");
    });
});

describe("ODT", () => {
    test("write and read back: headings, emphasis, lists, the table and the image survive", async () => {
        const bytes = await blocksToOdt(htmlToBlocks(element(SAMPLE)), "Duct report");
        expect(detectFileFormat("report.bin", bytes)).toMatchObject({ id: "odt", by: "content" });
        const root = element(await odtToHtml(bytes));
        expect(root.querySelector("h1")?.textContent).toBe("Duct report");
        expect(root.querySelector("strong")?.textContent).toBe("main");
        expect(root.querySelector("em")?.textContent).toBe("galvanized");
        expect(root.querySelector("u")?.textContent).toBe("sealed");
        expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/spec");
        expect(root.querySelector("ul ul li")?.textContent).toBe("reducing");
        expect(Array.from(root.querySelectorAll("ol > li")).map((li) => li.textContent)).toEqual([
            "Measure",
            "Cut",
        ]);
        expect(Array.from(root.querySelectorAll("td")).map((cell) => cell.textContent)).toEqual([
            "Part",
            "Qty",
            "Elbow 90°",
            "4",
            "Tee",
            "2",
        ]);
        const centered = Array.from(root.querySelectorAll("p")).find((p) =>
            p.textContent?.includes("Centered"),
        );
        expect(centered?.getAttribute("style")).toBe("text-align: center");
        expect(centered?.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    });

    test("spaces and tabs are written as ODF space elements and read back", async () => {
        const blocks = htmlToBlocks(element("<pre>a   b\tc</pre>"));
        const root = element(await odtToHtml(await blocksToOdt(blocks)));
        expect(root.textContent?.replace(/ /g, " ").replace(/ /g, "\t")).toBe("a   b\tc");
    });
});
