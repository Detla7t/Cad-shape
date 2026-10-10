// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type INode, Logger, Result, sha256Hex } from "@chili3d/core";
import { csvToWorkbook } from "@chili3d/sheet/csv";
import { isFormulaError, type Scalar, WorkbookEvaluator } from "@chili3d/sheet/formula";
import {
    type CellRange,
    columnName,
    parseRange,
    rangeText,
    usedSize,
    type WorkbookData,
} from "@chili3d/sheet/model";
import { isWorkbookFormat, readWorkbook } from "@chili3d/sheet/workbookIo";
import { DocumentFileNode } from "./documentFileNode";

/**
 * Reading a document element's content from other modules — the stable API data
 * bindings use (variables bound to spreadsheet cells, text pulled into notes).
 *
 * Tables (spreadsheets: CSV, TSV, XLSX, ODS):
 * - `readDocumentTable(node, sheet?, range?)` — SYNCHRONOUS, from the parsed-workbook
 *   cache: the evaluated cells as a `DataTable` (formulas computed, errors as their code
 *   text such as "#DIV/0!"). CSV/TSV parse on the spot; a binary workbook not parsed yet
 *   answers `err(DOCUMENT_NOT_LOADED)`, starts parsing and, when done, notifies
 *   `onDocumentTablesChanged` listeners — read again then.
 * - `loadDocumentTable(...)` — the same, waiting for the parse.
 * - `documentTableNames(node)` — the sheet names (synchronous; empty until parsed).
 * - `documentRevision(node)` — a hash of the file's content: changes with every edit.
 * - `canReadDocumentTable(node)`, and `DOCUMENT_TABLE_PROVIDER` bundling all of these as a
 *   data-table provider (`canRead`, `tableNames`, `readTable`, `revision`).
 *
 * `sheet` is a sheet name (case-insensitive) or a 0-based index; default the first sheet.
 * `range` is A1 notation — "B2", "A1:C10", "A:C" (whole columns), "2:5" (whole rows) —
 * optionally with a sheet prefix ("'Cut list'!A1:D20", which overrides `sheet`). Without
 * a range the used range from A1 is read and a header row is detected (`hasHeader`: the
 * first row holds only text or empty cells and a later row holds a number or boolean); its texts become
 * `columns` and it is left out of `rows`. With a range the cells come back as they are
 * (`hasHeader` false, `columns` the column letters) unless `options.header` says otherwise.
 *
 * Text: `readDocumentText(node)` — the plain text of Markdown, text, JSON, XML, HTML, CSV,
 * DOCX, ODT and PDF documents (spreadsheets as tab-separated values); asynchronous.
 */

export type DocumentCellValue = string | number | boolean | null;

/** A table of values — the shape data bindings consume. */
export interface DataTable {
    /** The sheet name. */
    readonly name: string;
    /** Column names: the header row's texts, else the column letters ("A", "B", …). */
    readonly columns: readonly string[];
    /** Row-major evaluated values, without the header row. */
    readonly rows: readonly (readonly DocumentCellValue[])[];
    readonly hasHeader?: boolean;
}

export interface DocumentTable extends DataTable {
    /** The range read, in A1 notation ("A1:C10"), header row included; "" for an empty sheet. */
    readonly range: string;
}

export interface DocumentTableOptions {
    /** Treat the first row as column names: true, false, or "auto" (the default without a range). */
    readonly header?: boolean | "auto";
}

/** The error of `readDocumentTable` while a binary workbook is still being parsed. */
export const DOCUMENT_NOT_LOADED = "document not loaded";

interface CachedWorkbook {
    readonly content: string;
    readonly workbook: WorkbookData;
    readonly evaluator: WorkbookEvaluator;
}

const cache = new WeakMap<DocumentFileNode, CachedWorkbook>();
const loading = new WeakMap<DocumentFileNode, { content: string; promise: Promise<Result<WorkbookData>> }>();
const failures = new WeakMap<DocumentFileNode, { content: string; error: string }>();
const revisions = new WeakMap<DocumentFileNode, { content: string; hash: string }>();
/** Parses finished per node: part of the provider revision, so a finished parse re-scopes. */
const generations = new WeakMap<DocumentFileNode, number>();
const listeners = new Set<(node: DocumentFileNode) => void>();

/** Called with a node whenever its table data became available or changed (a parse finished). */
export function onDocumentTablesChanged(listener: (node: DocumentFileNode) => void): IDisposable {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
}

function notify(node: DocumentFileNode): void {
    generations.set(node, (generations.get(node) ?? 0) + 1);
    for (const listener of [...listeners]) {
        try {
            listener(node);
        } catch (error) {
            Logger.warn("documents: a table listener failed", error);
        }
    }
}

function asDocument(node: INode): DocumentFileNode | undefined {
    return node instanceof DocumentFileNode ? node : undefined;
}

/** Whether `node` is a spreadsheet document `readDocumentTable` reads. */
export function canReadDocumentTable(node: INode): boolean {
    const document = asDocument(node);
    return document !== undefined && isWorkbookFormat(document.format) && document.format !== "xls";
}

/** A hash of the node's file content; a new value after every change of the file. */
export function documentRevision(node: INode): string {
    const document = asDocument(node);
    if (document === undefined) return "";
    const content = document.content;
    const known = revisions.get(document);
    if (known?.content === content) return known.hash;
    const hash = sha256Hex(content);
    revisions.set(document, { content, hash });
    return hash;
}

function cached(node: DocumentFileNode): CachedWorkbook | undefined {
    const entry = cache.get(node);
    return entry?.content === node.content ? entry : undefined;
}

function remember(node: DocumentFileNode, workbook: WorkbookData, content = node.content): CachedWorkbook {
    const entry = { content, workbook, evaluator: new WorkbookEvaluator(workbook) };
    cache.set(node, entry);
    return entry;
}

/** Records the workbook a node's current content parses to (the grid editor after saving). */
export function setDocumentWorkbook(node: DocumentFileNode, workbook: WorkbookData): void {
    remember(node, workbook);
    notify(node);
}

/** Parses (once per content) the workbook of a spreadsheet document. */
export async function loadDocumentWorkbook(input: INode): Promise<Result<WorkbookData>> {
    const node = asDocument(input);
    if (node === undefined || !isWorkbookFormat(node.format)) {
        return Result.err(`${input.name} is not a spreadsheet document`);
    }
    const hit = cached(node);
    if (hit !== undefined) return Result.ok(hit.workbook);
    const content = node.content;
    const running = loading.get(node);
    if (running?.content === content) return running.promise;
    const promise = readWorkbook(node.bytes, node.format, node.name).then((result) => {
        if (loading.get(node)?.promise === promise) loading.delete(node);
        if (node.content === content) {
            if (result.isOk) {
                remember(node, result.value, content);
                notify(node);
            } else {
                failures.set(node, { content, error: result.error });
            }
        }
        return result;
    });
    loading.set(node, { content, promise });
    return promise;
}

function sheetIndex(workbook: WorkbookData, sheet: string | number | undefined): number {
    if (sheet === undefined) return 0;
    if (typeof sheet === "number") {
        return Number.isInteger(sheet) && sheet >= 0 && sheet < workbook.sheets.length ? sheet : -1;
    }
    const lower = sheet.toLowerCase();
    return workbook.sheets.findIndex((s) => s.name.toLowerCase() === lower);
}

/** Splits "'Sheet name'!A1:B2" / "Sheet1!A1" into sheet and range. */
function splitSheet(range: string): { sheet?: string; range: string } {
    const quoted = /^'((?:[^']|'')+)'!(.*)$/.exec(range.trim());
    if (quoted) return { sheet: quoted[1].replace(/''/g, "'"), range: quoted[2] };
    const plain = /^([^!']+)!(.*)$/.exec(range.trim());
    if (plain) return { sheet: plain[1], range: plain[2] };
    return { range };
}

const toCell = (value: Scalar): DocumentCellValue => (isFormulaError(value) ? value.code : value);

function looksLikeHeader(rows: readonly (readonly DocumentCellValue[])[]): boolean {
    if (rows.length < 2) return false;
    const [first, ...rest] = rows;
    const isLabel = (cell: DocumentCellValue) =>
        typeof cell === "string" && cell.trim() !== "" && !cell.startsWith("#");
    const allText =
        first.some(isLabel) && first.every((cell) => cell === null || cell === "" || isLabel(cell));
    const hasData = rest.some((row) =>
        row.some((cell) => typeof cell === "number" || typeof cell === "boolean"),
    );
    return allText && hasData;
}

function tableOf(
    entry: CachedWorkbook,
    sheet: string | number | undefined,
    range: string | undefined,
    options: DocumentTableOptions,
): Result<DocumentTable> {
    const split = range === undefined || range.trim() === "" ? undefined : splitSheet(range);
    const index = sheetIndex(entry.workbook, split?.sheet ?? sheet);
    if (index < 0) return Result.err(`No sheet ${JSON.stringify(split?.sheet ?? sheet)}`);
    const data = entry.workbook.sheets[index];
    const size = usedSize(data);
    let resolved: CellRange;
    if (split === undefined) {
        if (size.rows === 0)
            return Result.ok({ name: data.name, range: "", columns: [], rows: [], hasHeader: false });
        resolved = { start: { row: 0, col: 0 }, end: { row: size.rows - 1, col: size.cols - 1 } };
    } else {
        const parsed = parseRange(split.range, size);
        if (parsed === undefined) return Result.err(`Invalid range "${range}"`);
        resolved = parsed;
    }
    const values = entry.evaluator.range(index, resolved.start, resolved.end).map((row) => row.map(toCell));
    const mode = options.header ?? (split === undefined ? "auto" : false);
    const hasHeader = mode === "auto" ? looksLikeHeader(values) : mode && values.length > 0;
    const columns = hasHeader
        ? values[0].map((cell, i) =>
              cell === null || cell === "" ? columnName(resolved.start.col + i) : String(cell),
          )
        : (values[0]?.map((_, i) => columnName(resolved.start.col + i)) ?? []);
    return Result.ok({
        name: data.name,
        range: rangeText(resolved),
        columns,
        rows: hasHeader ? values.slice(1) : values,
        hasHeader,
    });
}

/** The cached (or, for CSV/TSV, freshly parsed) workbook entry of a node; undefined while loading. */
function entryOf(node: DocumentFileNode): Result<CachedWorkbook> {
    const hit = cached(node);
    if (hit !== undefined) return Result.ok(hit);
    if (node.format === "csv" || node.format === "tsv") {
        return Result.ok(
            remember(node, csvToWorkbook(node.text, node.name, node.format === "tsv" ? "\t" : undefined)),
        );
    }
    const failure = failures.get(node);
    if (failure?.content === node.content) return Result.err(failure.error);
    void loadDocumentWorkbook(node);
    return Result.err(DOCUMENT_NOT_LOADED);
}

/** The evaluated cells of a spreadsheet document, synchronously (see the module comment). */
export function readDocumentTable(
    node: INode,
    sheet?: string | number,
    range?: string,
    options: DocumentTableOptions = {},
): Result<DocumentTable> {
    const document = asDocument(node);
    if (document === undefined || !isWorkbookFormat(document.format)) {
        return Result.err(`${node.name} is not a spreadsheet document`);
    }
    const entry = entryOf(document);
    if (!entry.isOk) return Result.err(entry.error);
    return tableOf(entry.value, sheet, range, options);
}

/** `readDocumentTable`, waiting for the workbook to be parsed. */
export async function loadDocumentTable(
    node: INode,
    sheet?: string | number,
    range?: string,
    options: DocumentTableOptions = {},
): Promise<Result<DocumentTable>> {
    const workbook = await loadDocumentWorkbook(node);
    if (!workbook.isOk) return Result.err(workbook.error);
    const document = node as DocumentFileNode;
    return tableOf(cached(document) ?? remember(document, workbook.value), sheet, range, options);
}

/** The sheet names of a spreadsheet document; empty while a binary workbook is being parsed. */
export function documentTableNames(node: INode): readonly string[] {
    const document = asDocument(node);
    if (document === undefined || !isWorkbookFormat(document.format)) return [];
    const entry = entryOf(document);
    return entry.isOk ? entry.value.workbook.sheets.map((sheet) => sheet.name) : [];
}

/**
 * The data-table provider of document elements: register it with the data-binding module
 * (`registerDataTableProvider(DOCUMENT_TABLE_PROVIDER)`).
 */
export const DOCUMENT_TABLE_PROVIDER = {
    canRead: canReadDocumentTable,
    tableNames: documentTableNames,
    readTable: (node: INode, sheet?: string, range?: string): Result<DataTable> =>
        readDocumentTable(node, sheet, range),
    /**
     * The content hash plus the parses finished: a workbook read before its parse finished
     * answered `DOCUMENT_NOT_LOADED`, and the finished parse must change the revision (the
     * content did not) for the document scope to re-read it.
     */
    revision: (node: INode): string => {
        const document = asDocument(node);
        return `${documentRevision(node)}:${document === undefined ? 0 : (generations.get(document) ?? 0)}`;
    },
} as const;

/** The plain text of a document (see the module comment). */
export async function readDocumentText(input: INode): Promise<Result<string>> {
    const node = asDocument(input);
    if (node === undefined) return Result.err(`${input.name} is not a document`);
    const { htmlToText } = await import("./text/markdown");
    switch (node.format) {
        case "markdown":
        case "text":
        case "json":
        case "xml":
        case "svg":
        case "dxf":
        case "featurescript":
        case "csv":
        case "tsv":
            return Result.ok(node.text);
        case "html":
            return Result.ok(htmlToText(node.text));
        case "docx": {
            const { docxToHtml } = await import("@chili3d/richtext/docx");
            return Result.ok(htmlToText((await docxToHtml(node.bytes)).html));
        }
        case "odt": {
            const { odtToHtml } = await import("@chili3d/richtext/odt");
            return Result.ok(htmlToText(await odtToHtml(node.bytes)));
        }
        case "pdf": {
            const { pdfText } = await import("./viewers/pdfText");
            return pdfText(node.bytes);
        }
        default: {
            if (!isWorkbookFormat(node.format)) return Result.err(`${node.fileName} has no text`);
            const table = await loadDocumentTable(node, undefined, undefined, { header: false });
            if (!table.isOk) return Result.err(table.error);
            return Result.ok(
                table.value.rows
                    .map((row) => row.map((v) => (v === null ? "" : String(v))).join("\t"))
                    .join("\n"),
            );
        }
    }
}
