// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import JSZip from "jszip";
import {
    decodeText,
    decodeXml,
    escapeXml,
    extensionOf,
    imageMimeOf,
    lengthToPx,
    odfDocuments,
    odfMimeType,
    pxToCm,
    readOdfPackage,
    writeOdfPackage,
} from "../src";

describe("XML escapes", () => {
    test("markup characters are escaped and XML-forbidden control characters dropped", () => {
        expect(escapeXml('a < b & "c" > d')).toBe("a &lt; b &amp; &quot;c&quot; &gt; d");
        expect(escapeXml("tab\tline\ncr\r bell\u0007 nul\u0000")).toBe("tab\tline\ncr\r bell nul");
    });

    test("entities and character references decode; unknown ones stay as written", () => {
        expect(decodeXml("&lt;p&gt; &amp;amp; &quot;&apos; &#65;&#x42; &nbsp;")).toBe(
            "<p> &amp; \"' AB &nbsp;",
        );
        expect(decodeXml(escapeXml('x<"y">&z'))).toBe('x<"y">&z');
    });
});

describe("lengths", () => {
    test.each([
        ["2.54cm", 96],
        ["25.4mm", 96],
        ["1in", 96],
        ["72pt", 96],
        ["6pc", 96],
        ["12px", 12],
        ["1.5cm", 57],
    ])("%s is %i px", (length, px) => {
        expect(lengthToPx(length)).toBe(px);
    });

    test("anything else is undefined, and pixels write back as centimetres", () => {
        expect(lengthToPx("12")).toBeUndefined();
        expect(lengthToPx("1em")).toBeUndefined();
        expect(lengthToPx(null)).toBeUndefined();
        expect(lengthToPx("1.2.3cm")).toBeUndefined();
        expect(pxToCm(96)).toBe("2.540cm");
        expect(lengthToPx(pxToCm(123))).toBe(123);
    });
});

describe("picture media types", () => {
    test("by extension, case-insensitively, folders and dots in names ignored", () => {
        expect(imageMimeOf("Pictures/Photo.JPG")).toBe("image/jpeg");
        expect(imageMimeOf("xl/media/image1.emf")).toBe("image/x-emf");
        expect(imageMimeOf("content.xml")).toBeUndefined();
        expect(extensionOf("a.b/c")).toBe("");
        expect(extensionOf("a/b.tar.gz")).toBe("gz");
    });
});

describe("legacy text", () => {
    test("UTF-8 when valid (byte-order mark dropped), Windows-1252 otherwise", () => {
        expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x4d, 0xc3, 0xbc]))).toBe("Mü");
        expect(decodeText(new Uint8Array([0x4d, 0xfc, 0x80]))).toBe("Mü€");
    });
});

describe("OpenDocument package", () => {
    const options = {
        kind: "text" as const,
        automaticStyles: '<style:style style:name="T1" style:family="text"/>',
        body: '<text:p text:style-name="T1">Hello &amp; welcome</text:p>',
        styles: '<style:style style:name="Standard" style:family="paragraph"/>',
        title: 'Tom & "Jerry"',
        files: [{ path: "Pictures/a.png", bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }],
    };

    test("the documents wrap the body and styles, declare the prefixes and list every entry", () => {
        const documents = odfDocuments(options);
        expect(Object.keys(documents)).toEqual([
            "META-INF/manifest.xml",
            "content.xml",
            "styles.xml",
            "meta.xml",
        ]);
        const parser = new DOMParser();
        for (const xml of Object.values(documents)) {
            const parsed = parser.parseFromString(xml, "application/xml");
            expect(parsed.getElementsByTagName("parsererror").length).toBe(0);
        }
        expect(documents["content.xml"]).toContain(
            `<office:body><office:text>${options.body}</office:text></office:body>`,
        );
        expect(documents["meta.xml"]).toContain("<dc:title>Tom &amp; &quot;Jerry&quot;</dc:title>");
        const manifest = documents["META-INF/manifest.xml"];
        expect(manifest).toContain(`manifest:media-type="${odfMimeType("text")}"`);
        expect(manifest).toContain('manifest:full-path="Pictures/a.png" manifest:media-type="image/png"');
    });

    test("written: the mimetype entry comes first and uncompressed; read back: documents and files", async () => {
        const bytes = await writeOdfPackage(options);
        // The zip's first local file header: "mimetype", method 0 (stored), its text right after.
        const header = new DataView(bytes.buffer, bytes.byteOffset);
        expect(header.getUint32(0, true)).toBe(0x04034b50);
        expect(header.getUint16(8, true)).toBe(0);
        const nameLength = header.getUint16(26, true);
        const dataStart = 30 + nameLength + header.getUint16(28, true);
        expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLength))).toBe("mimetype");
        const mimeType = odfMimeType("text");
        expect(new TextDecoder().decode(bytes.subarray(dataStart, dataStart + mimeType.length))).toBe(
            mimeType,
        );
        const zip = await JSZip.loadAsync(bytes);
        expect(await zip.file("mimetype")?.async("string")).toBe("application/vnd.oasis.opendocument.text");

        const pkg = await readOdfPackage(bytes);
        expect(pkg.content.getElementsByTagName("text:p")[0]?.textContent).toBe("Hello & welcome");
        expect(pkg.styleDocuments).toHaveLength(2);
        expect(pkg.styleDocuments[1].getElementsByTagName("style:style")[0]?.getAttribute("style:name")).toBe(
            "Standard",
        );
        expect(pkg.paths).toContain("Pictures/a.png");
        expect(Array.from((await pkg.read("Pictures/a.png")) ?? [])).toEqual([1, 2, 3]);
        expect(await pkg.read("missing.xml")).toBeUndefined();
    });

    test("a package without styles.xml reads with content.xml as its only style document", async () => {
        const zip = new JSZip();
        zip.file("content.xml", "<office:document-content/>");
        const pkg = await readOdfPackage(await zip.generateAsync({ type: "uint8array" }));
        expect(pkg.styleDocuments).toEqual([pkg.content]);
    });

    test("bytes that are not a zip reject", async () => {
        await expect(readOdfPackage(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    });
});
