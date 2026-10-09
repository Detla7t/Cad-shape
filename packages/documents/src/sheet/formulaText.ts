// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { columnName } from "./model";

/**
 * Excel relative references follow a moved/copied formula; absolute references do not.
 * Structured-reference brackets (`Sales[[#This Row],[Q1]]`) and string literals stay as they are.
 */
export function translateFormula(formula: string, rows: number, cols = 0): string {
    return formula.replace(
        /"(?:[^"]|"")*"|\[(?:[^[\]]|\[[^\]]*\])*\]|'(?:[^']|'')*'!|\b[A-Za-z_][\w.]*!|(?<![\w.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![\w.([])/g,
        (token, absoluteCol: string | undefined, letters: string, absoluteRow: string, digits: string) => {
            if (absoluteCol === undefined) return token;
            const c =
                [...letters.toUpperCase()].reduce((n, v) => n * 26 + v.charCodeAt(0) - 64, 0) -
                1 +
                (absoluteCol ? 0 : cols);
            const r = Number(digits) - 1 + (absoluteRow ? 0 : rows);
            return r < 0 || c < 0 || c >= 16384 || r >= 1048576
                ? "#REF!"
                : `${absoluteCol}${columnName(c)}${absoluteRow}${r + 1}`;
        },
    );
}
