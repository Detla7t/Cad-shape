# @chili3d/documents

Drawings and office files inside a Chili3D document. Enabled with
`new AppBuilder()...useDocuments()`, which registers the importers, the document element kinds,
the commands and the ribbon entries (File tab: new Markdown / spreadsheet / rich text / text,
and "Export views" in the 2D export group).

## What it adds

- **One Import command for every format.** `detectFileFormat` (core, `fileFormat.ts`)
  identifies a file by its content (magic bytes, zip and OLE entries, text signatures) and
  falls back to its extension. Importers register with `registerFileImporter` (core,
  `dataExchange.ts`). Proprietary CAD formats (Parasolid `.x_t`/`.x_b`, SolidWorks, CATIA,
  Inventor, Fusion, Creo/NX `.prt`, Solid Edge, JT, ACIS, Rhino, SketchUp) are recognized and
  answered with a message asking for a STEP export.
- **DXF import** (`cad/dxfReader.ts`, `dxfToDrawing.ts`, `drawingToSketch.ts`). ASCII and
  binary DXF are read into a units-aware 2D drawing, which becomes a `SketchNode` on XY plus a
  drawing element showing the original layers, colors and text. Supported entities: LINE,
  ARC, CIRCLE, ELLIPSE, LWPOLYLINE/POLYLINE with bulges, SPLINE (control points or fit
  points), TEXT/MTEXT/ATTRIB, INSERT/MINSERT with nested blocks, DIMENSION blocks, LEADER,
  SOLID/TRACE/3DFACE. Layers that are frozen or turned off are skipped. `$INSUNITS` is
  converted to mm.
- **DWG import** (`cad/dwg.ts`). LibreDWG (WebAssembly) converts DWG to DXF, and the DXF
  path above does the rest. acad-ts is the fallback reader.
- **Drawing export** (`cad/projection.ts`, command `drawing.exportViews`). Front, top and
  right views (third or first angle) plus an optional isometric view of the selected bodies,
  written as DXF R12, DWG (AC1018, through acad-ts) or SVG. Visible and hidden edges go on
  separate layers.
- **Mesh import** (`cad/meshImport.ts`). OBJ, glTF/GLB and 3MF are converted to `MeshNode`s
  in mm.
- **Document elements** (`documentFileNode.ts`, `ui/`). Each file becomes its own tab with a
  viewer or editor that loads on first use:
  - Markdown: CodeMirror editor with a sanitized live preview; exports .md and .html.
  - DOCX and ODT: an editable rich-text view (mammoth for DOCX), saved back through
    `docx` or the built-in ODT writer (`@chili3d/richtext`). Formatting the editor does not
    model is dropped, and the view says so.
  - Spreadsheets: CSV/TSV/XLSX/ODS in a grid with sheet tabs, a formula bar, the Excel
    function library of `@chili3d/sheet` (`formula.ts`), number formats, column widths and
    copy/paste. Files save in their own format. XLSX goes through ExcelJS; ODS through the
    built-in reader and writer. Excel 97–2003 `.xls` files are kept in the project but not
    opened.
  - PDF (pdf.js, with its own worker), images, and plain text/JSON/XML.

## Engines and viewers

The file engines are separate packages without UI; this package holds the viewers, the
document element and the CAD formats, and imports the engines module by module
(`@chili3d/sheet/formula`, `@chili3d/richtext/docx`, …) so each viewer chunk stays as small as
before:

- `@chili3d/sheet` — workbook model, formula engine, number formats, range operations,
  CSV/TSV/XLSX/ODS read/write (`readWorkbook` / `writeWorkbook`; XLSX and ODS load lazily).
- `@chili3d/richtext` — the rich-text block model, the HTML sanitizer, DOCX and ODT.
- `@chili3d/office-io` — what both share: XML escapes, the OpenDocument package (read and
  write), picture media types, office lengths, legacy (UTF-8 / Windows-1252) text decoding,
  which the DXF reader uses too.

`index.ts` still re-exports `WorkbookEvaluator`, `formatCellValue`, `readWorkbook`,
`writeWorkbook`, `XLS_UNSUPPORTED` and the workbook types for existing importers.

## Storage

A `DocumentFileNode` keeps the whole file in one serialized property, `content`. Text
formats are stored as UTF-8 text; everything else is stored as base64. Because the file is
part of the node, the existing paths carry it with no extra work: undo/redo, version history,
copy/paste and the IndexedDB store (which saves `Document.serialize()`). In a `.chili3d`
project the property is written as the raw file under `files/`. The `$encoding: "base64"`
mapping is described in `docs/project-format.md`. A separate IndexedDB blob store would have
needed its own garbage collection, its own undo and its own export, and saves little: base64
costs 4/3 of the file size, and only while the document is open or stored in the browser.

## API for other modules (`api.ts`)

```ts
// Synchronous tables from a cached parse. CSV/TSV are parsed on the spot. The first read of
// an XLSX/ODS file starts parsing, returns err(DOCUMENT_NOT_LOADED), and fires
// onDocumentTablesChanged when the parse finishes.
DOCUMENT_TABLE_PROVIDER: { canRead, tableNames, readTable(node, sheet?, range?), revision }
readDocumentTable(node, sheet?, range?, { header?: boolean | "auto" }): Result<DocumentTable>
loadDocumentTable(node, sheet?, range?): Promise<Result<DocumentTable>>
documentTableNames(node): readonly string[]
documentRevision(node): string            // SHA-256 of the stored content
onDocumentTablesChanged(listener): IDisposable
readDocumentText(node): Promise<Result<string>>   // Markdown, HTML, DOCX, ODT, PDF, text, sheets
```

`DataTable` is `{ name, columns, rows, hasHeader? }`, with cells of type
`number | string | boolean | null`. Formula cells hold their computed values, and errors
appear as their code (`#DIV/0!`).

## Third-party licenses

| Package | License | Used for | Loaded |
| --- | --- | --- | --- |
| `@mlightcad/libredwg-web` (LibreDWG) | GPL-3.0 | DWG reading | lazy chunk + 9.5 MB wasm, on first DWG |
| `@node-projects/acad-ts` | MIT | DWG writing, fallback DWG reader | lazy |
| `exceljs` | MIT | XLSX read/write | lazy |
| `mammoth` | BSD-2-Clause | DOCX to HTML | lazy |
| `docx` | MIT | DOCX writing | lazy |
| `pdfjs-dist` | Apache-2.0 | PDF viewing and text | lazy (own worker) |
| `marked` | MIT | Markdown rendering | lazy |
| `jszip` | MIT (dual MIT/GPL-3.0) | ODS/ODT/3MF containers | lazy |
| `three` loaders | MIT | OBJ/glTF/3MF | lazy |
| `@codemirror/*` | MIT | text editors | lazy |

LibreDWG is GPL-3.0. Chili3D's TypeScript is AGPL-3.0, and GPL-3.0 code may be combined with
AGPL-3.0 code (GPL-3.0 §13), so the combined web build stays AGPL-3.0. A build distributed
under the commercial license should leave LibreDWG out with `setDwgBackends` (acad-ts
only). npm `xlsx` (SheetJS) is deliberately not used: the npm release has unfixed
advisories.
