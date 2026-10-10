// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * `@chili3d/sheet`: the spreadsheet engine, pure (no CAD, no UI).
 *
 * - `model.ts`: the workbook data (`WorkbookData` → sheets → cells by A1 address, styles,
 *   merges, names, validations, tables, pictures, hyperlinks) and address helpers.
 * - `formula.ts`: the formula engine (`WorkbookEvaluator`, `parseFormula`), its function
 *   library and reference data (`functionInfo.ts`, `formulaSuggestions.ts`).
 * - `numberFormat.ts`, `cellStyle.ts`, `ranges.ts`, `operations.ts`: number formats, styles
 *   and colours, named ranges and structured references, range edits (sort, fill, validation).
 * - `workbookIo.ts`: `readWorkbook` / `writeWorkbook` for CSV/TSV/XLSX/ODS. XLSX (ExcelJS)
 *   and ODS load on first use; import `@chili3d/sheet/xlsx` or `@chili3d/sheet/ods` directly
 *   only where that cost is wanted. Every module is also reachable as `@chili3d/sheet/<module>`,
 *   which keeps bundle chunks as fine as the importer's.
 */

export * from "./cellStyle";
export * from "./csv";
export * from "./formula";
export * from "./formulaSuggestions";
export * from "./formulaText";
export * from "./functionInfo";
export * from "./model";
export * from "./numberFormat";
export * from "./operations";
export * from "./ranges";
export * from "./workbookIo";
