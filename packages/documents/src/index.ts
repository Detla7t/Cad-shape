// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * `@chili3d/documents`: drawings and office files in a Chili3D document.
 *
 * - CAD formats: DXF/DWG import (as a sketch plus a drawing element), multiview drawing
 *   export (DXF/DWG/SVG, kernel hidden-line removal), OBJ/glTF/GLB/3MF mesh import.
 * - Document elements: Markdown, Word, OpenDocument text, spreadsheets (CSV/TSV/XLSX/
 *   ODS; .xls is kept but not opened), PDF, images and text, each with a viewer/editor,
 *   stored inside the project.
 * - `readDocumentTable` / `readDocumentText` (see `api.ts`) for other modules.
 *
 * Importing the module registers the node class, the project-file mapping, the element
 * kinds and the commands; `registerDocumentsModule()` adds the importers, the icons and the
 * data-table provider that makes spreadsheet elements readable by `data()` / `lookup()`.
 */

import { type IDisposable, notifyDataTablesChanged, registerDataTableProvider } from "@chili3d/core";
import { DOCUMENT_TABLE_PROVIDER, onDocumentTablesChanged } from "./api";
import "./commands";
import "./sketchActions";
import { installDocumentIcons } from "./documentIcons";
import { registerDocumentImporters } from "./importers";
import { registerDocumentElements } from "./ui/documentElements";

export * from "./api";
export * from "./cad/drawingToSketch";
export { type DwgBackend, importDwg, setDwgBackends, writeDwg } from "./cad/dwg";
export { readDxfFile, readDxfGroups } from "./cad/dxfReader";
export * from "./cad/dxfToDrawing";
export * from "./cad/meshImport";
export * from "./cad/projection";
export * from "./commands";
export * from "./documentFileNode";
export * from "./documentFormats";
export * from "./importers";
export * from "./ribbon";
export { WorkbookEvaluator } from "./sheet/formula";
export type { CellData, SheetData, WorkbookData } from "./sheet/model";
export { formatCellValue } from "./sheet/numberFormat";
export { readWorkbook, type WorkbookFormat, writeWorkbook, XLS_UNSUPPORTED } from "./sheet/workbookIo";

let registered: IDisposable | undefined;

/** Registers the importers, element kinds, tab icons and the data-table provider (idempotent). */
export function registerDocumentsModule(): IDisposable {
    if (registered !== undefined) return registered;
    installDocumentIcons();
    const handles = [
        registerDocumentImporters(),
        registerDocumentElements(),
        // Spreadsheet elements are data tables: `data("Cut list", "B3")`, `lookup(...)`.
        registerDataTableProvider(DOCUMENT_TABLE_PROVIDER),
        onDocumentTablesChanged((node) => notifyDataTablesChanged(node.document)),
    ];
    registered = {
        dispose: () => {
            for (const handle of handles) handle.dispose();
            registered = undefined;
        },
    };
    return registered;
}
