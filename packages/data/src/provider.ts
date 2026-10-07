// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DataTable,
    type IDataTableProvider,
    type INode,
    parseCellRange,
    Result,
    sliceDataTable,
} from "@chili3d/core";
import { type DataSourceNode, isDataSourceNode } from "./dataSourceNode";

/** A source's table by name, or the reason there is none. */
export function dataSourceTable(source: DataSourceNode, sheet?: string, range?: string): Result<DataTable> {
    const tables = source.tables;
    if (tables.length === 0) {
        const reason = source.status.state === "error" ? `: ${source.status.message}` : " — refresh it";
        return Result.err(`Data source "${source.name}" has no tables yet${reason}`);
    }
    const table = source.table(sheet);
    if (table === undefined) {
        return Result.err(
            `Data source "${source.name}" has no table "${sheet}" (tables: ${tables.map((x) => x.name).join(", ")})`,
        );
    }
    if (range === undefined || range.trim() === "") return Result.ok(table);
    const cells = parseCellRange(range);
    return cells === undefined
        ? Result.err(`Not a cell range: ${range}`)
        : Result.ok(sliceDataTable(table, cells));
}

/** Data Source nodes as `IDataTableProvider` — how core's `findDataTable` reaches them. */
export const DATA_SOURCE_TABLES: IDataTableProvider = {
    canRead: (node: INode) => isDataSourceNode(node),
    tableNames: (node: INode) => (node as DataSourceNode).tables.map((table) => table.name),
    readTable: (node: INode, sheet?: string, range?: string) =>
        dataSourceTable(node as DataSourceNode, sheet, range),
    revision: (node: INode) => (node as DataSourceNode).revision,
};
