// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type DataCell,
    type DataTable,
    LENGTH_UNITS,
    parseDataQuantity,
    unitSpecEquals,
} from "@chili3d/core";
import { FsContext, MM_PER_METER } from "../context/fsContext";
import { ANGLE, expectString, FsArray, FsMap, FsQuantity, type FsValue, fail, LENGTH } from "../lang/values";

/**
 * `getDataTable(context, "Parts")` — a Chili3d extension on both stds: the document data table
 * (a Data Source's sheet or query result, see `findDataTable`) as an array of maps, one per data
 * row, keyed by column header. Numbers and booleans arrive as they are, text with a unit suffix
 * as a `ValueWithUnits` ("12 mm" is 0.012 meter, "30 deg" π/6 radian), other text as a string,
 * and an empty cell as `undefined`. The array is a fresh copy each call, so a studio cannot
 * write back into the source.
 */
export function getDataTable(contextValue: FsValue, nameValue: FsValue): FsArray {
    const context = FsContext.of(contextValue);
    const name = expectString(nameValue, "data table name");
    if (context.dataTables === undefined) fail(`Data table "${name}" is not available outside a document`);
    const table = context.dataTables(name);
    if (!table.isOk) fail(table.error);
    return dataTableValue(table.value);
}

/** A table as FeatureScript data: an array of `{ header: value }` maps. */
export function dataTableValue(table: DataTable): FsArray {
    return new FsArray(
        table.rows.map((row) => {
            const map = new FsMap();
            table.columns.forEach((column, index) => {
                const value = dataCellToFs(row[index] ?? null);
                if (value !== undefined) map.set(column, value);
            });
            return map;
        }),
    );
}

function dataCellToFs(cell: DataCell): FsValue {
    if (cell === null) return undefined;
    if (typeof cell !== "string") return cell;
    const quantity = parseDataQuantity(cell);
    if (quantity === undefined) return cell;
    if (unitSpecEquals(quantity.unit, LENGTH_UNITS))
        return new FsQuantity(quantity.value / MM_PER_METER, LENGTH);
    if (unitSpecEquals(quantity.unit, ANGLE_UNITS))
        return new FsQuantity((quantity.value * Math.PI) / 180, ANGLE);
    // Unitless text ("007", "50%") was written as text; it stays text.
    return cell;
}
