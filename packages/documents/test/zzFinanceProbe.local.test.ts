// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
// TEMPORARY probe against the user's local file (deleted after use).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const log = (...a: unknown[]) => appendFileSync("/tmp/xlsx-scripts/probe.out", `${a.join(" ")}\n`);

import { readXlsx, writeXlsx } from "../src/sheet/xlsx";

test("finance probe", async () => {
    const bytes = new Uint8Array(readFileSync("/tmp/xlsx-in/finance_tracker.xlsx"));
    await readXlsx(bytes);
    const t0 = performance.now();
    const book = await readXlsx(bytes);
    const t1 = performance.now();
    const out = await writeXlsx(book);
    const t2 = performance.now();
    writeFileSync("/tmp/xlsx-scripts/roundtrip.xlsx", out);
    const back = await readXlsx(out);
    const summary = (b: typeof book) =>
        b.sheets.map((s) => ({
            name: s.name,
            cells: Object.keys(s.cells).length,
            formulas: Object.values(s.cells).filter((c) => c.f).length,
            arrays: Object.entries(s.cells)
                .filter(([, c]) => c.a)
                .map(([k, c]) => `${k}:${c.a}`),
            sp: Object.values(s.cells).filter((c) => c.sp).length,
            tables: s.tables?.map((t) => `${t.name} ${t.ref} ${t.columns.length}`),
            links: Object.keys(s.hyperlinks ?? {}).length,
            images: s.images?.map(
                (i) =>
                    `${i.mime} ${JSON.stringify(i.from)} ${JSON.stringify(i.to ?? i.size)} ${i.fallback ? "fb" : ""} ${i.hyperlink?.target ?? ""}`,
            ),
            grid: s.gridLines,
            validations: Object.keys(s.validations ?? {}).length,
        }));
    log(`read ${(t1 - t0).toFixed(0)} ms, write ${(t2 - t1).toFixed(0)} ms, ${out.length} bytes`);
    log(JSON.stringify(summary(book), null, 1));
    log(JSON.stringify(book.names));
    log(
        JSON.stringify(summary(back)) === JSON.stringify(summary(book))
            ? "ROUNDTRIP SUMMARY EQUAL"
            : JSON.stringify(summary(back), null, 1),
    );
    log(JSON.stringify(back.names));
    const s2 = book.sheets[1];
    log(JSON.stringify(s2.cells.B3), JSON.stringify(s2.cells.G4), JSON.stringify(s2.cells.I4));
    log(JSON.stringify(book.sheets[0].cells.J2));
    log(
        JSON.stringify(book.sheets[2].cells.O10),
        JSON.stringify(book.sheets[2].cells.O11),
        JSON.stringify(book.sheets[2].hyperlinks?.H301),
    );
}, 60000);
