# Office editors: what to build on

The suite wants a Word equivalent, an Excel equivalent and a database manager beside the CAD.
This note records what the open-source office projects offer, what their licences allow a
project under the AGPL-3.0 to take, and what Chili3D does with that today.

## What the big three are

| Project | What it is | Licence | How it could be reused in a browser app |
| --- | --- | --- | --- |
| **LibreOffice** (core) | The C++ office suite: Writer, Calc, Base, Impress. | MPL-2.0 (most of core), some LGPL-3.0 | As **LibreOffice WebAssembly** ("LOWA"): the whole suite compiled with Emscripten, ~300 MB of assets, a minute to start, one global instance. Collabora and allotropia (ZetaOffice) ship it. Usable as an embedded editor frame, not as a library of parts. |
| **Collabora Online** | LibreOffice core run on a server, drawn in the browser by a JavaScript client (tiles + a rich toolbar). | MPL-2.0 (client), core as above | Needs a server (CODE). The client is a good reference for toolbar and dialog behaviour; the rendering is server tiles, so there is nothing to lift into a client-only app. |
| **ONLYOFFICE Document Server** (`sdkjs` + `web-apps`) | A JavaScript suite: the Word/Excel/PowerPoint editors run entirely in the browser (canvas rendering, own layout engine), with a server for conversion and collaboration. | AGPL-3.0 (with a commercial option) | Licence-compatible with Chili3D (both AGPL-3.0). `sdkjs` is self-contained client code: a Writer and a Sheet engine with DOCX/XLSX read and write. It is very large (tens of MB), builds with its own Grunt pipeline, and is designed to be embedded whole in an iframe, not imported module by module. |

Honourable mentions, all MIT/Apache and importable as libraries: **ProseMirror** / **Tiptap** (rich text model and editor), **docx** (DOCX writer, used here), **mammoth** (DOCX reader, used here), **ExcelJS** (XLSX read/write, used here), **HyperFormula** (GPL-3.0, so not a fit), **Univer** (Apache-2.0: a sheet/doc/slide engine in TypeScript, rendering on canvas, DOCX/XLSX import), **sql.js** (SQLite in WebAssembly, used here).

## What Chili3D has now

- **Word equivalent**: `richTextViewer` (DOCX/ODT in and out through `@chili3d/richtext`'s `docx.ts` and `odt.ts`, a contentEditable page with styles, lists, tables, images, links). Default text is sans-serif (Arial in DOCX, Liberation Sans in ODT) unless a run sets a font.
- **Excel equivalent**: `spreadsheetViewer` with its own formula engine (`@chili3d/sheet`, `formula*.ts`: math, text, dates, financial, arrays, LET/LAMBDA), number formats, validation, names; XLSX/ODS/CSV in and out.
- **Database manager** (new): `@chili3d/data`'s `database/` — a SQLite file as a document element (`DatabaseNode`), the manager view (tables, paged rows edited in place, add/delete rows, create/drop tables, a SQL console) and an importer for `.sqlite`/`.db` files. Saves go back into the document as one undo step; the file is sniffed by its magic.

## Recommendation

1. Keep the own TypeScript editors as the shipped ones: they load in a chunk each, start instantly, store diffable text, and already cover the formats the shop uses.
2. For fidelity (tracked changes, Word styles, pivot tables, charts) embed **ONLYOFFICE `sdkjs`** as an optional "full editor" mode in an iframe rather than merging its code: it is AGPL-compatible, but its build and runtime are a product of their own, and an iframe boundary keeps a broken or heavy editor from taking the suite down (see `docs/modules-and-repos.md`).
3. Use **Univer** (Apache-2.0) as the candidate library if the sheet editor needs a canvas renderer and collaborative editing later; it is the only one of the field that is importable as modules.
4. LibreOffice WebAssembly and Collabora stay reference material (UI, DOCX corner cases); their size and server needs do not fit a client-only suite.

## Formula point mode (spreadsheet editor, 9 October 2026)

Modelled on LibreOffice Calc and Excel. While a formula is being typed — in the cell or in the formula bar — and the caret follows the `=`, an operator, an opening parenthesis or an argument separator:

- a click on a cell puts its reference into the formula instead of ending the edit; a drag stretches it to a range (`A1:B3`); Shift+click stretches the last pointed reference from its anchor;
- the reference just pointed stays "hot" (dashed frame): the next click or drag replaces it, until something is typed;
- the arrow keys walk the pointed cell from the formula's own cell, Shift+arrow stretches it; F4 cycles a reference's anchoring (`A1` → `$A$1` → `A$1` → `$A1`);
- a click on another sheet's tab keeps the edit alive: the formula moves into the bar, pointed cells are written as `Sheet2!A1` (`'My sheet'!A1` when the name needs quoting), and Enter writes the formula to its home cell and returns the view there; Escape drops it and returns too;
- the range finder frames every reference's cells in its own colour while the formula is edited;
- Enter closes the parentheses left open (`=SUM(A1:A2` becomes `=SUM(A1:A2)`).

A click anywhere else in the formula text (after typed characters) ends the edit and selects the cell, as before. Pure text rules live in `packages/sheet/src/formulaPointing.ts`; the viewer owns the mouse and keys.
