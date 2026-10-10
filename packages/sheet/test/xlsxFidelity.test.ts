// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import JSZip from "jszip";
import { resolveColor, tintColor } from "../src/cellStyle";
import { translateFormula } from "../src/formulaText";
import type { WorkbookData } from "../src/model";
import { resolveRanges, resolveTableReference } from "../src/ranges";
import { compressValidations, readXlsx, writeXlsx } from "../src/xlsx";
import { addFormulaPrefixes, stripFormulaPrefixes } from "../src/xlsxFormula";

/**
 * A hand-written package with what real workbooks carry and ExcelJS reads incompletely:
 * a table with a calculated column and totals row, structured references, prefixed newer
 * functions, shared and array formulas with cached values, hyperlinks, pictures (SVG with
 * PNG fallback, grouped, linked, one-cell), a custom theme and indexed palette, a formula
 * defined name, a list validation over that name, hidden gridlines.
 */
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";
const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: [string, string, string, boolean?][]) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
        .map(
            ([id, type, target, external]) =>
                `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`,
        )
        .join("")}</Relationships>`;

const STRINGS = ["Item", "Qty", "Price", "Total", "Apple", "Pear", "Fig", "Docs", "Go to summary", "Sum"];
const s = (text: string) => `t="s"><v>${STRINGS.indexOf(text)}</v>`;

const SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS} ${R_NS}><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="20" customWidth="1"/></cols>
<sheetData>
<row r="1" ht="30" customHeight="1"><c r="A1" s="1" ${s("Item")}</c><c r="B1" s="1" ${s("Qty")}</c><c r="C1" s="1" ${s("Price")}</c><c r="D1" s="1" ${s("Total")}</c></row>
<row r="2"><c r="A2" s="2" ${s("Apple")}</c><c r="B2"><v>2</v></c><c r="C2"><v>1.5</v></c><c r="D2"><f t="shared" ref="D2:D4" si="0">Sales[[#This Row],[Qty]]*C2</f><v>3</v></c></row>
<row r="3"><c r="A3" ${s("Pear")}</c><c r="B3"><v>4</v></c><c r="C3"><v>2</v></c><c r="D3"><f t="shared" si="0"/><v>8</v></c></row>
<row r="4"><c r="A4" ${s("Fig")}</c><c r="B4"><v>1</v></c><c r="C4"><v>3</v></c><c r="D4"><f t="shared" si="0"/><v>3</v></c></row>
<row r="5"><c r="A5" ${s("Sum")}</c><c r="D5"><f>SUBTOTAL(109,Sales[Total])</f><v>14</v></c></row>
<row r="7"><c r="F7" t="str"><f>_xlfn.XLOOKUP("Pear",Sales[Item],Sales[Price],"none")</f><v>2</v></c>
<c r="G7" t="str"><f t="array" ref="G7:G9">_xlfn._xlws.FILTER(Sales[Item],Sales[Qty]&gt;1)</f><v>Apple</v></c></row>
<row r="8"><c r="G8" ${s("Pear")}</c></row>
<row r="9"><c r="G9" t="e"><v>#N/A</v></c></row>
<row r="10"><c r="A10" ${s("Docs")}</c><c r="B10" ${s("Go to summary")}</c><c r="C10"><v>42</v></c></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A12:C12"/></mergeCells>
<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="A20:A30"><formula1>Fruits</formula1></dataValidation></dataValidations>
<hyperlinks><hyperlink ref="A10" r:id="rId3" tooltip="Read the docs"/><hyperlink ref="B10" location="'Summary sheet'!B2" display="Go to summary"/></hyperlinks>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
<drawing r:id="rId2"/><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`;

const TABLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table ${NS} id="1" name="Sales" displayName="Sales" ref="A1:D5" totalsRowCount="1"><autoFilter ref="A1:D4"/><tableColumns count="4"><tableColumn id="1" name="Item" totalsRowLabel="Sum"/><tableColumn id="2" name="Qty"/><tableColumn id="3" name="Price"/><tableColumn id="4" name="Total" totalsRowFunction="sum"><calculatedColumnFormula>Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]</calculatedColumnFormula></tableColumn></tableColumns><tableStyleInfo name="TableStyleMedium9" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`;

const xdr = (tag: string, col: number, colOff: number, row: number, rowOff: number) =>
    `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:${tag}>`;
const pic = (id: number, name: string, embed: string, extra = "", xfrm = "") =>
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${name}" descr="${name} picture">${extra}</xdr:cNvPr><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${embed}"${
        name === "Logo"
            ? '><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId2"/></a:ext></a:extLst></a:blip>'
            : "/>"
    }<a:stretch/></xdr:blipFill><xdr:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;

const DRAWING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ${R_NS}>
<xdr:twoCellAnchor editAs="oneCell">${xdr("from", 5, 95250, 1, 0)}${xdr("to", 7, 0, 4, 190500)}${pic(2, "Logo", "rId1", '<a:hlinkClick r:id="rId3"/>')}<xdr:clientData/></xdr:twoCellAnchor>
<xdr:oneCellAnchor>${xdr("from", 8, 0, 0, 0)}<xdr:ext cx="952500" cy="476250"/>${pic(3, "Badge", "rId1")}<xdr:clientData/></xdr:oneCellAnchor>
<xdr:twoCellAnchor>${xdr("from", 1, 0, 10, 0)}${xdr("to", 3, 0, 12, 0)}<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="4" name="Group"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="1000000" y="2000000"/><a:ext cx="1905000" cy="952500"/><a:chOff x="1000000" y="2000000"/><a:chExt cx="1905000" cy="952500"/></a:xfrm></xdr:grpSpPr>
<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="5" name="Button"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp>${pic(6, "Icon", "rId1", "", '<a:xfrm><a:off x="1952500" y="2095250"/><a:ext cx="285750" cy="190500"/></a:xfrm>')}</xdr:grpSp><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet ${NS}><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color theme="0"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="-0.499984740745262"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color indexed="8"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/></cellXfs>
<colors><indexedColors><rgbColor rgb="FF000000"/><rgbColor rgb="FFFFFFFF"/><rgbColor rgb="FFFF0000"/><rgbColor rgb="FF00FF00"/><rgbColor rgb="FF0000FF"/><rgbColor rgb="FFFFFF00"/><rgbColor rgb="FFFF00FF"/><rgbColor rgb="FF00FFFF"/><rgbColor rgb="FF123456"/></indexedColors></colors></styleSheet>`;

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Paper"><a:themeElements><a:clrScheme name="Paper"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="444D26"/></a:dk2><a:lt2><a:srgbClr val="FEFAC9"/></a:lt2><a:accent1><a:srgbClr val="A5B592"/></a:accent1><a:accent2><a:srgbClr val="F3A447"/></a:accent2><a:accent3><a:srgbClr val="E7BC29"/></a:accent3><a:accent4><a:srgbClr val="D092A7"/></a:accent4><a:accent5><a:srgbClr val="9C85C0"/></a:accent5><a:accent6><a:srgbClr val="809EC2"/></a:accent6><a:hlink><a:srgbClr val="8E58B6"/></a:hlink><a:folHlink><a:srgbClr val="7F6F6F"/></a:folHlink></a:clrScheme><a:fontScheme name="x"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="x"/></a:themeElements></a:theme>`;

async function financeLikeWorkbook(): Promise<Uint8Array> {
    const zip = new JSZip();
    const ct = "application/vnd.openxmlformats-officedocument";
    zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/>
<Override PartName="/xl/workbook.xml" ContentType="${ct}.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="${ct}.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${ct}.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${ct}.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="${ct}.theme+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="${ct}.spreadsheetml.table+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="${ct}.drawing+xml"/></Types>`,
    );
    zip.file("_rels/.rels", rels([["rId1", "officeDocument", "xl/workbook.xml"]]));
    zip.file(
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS} ${R_NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Summary sheet" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="Fruits">Sales[Item]</definedName><definedName name="Slicer_X">#N/A</definedName><definedName name="Prices">Data!$C$2:$C$4</definedName></definedNames></workbook>`,
    );
    zip.file(
        "xl/_rels/workbook.xml.rels",
        rels([
            ["rId1", "worksheet", "worksheets/sheet1.xml"],
            ["rId2", "worksheet", "worksheets/sheet2.xml"],
            ["rId3", "styles", "styles.xml"],
            ["rId4", "theme", "theme/theme1.xml"],
            ["rId5", "sharedStrings", "sharedStrings.xml"],
        ]),
    );
    zip.file("xl/styles.xml", STYLES);
    zip.file("xl/theme/theme1.xml", THEME);
    zip.file(
        "xl/sharedStrings.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${NS} count="${STRINGS.length}" uniqueCount="${STRINGS.length}">${STRINGS.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`,
    );
    zip.file("xl/worksheets/sheet1.xml", SHEET1);
    zip.file(
        "xl/worksheets/_rels/sheet1.xml.rels",
        rels([
            ["rId1", "table", "../tables/table1.xml"],
            ["rId2", "drawing", "../drawings/drawing1.xml"],
            ["rId3", "hyperlink", "https://example.com/docs", true],
        ]),
    );
    zip.file(
        "xl/worksheets/sheet2.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetData><row r="2"><c r="B2"><f>SUM(Data!D2:D4)</f><v>14</v></c></row></sheetData></worksheet>`,
    );
    zip.file("xl/tables/table1.xml", TABLE);
    zip.file("xl/drawings/drawing1.xml", DRAWING);
    zip.file(
        "xl/drawings/_rels/drawing1.xml.rels",
        rels([
            ["rId1", "image", "../media/image1.png"],
            ["rId2", "image", "../media/image2.svg"],
            ["rId3", "hyperlink", "https://example.com/", true],
        ]),
    );
    zip.file("xl/media/image1.png", PNG, { base64: true });
    zip.file("xl/media/image2.svg", SVG);
    return zip.generateAsync({ type: "uint8array" });
}

describe("xlsx import of real-world workbook features", () => {
    let book: WorkbookData;
    beforeAll(async () => {
        book = await readXlsx(await financeLikeWorkbook());
    });

    test("tables keep columns, calculated formulas, totals and style", () => {
        expect(book.sheets[0].tables).toEqual([
            {
                name: "Sales",
                ref: "A1:D5",
                totalsRow: true,
                columns: [
                    { name: "Item", totalsLabel: "Sum" },
                    { name: "Qty" },
                    { name: "Price" },
                    {
                        name: "Total",
                        formula: "Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]",
                        totalsFunction: "sum",
                    },
                ],
                style: {
                    name: "TableStyleMedium9",
                    showRowStripes: true,
                    showColumnStripes: false,
                    showFirstColumn: false,
                    showLastColumn: false,
                },
            },
        ]);
    });

    test("formulas: shared expanded per cell, prefixes stripped, array ranges and cached values kept", () => {
        const cells = book.sheets[0].cells;
        expect(cells["D2"]).toMatchObject({ f: "Sales[[#This Row],[Qty]]*C2", v: 3 });
        expect(cells["D3"]).toMatchObject({ f: "Sales[[#This Row],[Qty]]*C3", v: 8 });
        expect(cells["D4"]).toMatchObject({ f: "Sales[[#This Row],[Qty]]*C4", v: 3 });
        expect(cells["F7"]).toMatchObject({ f: 'XLOOKUP("Pear",Sales[Item],Sales[Price],"none")', v: "2" });
        expect(cells["G7"]).toMatchObject({ f: "FILTER(Sales[Item],Sales[Qty]>1)", v: "Apple", a: "G7:G9" });
        expect(cells["G8"]).toEqual({ v: "Pear", sp: true });
        expect(cells["G9"]).toEqual({ v: "#N/A", e: true, sp: true });
        expect(cells["C10"].sp).toBeUndefined();
    });

    test("defined names: references and formulas kept, error placeholders dropped", () => {
        expect(book.names).toEqual(
            expect.arrayContaining([
                { name: "Prices", ranges: ["Data!$C$2:$C$4"] },
                { name: "Fruits", ranges: ["Sales[Item]"] },
            ]),
        );
        expect(book.names?.some((n) => n.name === "Slicer_X")).toBe(false);
    });

    test("hyperlinks keep target, in-workbook location, tooltip and the cell text", () => {
        const sheet = book.sheets[0];
        expect(sheet.hyperlinks).toEqual({
            A10: { target: "https://example.com/docs", tooltip: "Read the docs" },
            B10: { location: "'Summary sheet'!B2" },
        });
        expect(sheet.cells["A10"].v).toBe("Docs");
        expect(sheet.cells["B10"].v).toBe("Go to summary");
    });

    test("pictures: SVG with PNG fallback, one-cell size, grouped picture, picture link", () => {
        const images = book.sheets[0].images ?? [];
        expect(images).toHaveLength(3);
        expect(images[0]).toMatchObject({
            mime: "image/svg+xml",
            data: btoa(SVG),
            fallback: { mime: "image/png", data: PNG },
            from: { row: 1, col: 5, colOffset: 10 },
            to: { row: 4, col: 7, rowOffset: 20 },
            name: "Logo",
            description: "Logo picture",
            hyperlink: { target: "https://example.com/" },
        });
        expect(images[1]).toMatchObject({
            mime: "image/png",
            from: { row: 0, col: 8 },
            size: { width: 100, height: 50 },
        });
        expect(images[1].to).toBeUndefined();
        // Inside the group: 952500 EMU (100 px) right and 95250 EMU (10 px) down from the group's corner.
        expect(images[2]).toMatchObject({
            name: "Icon",
            from: { row: 10, col: 1, colOffset: 100, rowOffset: 10 },
            size: { width: 30, height: 20 },
        });
    });

    test("theme and indexed colours resolve to ARGB with Excel's luminance tint", () => {
        const header = book.sheets[0].cells["A1"].s;
        expect(header?.font?.color).toEqual({ argb: "FFFFFFFF" });
        expect(header?.font?.bold).toBe(true);
        expect(header?.fill).toMatchObject({
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFA5B592" },
        });
        expect(header?.border?.bottom).toEqual({ style: "thin", color: { argb: "FF123456" } });
        expect(book.sheets[0].cells["A2"].s?.fill).toMatchObject({ fgColor: { argb: "FF536142" } });
    });

    test("sheet layout: hidden gridlines, frozen header, widths, heights, merges, list validation", () => {
        const sheet = book.sheets[0];
        expect(sheet.gridLines).toBe(false);
        expect(book.sheets[1].gridLines).toBeUndefined();
        expect(sheet.frozen).toEqual({ rows: 1, cols: 0 });
        expect(sheet.cols?.[0]).toBe(145);
        expect(sheet.rows?.[0]).toBe(40);
        expect(sheet.merges).toEqual(["A12:C12"]);
        expect(sheet.validations).toEqual({
            "A20:A30": expect.objectContaining({ type: "list", formulae: ["Fruits"] }),
        });
    });

    test("a list validation over a table-column name resolves to the column's data cells", () => {
        expect(resolveRanges(book, "Fruits", 0)).toEqual([
            { sheet: 0, range: { start: { row: 1, col: 0 }, end: { row: 3, col: 0 } } },
        ]);
    });
});

describe("xlsx round trip", () => {
    let original: WorkbookData;
    let bytes: Uint8Array;
    let back: WorkbookData;
    beforeAll(async () => {
        original = await readXlsx(await financeLikeWorkbook());
        bytes = await writeXlsx(original);
        back = await readXlsx(bytes);
    });

    test("tables, hyperlinks, pictures, names and layout survive write → read", () => {
        for (const key of [
            "tables",
            "hyperlinks",
            "images",
            "merges",
            "cols",
            "rows",
            "frozen",
            "gridLines",
        ] as const) {
            expect(back.sheets[0][key]).toEqual(original.sheets[0][key]);
        }
        expect(back.sheets[0].validations).toEqual(original.sheets[0].validations);
        expect(back.names).toEqual(expect.arrayContaining(original.names ?? []));
        expect(back.names).toHaveLength(original.names?.length ?? 0);
    });

    test("formulas, array ranges, spill caches and resolved styles survive write → read", () => {
        for (const address of ["D2", "D3", "D5", "F7", "G7", "G8", "G9", "A1", "A2", "A10"]) {
            expect(back.sheets[0].cells[address]).toEqual(original.sheets[0].cells[address]);
        }
        expect(back.sheets[1].cells["B2"]).toEqual({ f: "SUM(Data!D2:D4)", v: 14 });
    });

    test("the package carries Excel's own encodings: prefixes, dynamic arrays, table parts", async () => {
        const zip = await JSZip.loadAsync(bytes);
        const sheet = (await zip.file("xl/worksheets/sheet1.xml")?.async("string")) ?? "";
        expect(sheet).toContain("_xlfn.XLOOKUP(&quot;Pear&quot;");
        expect(sheet).toMatch(/<c r="G7"[^>]* cm="1"><f t="array" ref="G7:G9">_xlfn\._xlws\.FILTER\(/);
        expect(sheet).toMatch(/<hyperlinks>.*<\/hyperlinks><pageMargins/);
        expect(sheet).toMatch(/<drawing r:id="rId\d+"\/>.*<tableParts count="1">/);
        expect(await zip.file("xl/metadata.xml")?.async("string")).toContain('name="XLDAPR"');
        const table = (await zip.file("xl/tables/table1.xml")?.async("string")) ?? "";
        expect(table).toContain('ref="A1:D5"');
        expect(table).toContain('totalsRowCount="1"');
        expect(table).toContain('<autoFilter ref="A1:D4"/>');
        expect(table).toContain(
            "<calculatedColumnFormula>Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]",
        );
        const types = (await zip.file("[Content_Types].xml")?.async("string")) ?? "";
        expect(types).toContain('Extension="svg"');
        expect(types).toContain("/xl/tables/table1.xml");
        const book = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
        expect(book).toContain('<definedName name="Fruits">Sales[Item]</definedName>');
    });

    test("a table header renamed in its cell is written as the column name", async () => {
        const edited = structuredClone(original);
        edited.sheets[0].cells["B1"] = { v: "Quantity" };
        const again = await readXlsx(await writeXlsx(edited));
        expect(again.sheets[0].tables?.[0].columns.map((c) => c.name)).toEqual([
            "Item",
            "Quantity",
            "Price",
            "Total",
        ]);
    });
});

describe("xlsx formula text", () => {
    test.each([
        ["_xlfn.XLOOKUP(A1,B:B,C:C)", "XLOOKUP(A1,B:B,C:C)"],
        ["_xlfn._xlws.FILTER(T[a],T[b]=1)", "FILTER(T[a],T[b]=1)"],
        ['_xlfn.LET(_xlpm.x,2,_xlpm.x*"_xlfn.")', 'LET(x,2,x*"_xlfn.")'],
        ["SUM(A1:A3)", "SUM(A1:A3)"],
    ])("strip %s", (stored, shown) => {
        expect(stripFormulaPrefixes(stored)).toBe(shown);
    });

    test.each([
        ["XLOOKUP(A1,B:B,C:C)", "_xlfn.XLOOKUP(A1,B:B,C:C)"],
        [
            "IFERROR(filter(T[a],T[b]=1),sort(A1:A3))",
            "IFERROR(_xlfn._xlws.filter(T[a],T[b]=1),_xlfn._xlws.sort(A1:A3))",
        ],
        [
            'CONCAT("XLOOKUP(",T[[#This Row],[DAYS (x)]])',
            '_xlfn.CONCAT("XLOOKUP(",T[[#This Row],[DAYS (x)]])',
        ],
        ["LET(x,2,y,x+1,x*y)", "_xlfn.LET(_xlpm.x,2,_xlpm.y,_xlpm.x+1,_xlpm.x*_xlpm.y)"],
        ["SUM(A1:A3)+IFERROR(1,2)", "SUM(A1:A3)+IFERROR(1,2)"],
    ])("prefix %s", (shown, stored) => {
        expect(addFormulaPrefixes(shown)).toBe(stored);
        expect(stripFormulaPrefixes(stored)).toBe(shown);
    });

    test("an already prefixed formula is stored unchanged", () => {
        expect(addFormulaPrefixes("_xlfn.XLOOKUP(1,A:A,_xlfn._xlws.SORT(B:B))")).toBe(
            "_xlfn.XLOOKUP(1,A:A,_xlfn._xlws.SORT(B:B))",
        );
    });

    test("moving a formula shifts cell references but not structured-reference column names", () => {
        expect(translateFormula("Tbl[[#This Row],[Q1]]*C2+Tbl[FY2024]", 2, 1)).toBe(
            "Tbl[[#This Row],[Q1]]*D4+Tbl[FY2024]",
        );
    });
});

describe("structured references and validation ranges", () => {
    const book: WorkbookData = {
        sheets: [
            { name: "A", cells: {} },
            {
                name: "B",
                cells: {},
                tables: [
                    {
                        name: "Sales",
                        ref: "C3:E10",
                        totalsRow: true,
                        columns: [{ name: "Item" }, { name: "Qty [units]" }, { name: "Price" }],
                    },
                ],
            },
        ],
    };
    const range = (r0: number, c0: number, r1: number, c1: number) => ({
        sheet: 1,
        range: { start: { row: r0, col: c0 }, end: { row: r1, col: c1 } },
    });
    test.each([
        ["Sales", range(3, 2, 8, 4)],
        ["sales[Price]", range(3, 4, 8, 4)],
        ["Sales[#All]", range(2, 2, 9, 4)],
        ["Sales[#Headers]", range(2, 2, 2, 4)],
        ["Sales[#Totals]", range(9, 2, 9, 4)],
        ["Sales[[#Headers],[#Data],[Item]]", range(2, 2, 8, 2)],
        ["Sales[[Item]:[Price]]", range(3, 2, 8, 4)],
        ["Sales[[Qty '[units']]]", range(3, 3, 8, 3)],
    ])("%s", (text, expected) => {
        expect(resolveTableReference(book, text)).toEqual(expected);
    });
    test.each([
        "Sales[@Item]",
        "Sales[[#This Row],[Item]]",
        "Sales[Missing]",
        "Nope[Item]",
        "A1",
    ])("%s needs a row or does not resolve", (text) => {
        expect(resolveTableReference(book, text)).toBeUndefined();
    });

    test("identical per-cell validation rules merge into rectangles", () => {
        const rule = { type: "list" as const, formulae: ["Fruits"], allowBlank: true };
        const other = { type: "whole" as const, operator: "between" as const, formulae: [1, 5] };
        const rules = Object.fromEntries([
            ...Array.from({ length: 6 }, (_, i) => [`H${i + 4}`, rule]),
            ...Array.from({ length: 6 }, (_, i) => [`I${i + 4}`, rule]),
            ["H20", rule],
            ["B2", other],
            ["K1:K9", other],
        ]);
        expect(compressValidations(rules)).toEqual({ "H4:I9": rule, H20: rule, B2: other, "K1:K9": other });
    });
});

describe("theme colour tint", () => {
    test.each([
        ["A5B592", -0.5, "536142"],
        ["809EC2", 0.7999, "E6ECF3"],
        ["4472C4", 0, "4472C4"],
        ["000000", 0.5, "808080"],
    ])("%s tinted %d", (rgb, tint, expected) => {
        expect(tintColor(rgb, tint)).toBe(expected);
    });
    test("a theme slot resolves against the given palette", () => {
        const palette = ["FFFFFF", "000000", "EEEEEE", "222222", "A5B592"];
        expect(resolveColor({ theme: 4, tint: -0.5 }, palette)).toBe("536142");
    });
});
