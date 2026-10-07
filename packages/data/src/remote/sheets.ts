// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DataTable, Result } from "@chili3d/core";
import type { SheetSourceDefinition } from "../model/definition";
import { readCsv } from "../readers/csv";
import { readWorkbook } from "../readers/spreadsheet";
import { checkUrl, fetchChecked, type RemoteContext } from "./request";

/**
 * Online spreadsheets through their export links — no API key: the sheet must be shared with
 * "anyone with the link" or published to the web.
 *
 * - Google Sheets: each tab is read as CSV — `…/export?format=csv&gid=<gid>` for a tab id,
 *   `…/gviz/tq?tqx=out:csv&sheet=<name>` for a tab name, `…/pub?output=csv&gid=<gid>` for a
 *   published sheet; a link that already exports CSV is used as it is.
 * - Excel Online (OneDrive / SharePoint): the workbook is downloaded (`download=1`) and read as
 *   .xlsx, every sheet a table — or, for a published CSV link, that CSV.
 */

export interface SheetExport {
    readonly name: string;
    readonly url: string;
}

const isCsvLink = (url: URL) =>
    url.searchParams.get("output") === "csv" ||
    url.searchParams.get("format") === "csv" ||
    (url.searchParams.get("tqx") ?? "").includes("out:csv") ||
    /\.csv$/i.test(url.pathname);

/** A tab spec: `gid=123` or a bare number is a tab id, anything else a tab name. */
function tabSpec(spec: string): { gid: string } | { name: string } {
    const match = /^(?:gid\s*=\s*)?(\d+)$/.exec(spec.trim());
    return match === null ? { name: spec.trim() } : { gid: match[1] };
}

/** The CSV export links of a Google Sheets link, one per requested tab. */
export function googleSheetExports(link: string, sheets: readonly string[] = []): Result<SheetExport[]> {
    const checked = checkUrl(link);
    if (!checked.isOk) return Result.err(checked.error);
    const url = checked.value;
    if (isCsvLink(url))
        return Result.ok([{ name: url.searchParams.get("sheet") ?? "Sheet1", url: url.href }]);
    const published = /\/spreadsheets\/d\/e\/([\w-]+)/.exec(url.pathname);
    const document = /\/spreadsheets\/d\/([\w-]+)/.exec(url.pathname);
    if (published === null && document === null) {
        return Result.err("Not a Google Sheets link: expected docs.google.com/spreadsheets/d/…");
    }
    const linkGid = /gid=(\d+)/.exec(url.hash)?.[1] ?? url.searchParams.get("gid") ?? undefined;
    const tabs = sheets.filter((sheet) => sheet.trim() !== "").map(tabSpec);
    if (tabs.length === 0) tabs.push(linkGid === undefined ? { gid: "" } : { gid: linkGid });
    const exports: SheetExport[] = [];
    for (const tab of tabs) {
        if (published !== null) {
            if ("name" in tab)
                return Result.err(`A published sheet is read by tab id (gid), not by name: ${tab.name}`);
            const base = `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=csv`;
            exports.push({
                name: tab.gid === "" ? "Sheet1" : `gid ${tab.gid}`,
                url: tab.gid === "" ? base : `${base}&single=true&gid=${tab.gid}`,
            });
            continue;
        }
        const base = `https://docs.google.com/spreadsheets/d/${document?.[1]}`;
        if ("name" in tab) {
            exports.push({
                name: tab.name,
                url: `${base}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab.name)}`,
            });
        } else {
            exports.push({
                name: tab.gid === "" ? "Sheet1" : `gid ${tab.gid}`,
                url:
                    tab.gid === "" ? `${base}/export?format=csv` : `${base}/export?format=csv&gid=${tab.gid}`,
            });
        }
    }
    return Result.ok(exports);
}

/** The download link of an Excel Online share link (or the link itself when it is a CSV export). */
export function excelOnlineExport(link: string): Result<{ url: string; csv: boolean }> {
    const checked = checkUrl(link);
    if (!checked.isOk) return Result.err(checked.error);
    const url = checked.value;
    if (isCsvLink(url)) return Result.ok({ url: url.href, csv: true });
    url.searchParams.set("download", "1");
    return Result.ok({ url: url.href, csv: false });
}

const LOGIN_PAGE =
    "The link answered a web page instead of the sheet — share it with anyone with the link, or publish it to the web";

export async function fetchSheetTables(
    definition: SheetSourceDefinition,
    context: RemoteContext,
): Promise<Result<DataTable[]>> {
    const hasHeader = definition.hasHeader ?? true;
    if (definition.provider === "google") {
        const exports = googleSheetExports(definition.url, definition.sheets);
        if (!exports.isOk) return Result.err(exports.error);
        const tables: DataTable[] = [];
        for (const sheet of exports.value) {
            const response = await fetchChecked(sheet.url, { method: "GET" }, context);
            if (!response.isOk) return Result.err(response.error);
            if ((response.value.headers.get("content-type") ?? "").includes("text/html"))
                return Result.err(LOGIN_PAGE);
            tables.push(readCsv(sheet.name, await response.value.text(), { hasHeader }));
        }
        return Result.ok(tables);
    }
    const target = excelOnlineExport(definition.url);
    if (!target.isOk) return Result.err(target.error);
    const response = await fetchChecked(target.value.url, { method: "GET" }, context);
    if (!response.isOk) return Result.err(response.error);
    if ((response.value.headers.get("content-type") ?? "").includes("text/html"))
        return Result.err(LOGIN_PAGE);
    if (target.value.csv) return Result.ok([readCsv("Sheet1", await response.value.text(), { hasHeader })]);
    const tables = await readWorkbook(new Uint8Array(await response.value.arrayBuffer()), hasHeader);
    const wanted = (definition.sheets ?? []).map((sheet) => sheet.trim()).filter((sheet) => sheet !== "");
    return Result.ok(wanted.length === 0 ? tables : tables.filter((table) => wanted.includes(table.name)));
}
