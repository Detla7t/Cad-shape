// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { addressOf, type CellData, columnIndex, type SheetData, type WorkbookData } from "./model";

/**
 * OpenDocument spreadsheets (.ods, ISO/IEC 26300) read from and written to `content.xml`
 * directly (JSZip + DOMParser): values by type (float, percentage, currency, date, time,
 * boolean, string), OpenFormula formulas translated to and from the Excel syntax the
 * formula engine reads (`of:=SUM([.A1:.B2])` ⇄ `SUM(A1:B2)`), basic number formats
 * through data styles, column widths, merges and repeated rows/columns.
 *
 * Elements and attributes are addressed by qualified name ("table:table-cell"): ODF
 * producers use the standard prefixes, and qualified names work in every DOM.
 */

const MAX_REPEAT = 1024;

// ------------------------------------------------------------------ Formulas

/** Applies `replace` outside string literals ("…" with doubled quotes). */
function outsideStrings(formula: string, replace: (code: string) => string): string {
    return formula
        .split(/("(?:[^"]|"")*")/)
        .map((part, i) => (i % 2 === 1 ? part : replace(part)))
        .join("");
}

const unquoteSheet = (sheet: string) => sheet.replace(/^\$/, "");

/** An OpenFormula (`of:=…`) as Excel syntax. */
export function odfToExcelFormula(formula: string): string {
    const body = formula.replace(/^[a-z]+:=/i, "").replace(/^=/, "");
    return outsideStrings(body, (code) =>
        code
            .replace(/\[([^\]]*)\]/g, (_, reference: string) => {
                const parts = reference.split(":").map((part) => {
                    const dot = part.lastIndexOf(".");
                    const sheet = dot > 0 ? unquoteSheet(part.slice(0, dot)) : "";
                    return { sheet, cell: part.slice(dot + 1) };
                });
                const sheet = parts[0].sheet;
                const prefix = sheet === "" ? "" : `${sheet}!`;
                return prefix + parts.map((part) => part.cell).join(":");
            })
            .replace(/;/g, ","),
    );
}

const REFERENCE =
    /((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)(?![\w(])/g;

/** An Excel-syntax formula as OpenFormula (`of:=…`). */
export function excelToOdfFormula(formula: string): string {
    const body = outsideStrings(formula, (code) =>
        code.replace(/,/g, ";").replace(REFERENCE, (_, sheetPart: string | undefined, cells: string) => {
            const sheet = sheetPart === undefined ? "" : sheetPart.slice(0, -1);
            return `[${cells
                .split(":")
                .map((cell, i) => `${i === 0 ? sheet : ""}.${cell}`)
                .join(":")}]`;
        }),
    );
    return `of:=${body}`;
}

// ------------------------------------------------------------------ Reading

const attr = (element: Element, name: string) => element.getAttribute(name);
const children = (element: Element) => Array.from(element.children);

function lengthPx(value: string | null): number | undefined {
    const match = /^([\d.]+)(cm|mm|in|pt|pc|px)$/.exec(value ?? "");
    if (!match) return undefined;
    const factor = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1 }[match[2] as "cm"];
    return Math.round(Number(match[1]) * factor);
}

/** Number format codes of the document's data styles, by style name. */
function dataStyles(documents: Document[]): Map<string, string> {
    const formats = new Map<string, string>();
    for (const document of documents) {
        for (const element of Array.from(document.getElementsByTagName("*"))) {
            const name = attr(element, "style:name");
            if (name === null || !element.tagName.startsWith("number:")) continue;
            const number = element.getElementsByTagName("number:number")[0];
            const decimals = Number(number === undefined ? 0 : (attr(number, "number:decimal-places") ?? 0));
            const fraction = decimals > 0 ? `.${"0".repeat(decimals)}` : "";
            const grouping = number !== undefined && attr(number, "number:grouping") === "true";
            switch (element.tagName) {
                case "number:number-style":
                    if (number !== undefined) formats.set(name, `${grouping ? "#,##0" : "0"}${fraction}`);
                    break;
                case "number:percentage-style":
                    formats.set(name, `0${fraction}%`);
                    break;
                case "number:currency-style":
                    formats.set(name, `#,##0${fraction}`);
                    break;
                case "number:date-style":
                    formats.set(
                        name,
                        element.getElementsByTagName("number:hours").length > 0
                            ? "yyyy-mm-dd hh:mm:ss"
                            : "yyyy-mm-dd",
                    );
                    break;
                case "number:time-style":
                    formats.set(name, "hh:mm:ss");
                    break;
            }
        }
    }
    return formats;
}

/** Cell style name → number format; column style name → width. */
function styleTables(documents: Document[]) {
    const formats = dataStyles(documents);
    const cellFormats = new Map<string, string>();
    const columnWidths = new Map<string, number>();
    for (const document of documents) {
        for (const style of Array.from(document.getElementsByTagName("style:style"))) {
            const name = attr(style, "style:name");
            if (name === null) continue;
            const data = attr(style, "style:data-style-name");
            const format = data === null ? undefined : formats.get(data);
            if (format !== undefined) cellFormats.set(name, format);
            const column = style.getElementsByTagName("style:table-column-properties")[0];
            const width = column === undefined ? undefined : lengthPx(attr(column, "style:column-width"));
            if (width !== undefined) columnWidths.set(name, width);
        }
    }
    return { cellFormats, columnWidths };
}

function textOf(cell: Element): string {
    const paragraph = (element: Element): string =>
        Array.from(element.childNodes)
            .map((node) => {
                if (node.nodeType === 3) return node.textContent ?? "";
                if (node.nodeType !== 1) return "";
                const child = node as Element;
                if (child.tagName === "text:s") return " ".repeat(Number(attr(child, "text:c") ?? 1));
                if (child.tagName === "text:tab") return "\t";
                if (child.tagName === "text:line-break") return "\n";
                return paragraph(child);
            })
            .join("");
    return children(cell)
        .filter((child) => child.tagName === "text:p")
        .map(paragraph)
        .join("\n");
}

/** ISO 8601 date (and time) → Excel serial number. */
function dateSerial(value: string): number | undefined {
    const match = /^(-?\d{4,})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d(?:\.\d+)?))?)?/.exec(value);
    if (!match) return undefined;
    const [, y, m, d, hh = "0", mm = "0", ss = "0"] = match;
    const ms = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm)) + Number(ss) * 1000;
    return (ms - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** ISO 8601 duration "PT12H30M15S" → fraction of a day. */
function timeFraction(value: string): number | undefined {
    const match = /^-?P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value);
    if (!match) return undefined;
    return (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) / 86_400;
}

function cellData(cell: Element, format: string | undefined): CellData | undefined {
    const type = attr(cell, "office:value-type");
    const formula = attr(cell, "table:formula");
    const z = format === undefined ? {} : { z: format };
    const f = formula === null ? {} : { f: odfToExcelFormula(formula) };
    const number = (name: string) => Number(attr(cell, name) ?? Number.NaN);
    switch (type) {
        case "float":
            return { v: number("office:value"), ...f, ...z };
        case "percentage":
            return { v: number("office:value"), ...f, z: format ?? "0%" };
        case "currency":
            return { v: number("office:value"), ...f, z: format ?? "#,##0.00" };
        case "date": {
            const value = dateSerial(attr(cell, "office:date-value") ?? "");
            return value === undefined ? undefined : { v: value, ...f, z: format ?? "yyyy-mm-dd" };
        }
        case "time": {
            const value = timeFraction(attr(cell, "office:time-value") ?? "");
            return value === undefined ? undefined : { v: value, ...f, z: format ?? "hh:mm:ss" };
        }
        case "boolean":
            return { v: attr(cell, "office:boolean-value") === "true", ...f, ...z };
        case "string":
            return { v: attr(cell, "office:string-value") ?? textOf(cell), ...f, ...z };
        default: {
            if (formula !== null) return { ...f, ...z };
            const text = textOf(cell);
            return text === "" ? undefined : { v: text, ...z };
        }
    }
}

function readTable(table: Element, styles: ReturnType<typeof styleTables>): SheetData {
    const cells: Record<string, CellData> = {};
    const cols: (number | null)[] = [];
    const merges: string[] = [];
    let row = 0;
    let usedCols = 0;
    const visitRow = (element: Element) => {
        const repeat = Math.max(1, Number(attr(element, "table:number-rows-repeated") ?? 1));
        const entries: { col: number; data: CellData }[] = [];
        let col = 0;
        for (const cell of children(element)) {
            if (cell.tagName !== "table:table-cell" && cell.tagName !== "table:covered-table-cell") continue;
            const span = Math.max(1, Number(attr(cell, "table:number-columns-repeated") ?? 1));
            const data =
                cell.tagName === "table:table-cell"
                    ? cellData(cell, styles.cellFormats.get(attr(cell, "table:style-name") ?? ""))
                    : undefined;
            if (data !== undefined) {
                for (let k = 0; k < Math.min(span, MAX_REPEAT); k++) entries.push({ col: col + k, data });
                const across = Number(attr(cell, "table:number-columns-spanned") ?? 1);
                const down = Number(attr(cell, "table:number-rows-spanned") ?? 1);
                if (across > 1 || down > 1)
                    merges.push(`${addressOf(row, col)}:${addressOf(row + down - 1, col + across - 1)}`);
            }
            col += span;
        }
        // A trailing run of empty rows (often a million) is skipped, not expanded.
        const copies = entries.length === 0 ? 0 : Math.min(repeat, MAX_REPEAT);
        for (let r = 0; r < copies; r++) {
            for (const entry of entries) {
                cells[addressOf(row + r, entry.col)] = { ...entry.data };
                usedCols = Math.max(usedCols, entry.col + 1);
            }
        }
        row += repeat;
    };
    const visit = (parent: Element) => {
        for (const child of children(parent)) {
            if (child.tagName === "table:table-row") visitRow(child);
            else if (
                child.tagName === "table:table-header-rows" ||
                child.tagName === "table:table-rows" ||
                child.tagName === "table:table-row-group"
            ) {
                visit(child);
            } else if (child.tagName === "table:table-column") {
                addColumn(child);
            } else if (
                child.tagName === "table:table-columns" ||
                child.tagName === "table:table-header-columns" ||
                child.tagName === "table:table-column-group"
            ) {
                visit(child);
            }
        }
    };
    const addColumn = (column: Element) => {
        const repeat = Math.min(
            MAX_REPEAT,
            Math.max(1, Number(attr(column, "table:number-columns-repeated") ?? 1)),
        );
        const width = styles.columnWidths.get(attr(column, "table:style-name") ?? "") ?? null;
        for (let k = 0; k < repeat && cols.length < MAX_REPEAT; k++) cols.push(width);
    };
    visit(table);
    const used = cols.slice(0, Math.max(usedCols, 1));
    return {
        name: attr(table, "table:name") ?? "Sheet",
        cells,
        ...(used.some((width) => width !== null) ? { cols: used } : {}),
        ...(merges.length > 0 ? { merges } : {}),
    };
}

export async function readOds(bytes: Uint8Array): Promise<WorkbookData> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(bytes);
    const read = async (path: string) => (await zip.file(path)?.async("string")) ?? "";
    const parser = new DOMParser();
    const content = parser.parseFromString(await read("content.xml"), "application/xml");
    const stylesXml = await read("styles.xml");
    const documents = [
        content,
        ...(stylesXml === "" ? [] : [parser.parseFromString(stylesXml, "application/xml")]),
    ];
    const styles = styleTables(documents);
    const spreadsheet = content.getElementsByTagName("office:spreadsheet")[0];
    if (spreadsheet === undefined) throw new Error("The file holds no spreadsheet");
    const sheets = children(spreadsheet)
        .filter((child) => child.tagName === "table:table")
        .map((table) => readTable(table, styles));
    return { sheets: sheets.length > 0 ? sheets : [{ name: "Sheet1", cells: {} }] };
}

// ------------------------------------------------------------------ Writing

const escapeXml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NAMESPACES = [
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
    'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"',
    'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"',
    'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
].join(" ");

const isDateFormat = (z: string) => /[yd]/i.test(z.replace(/"[^"]*"/g, ""));
const isTimeFormat = (z: string) => /^\[?h/i.test(z.replace(/"[^"]*"/g, "")) && !isDateFormat(z);

/** An ODF data style for a number format, or undefined for General. */
function dataStyleXml(name: string, z: string): string {
    const decimals = (/\.(0+)/.exec(z)?.[1] ?? "").length;
    const grouping = z.includes(",") ? ' number:grouping="true"' : "";
    const digits = `<number:number number:decimal-places="${decimals}" number:min-decimal-places="${decimals}" number:min-integer-digits="1"${grouping}/>`;
    if (z.includes("%"))
        return `<number:percentage-style style:name="${name}">${digits}<number:text>%</number:text></number:percentage-style>`;
    if (isTimeFormat(z)) {
        return `<number:time-style style:name="${name}"><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/><number:text>:</number:text><number:seconds number:style="long"/></number:time-style>`;
    }
    if (isDateFormat(z)) {
        const time = /h/i.test(z)
            ? '<number:text> </number:text><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/><number:text>:</number:text><number:seconds number:style="long"/>'
            : "";
        return `<number:date-style style:name="${name}"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/>${time}</number:date-style>`;
    }
    return `<number:number-style style:name="${name}">${digits}</number:number-style>`;
}

function serialToIso(serialNumber: number, withTime: boolean): string {
    const date = new Date(Math.round(serialNumber * 86_400_000) + Date.UTC(1899, 11, 30));
    const iso = date.toISOString();
    return withTime ? iso.slice(0, 19) : iso.slice(0, 10);
}

function fractionToDuration(fraction: number): string {
    const total = Math.round(fraction * 86_400);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `PT${String(h).padStart(2, "0")}H${String(m).padStart(2, "0")}M${String(s).padStart(2, "0")}S`;
}

function cellXml(cell: CellData | undefined, styleName: string | undefined): string {
    if (cell === undefined || (cell.v === undefined && cell.f === undefined)) {
        return styleName === undefined
            ? "<table:table-cell/>"
            : `<table:table-cell table:style-name="${styleName}"/>`;
    }
    const attrs: string[] = [];
    if (styleName !== undefined) attrs.push(`table:style-name="${styleName}"`);
    if (cell.f !== undefined) attrs.push(`table:formula="${escapeXml(excelToOdfFormula(cell.f))}"`);
    const value = cell.v;
    let text = "";
    if (cell.e === true) {
        attrs.push('office:value-type="string"', `office:string-value="${escapeXml(String(value))}"`);
        text = String(value);
    } else if (typeof value === "number") {
        const z = cell.z ?? "";
        if (z.includes("%")) attrs.push('office:value-type="percentage"', `office:value="${value}"`);
        else if (isTimeFormat(z))
            attrs.push('office:value-type="time"', `office:time-value="${fractionToDuration(value)}"`);
        else if (isDateFormat(z))
            attrs.push('office:value-type="date"', `office:date-value="${serialToIso(value, /h/i.test(z))}"`);
        else attrs.push('office:value-type="float"', `office:value="${value}"`);
        text = String(value);
    } else if (typeof value === "boolean") {
        attrs.push('office:value-type="boolean"', `office:boolean-value="${value}"`);
        text = value ? "TRUE" : "FALSE";
    } else if (typeof value === "string") {
        attrs.push('office:value-type="string"');
        text = value;
    }
    const paragraphs = text
        .split("\n")
        .map((line) => `<text:p>${escapeXml(line)}</text:p>`)
        .join("");
    return `<table:table-cell ${attrs.join(" ")}>${paragraphs}</table:table-cell>`;
}

function sheetSize(sheet: SheetData): { rows: number; cols: number } {
    let rows = 0;
    let cols = 0;
    for (const key of Object.keys(sheet.cells)) {
        const match = /^([A-Z]+)(\d+)$/.exec(key);
        if (!match) continue;
        rows = Math.max(rows, Number(match[2]));
        cols = Math.max(cols, columnIndex(match[1]) + 1);
    }
    return { rows, cols: Math.max(cols, sheet.cols?.length ?? 0) };
}

/** The workbook as .ods bytes; formula cells carry their cached result (`v`). */
export async function writeOds(workbook: WorkbookData): Promise<Uint8Array> {
    const dataStyles = new Map<string, string>(); // format → data style name
    const cellStyles = new Map<string, string>(); // format → cell style name
    const columnStyles = new Map<number, string>(); // width → column style name
    const styleFor = (z: string | undefined) => {
        if (z === undefined) return undefined;
        let name = cellStyles.get(z);
        if (name === undefined) {
            const data = `N${dataStyles.size + 1}`;
            dataStyles.set(z, data);
            name = `ce${cellStyles.size + 1}`;
            cellStyles.set(z, name);
        }
        return name;
    };
    const tables = workbook.sheets.map((sheet) => {
        const { rows, cols } = sheetSize(sheet);
        const merged = new Map<string, { across: number; down: number }>();
        const covered = new Set<string>();
        for (const range of sheet.merges ?? []) {
            const [a, b] = range.split(":");
            const start = /^([A-Z]+)(\d+)$/.exec(a ?? "");
            const end = /^([A-Z]+)(\d+)$/.exec(b ?? "");
            if (!start || !end) continue;
            const r0 = Number(start[2]) - 1;
            const c0 = columnIndex(start[1]);
            const r1 = Number(end[2]) - 1;
            const c1 = columnIndex(end[1]);
            merged.set(addressOf(r0, c0), { across: c1 - c0 + 1, down: r1 - r0 + 1 });
            for (let r = r0; r <= r1; r++)
                for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) covered.add(addressOf(r, c));
        }
        const columns = Array.from({ length: Math.max(cols, 1) }, (_, c) => {
            const width = sheet.cols?.[c] ?? null;
            if (width === null) return "<table:table-column/>";
            let name = columnStyles.get(width);
            if (name === undefined) {
                name = `co${columnStyles.size + 1}`;
                columnStyles.set(width, name);
            }
            return `<table:table-column table:style-name="${name}"/>`;
        }).join("");
        const rowXml: string[] = [];
        for (let r = 0; r < rows; r++) {
            const cellsXml: string[] = [];
            for (let c = 0; c < cols; c++) {
                const address = addressOf(r, c);
                if (covered.has(address)) {
                    cellsXml.push("<table:covered-table-cell/>");
                    continue;
                }
                const cell = sheet.cells[address];
                let xml = cellXml(cell, styleFor(cell?.z));
                const span = merged.get(address);
                if (span !== undefined) {
                    xml = xml.replace(
                        /^<table:table-cell/,
                        `<table:table-cell table:number-columns-spanned="${span.across}" table:number-rows-spanned="${span.down}"`,
                    );
                }
                cellsXml.push(xml);
            }
            rowXml.push(`<table:table-row>${cellsXml.join("")}</table:table-row>`);
        }
        return `<table:table table:name="${escapeXml(sheet.name)}">${columns}${rowXml.join("")}</table:table>`;
    });
    const automatic = [
        ...[...dataStyles].map(([z, name]) => dataStyleXml(name, z)),
        ...[...cellStyles].map(
            ([z, name]) =>
                `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="${dataStyles.get(z)}"/>`,
        ),
        ...[...columnStyles].map(
            ([width, name]) =>
                `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${((width / 96) * 2.54).toFixed(3)}cm"/></style:style>`,
        ),
    ].join("");
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NAMESPACES} office:version="1.3"><office:automatic-styles>${automatic}</office:automatic-styles><office:body><office:spreadsheet>${tables.join("")}</office:spreadsheet></office:body></office:document-content>`;
    const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NAMESPACES} office:version="1.3"><office:styles><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>`;
    const meta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${NAMESPACES} office:version="1.3"><office:meta><meta:generator>Chili3D</meta:generator></office:meta></office:document-meta>`;
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    // The mimetype must be the first entry, uncompressed.
    zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet", { compression: "STORE" });
    zip.file("META-INF/manifest.xml", manifest);
    zip.file("content.xml", content);
    zip.file("styles.xml", styles);
    zip.file("meta.xml", meta);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
