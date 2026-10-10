// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type * as Docx from "docx";
import type { BlockData, ParagraphData, RunData } from "./blocks";
import { sanitizeHtml } from "./sanitize";

/**
 * Word documents: read with mammoth (BSD-2-Clause; semantic HTML — headings, lists,
 * tables, emphasis, links, embedded images as data URLs — sanitized) and written with
 * `docx` (MIT) from the rich-text editor's blocks. Both libraries load on first use.
 * Saving is lossy for anything outside the editor's subset (see `blocks.ts`).
 */

export interface DocxReadResult {
    readonly html: string;
    /** mammoth's notes about content it could not convert. */
    readonly warnings: readonly string[];
}

export async function docxToHtml(bytes: Uint8Array): Promise<DocxReadResult> {
    const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
    const arrayBuffer = bytes.slice().buffer;
    // The browser build reads `arrayBuffer`, the Node build `buffer` (any Uint8Array works there).
    const input = { arrayBuffer, buffer: new Uint8Array(arrayBuffer) } as unknown as {
        arrayBuffer: ArrayBuffer;
    };
    const result = await mammoth.convertToHtml(input);
    return {
        html: sanitizeHtml(result.value),
        warnings: result.messages.map((message) => message.message),
    };
}

const HEADINGS = ["HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"] as const;
const ORDERED_REFERENCE = "chili3d-ordered";

function runsOf(docx: typeof Docx, runs: readonly RunData[], code: boolean): Docx.ParagraphChild[] {
    const children: Docx.ParagraphChild[] = [];
    for (const run of runs) {
        if (run.break) {
            children.push(new docx.TextRun({ text: "", break: 1 }));
            continue;
        }
        if (run.image !== undefined) {
            children.push(
                new docx.ImageRun({
                    type: run.image.type,
                    data: run.image.bytes,
                    transformation: { width: run.image.width, height: run.image.height },
                } as Docx.IImageOptions),
            );
            continue;
        }
        const options = {
            text: run.text,
            bold: run.bold,
            italics: run.italic,
            strike: run.strike,
            ...(run.underline ? { underline: {} } : {}),
            ...(run.code || code ? { font: "Consolas" } : {}),
        };
        if (run.link !== undefined) {
            children.push(
                new docx.ExternalHyperlink({
                    link: run.link,
                    children: [new docx.TextRun({ ...options, style: "Hyperlink" })],
                }),
            );
        } else {
            children.push(new docx.TextRun(options));
        }
    }
    return children;
}

function paragraphOf(docx: typeof Docx, block: ParagraphData, orderedInstance: number): Docx.Paragraph {
    const alignment = {
        left: docx.AlignmentType.LEFT,
        center: docx.AlignmentType.CENTER,
        right: docx.AlignmentType.RIGHT,
        justify: docx.AlignmentType.JUSTIFIED,
    } as const;
    const heading = /^h([1-6])$/.exec(block.style);
    return new docx.Paragraph({
        children: runsOf(docx, block.runs, block.style === "pre"),
        ...(heading ? { heading: docx.HeadingLevel[HEADINGS[Number(heading[1]) - 1]] } : {}),
        ...(block.style === "quote" ? { indent: { left: 720 }, style: "Quote" } : {}),
        ...(block.align !== undefined ? { alignment: alignment[block.align] } : {}),
        ...(block.list === undefined
            ? {}
            : block.list.ordered
              ? {
                    numbering: {
                        reference: ORDERED_REFERENCE,
                        level: Math.min(block.list.level, 8),
                        instance: orderedInstance,
                    },
                }
              : { bullet: { level: Math.min(block.list.level, 8) } }),
    });
}

/** The blocks as a .docx file. */
export async function blocksToDocx(blocks: readonly BlockData[], title?: string): Promise<Uint8Array> {
    const docx = await import("docx");
    const children: (Docx.Paragraph | Docx.Table)[] = [];
    let orderedInstance = 0;
    let inOrderedList = false;
    for (const block of blocks) {
        if (block.kind === "paragraph") {
            const ordered = block.list?.ordered === true;
            // Each ordered list restarts at 1.
            if (ordered && !inOrderedList) orderedInstance++;
            inOrderedList = block.list !== undefined && (ordered || inOrderedList);
            children.push(paragraphOf(docx, block, orderedInstance));
        } else {
            inOrderedList = false;
            if (block.kind === "rule") {
                children.push(
                    new docx.Paragraph({
                        children: [],
                        border: {
                            bottom: { color: "auto", space: 1, style: docx.BorderStyle.SINGLE, size: 6 },
                        },
                    }),
                );
            } else if (block.rows.length > 0) {
                children.push(
                    new docx.Table({
                        width: { size: 100, type: docx.WidthType.PERCENTAGE },
                        rows: block.rows.map(
                            (row, rowIndex) =>
                                new docx.TableRow({
                                    tableHeader: rowIndex === 0 && row.every((cell) => cell.header === true),
                                    children: row.map(
                                        (cell) =>
                                            new docx.TableCell({
                                                ...(cell.colSpan !== undefined
                                                    ? { columnSpan: cell.colSpan }
                                                    : {}),
                                                children: cell.paragraphs.map((paragraph) =>
                                                    paragraphOf(
                                                        docx,
                                                        cell.header === true
                                                            ? {
                                                                  ...paragraph,
                                                                  runs: paragraph.runs.map((run) => ({
                                                                      ...run,
                                                                      bold: true,
                                                                  })),
                                                              }
                                                            : paragraph,
                                                        orderedInstance,
                                                    ),
                                                ),
                                            }),
                                    ),
                                }),
                        ),
                    }),
                );
            }
        }
    }
    const document = new docx.Document({
        // A sans-serif body by default (the app's own face); Word would otherwise fall back to
        // its serif-or-not default, which varies by install. Runs that set a font keep it.
        styles: { default: { document: { run: { font: "Arial", size: 22 } } } },
        creator: "Chili3D",
        ...(title === undefined ? {} : { title }),
        numbering: {
            config: [
                {
                    reference: ORDERED_REFERENCE,
                    levels: Array.from({ length: 9 }, (_, level) => ({
                        level,
                        format: docx.LevelFormat.DECIMAL,
                        text: `%${level + 1}.`,
                        alignment: docx.AlignmentType.START,
                        style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
                    })),
                },
            ],
        },
        sections: [{ children: children.length > 0 ? children : [new docx.Paragraph({ children: [] })] }],
    });
    const buffer = await docx.Packer.toArrayBuffer(document);
    return new Uint8Array(buffer);
}
