// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import { DocumentFileNode } from "../src/documentFileNode";
import { FORMULA_FUNCTIONS } from "../src/sheet/formula";
import { insertFunctionCall } from "../src/sheet/formulaSuggestions";
import { FUNCTION_INFO, functionCategory, functionDoc, searchFunctions } from "../src/sheet/functionInfo";
import { readWorkbook } from "../src/sheet/workbookIo";
import { createSpreadsheetViewer } from "../src/ui/viewers/spreadsheetViewer";

describe("function reference data", () => {
    const docs = ["SUM", "SUMIF", "SUMSQ", "ISNUMBER", "VLOOKUP", "NORM.DIST", "SQRT", "TODAY"].map(
        functionDoc,
    );

    test("every evaluated function has an explicit category and a description", () => {
        const uncategorized = FORMULA_FUNCTIONS.filter((name) => functionCategory(name) === "Other");
        expect(uncategorized).toEqual([]);
        expect(FORMULA_FUNCTIONS.filter((name) => functionDoc(name).description === "")).toEqual([]);
    });

    test("the engine's arity metadata keeps its tuple layout", () => {
        expect(FUNCTION_INFO["ROUND"][2]).toBe(1);
        expect(FUNCTION_INFO["ROUND"][3]).toBe(2);
    });

    test("arguments carry optional/repeating flags and notes", () => {
        const sumif = functionDoc("SUMIF");
        expect(sumif.category).toBe("Math & trig");
        expect(sumif.args.map((a) => [a.name, a.optional])).toEqual([
            ["range", false],
            ["criteria", false],
            ["sum_range", true],
        ]);
        expect(sumif.args[1].description).toContain("wildcards");
        const sum = functionDoc("SUM");
        expect(sum.args[1]).toMatchObject({ name: "number2", optional: true, repeating: true });
        expect(sum.example).toBe("=SUM(A1:A10)");
        expect(functionDoc("TODAY").zeroArgs).toBe(true);
        expect(functionDoc("SUM").zeroArgs).toBe(false);
    });

    test.each([
        ["SUM", ["SUM", "SUMIF", "SUMSQ"]],
        ["vlk", ["VLOOKUP"]],
        ["dist", ["NORM.DIST"]],
        ["square root", ["SQRT"]],
        ["number", ["ISNUMBER"]],
    ])("search %s ranks names before descriptions", (query, expected) => {
        expect(
            searchFunctions(docs, query)
                .map((d) => d.name)
                .slice(0, expected.length),
        ).toEqual(expected);
    });

    test("the category filter combines with the search", () => {
        expect(searchFunctions(docs, "", "Information").map((d) => d.name)).toEqual(["ISNUMBER"]);
        expect(searchFunctions(docs, "sum", "Information")).toEqual([]);
        expect(searchFunctions(docs, "").map((d) => d.name)).toEqual([...docs.map((d) => d.name)].sort());
    });

    test.each([
        ["=", 1, "SUM", {}, "=SUM()", 5],
        ["=VL", 3, "VLOOKUP", { names: ["VLOOKUP"] }, "=VLOOKUP()", 9],
        ["=SU(A1)", 3, "SUM", { names: ["SUM"] }, "=SUM(A1)", 5],
        ["=A1+", 4, "ROUND", { names: ["ROUND"] }, "=A1+ROUND()", 10],
        ["=12", 1, "ROUND", { wrapRest: true }, "=ROUND(12)", 9],
        ["=", 1, "TODAY", { zeroArgs: true }, "=TODAY()", 8],
        ["=A1", 3, "ABS", { names: ["ABS"] }, "=A1ABS()", 7],
    ])("insert into %s at %i: %s", (text, cursor, name, options, expected, caret) => {
        expect(insertFunctionCall(text, cursor, name, options)).toEqual({ text: expected, cursor: caret });
    });
});

describe("formula bar fx button and function browser", () => {
    async function setup() {
        const doc = new TestDocument();
        const node = new DocumentFileNode({
            document: doc,
            fileName: "Budget.csv",
            format: "csv",
            text: "Category,Amount\nFood,10\nRent,50",
        });
        const viewer = createSpreadsheetViewer({ node, document: doc, changed: () => {} });
        document.body.append(viewer.element);
        await Promise.resolve();
        const q = <T extends HTMLElement>(selector: string, root: ParentNode = viewer.element) => {
            const element = root.querySelector<T>(selector);
            expect(element).not.toBeNull();
            return element!;
        };
        const fx = q<HTMLButtonElement>('[aria-label="Insert function"]');
        const bar = q<HTMLInputElement>('[aria-label="Formula bar"]');
        const select = (address: string) => {
            const name = q<HTMLInputElement>('[aria-label="Cell or range"]');
            name.value = address;
            name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        };
        const browser = () =>
            document.querySelector<HTMLElement>('[role="dialog"][aria-label="Insert function"]');
        const search = () => q<HTMLInputElement>('[aria-label="Search functions"]', document);
        const key = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
            target.dispatchEvent(
                new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
            );
        const type = (text: string) => {
            search().value = text;
            search().dispatchEvent(new Event("input"));
        };
        const active = () => {
            const id = search().getAttribute("aria-activedescendant");
            expect(id).not.toBeNull();
            return document.getElementById(id!)?.querySelector("span")?.textContent;
        };
        const cell = (r: number, c: number) =>
            q<HTMLTableCellElement>(`td[data-row="${r}"][data-col="${c}"]`);
        const dispose = () => {
            viewer.dispose();
            viewer.element.remove();
        };
        return { viewer, fx, bar, select, browser, search, key, type, active, cell, q, dispose };
    }

    test("fx starts a formula from a number, inserts a function around it, and toggles back to a value", async () => {
        const ui = await setup();
        try {
            ui.select("B2");
            expect(ui.fx.getAttribute("aria-pressed")).toBe("false");
            expect(ui.fx.title).toContain("Shift+F3");
            ui.fx.click();
            expect(ui.bar.value).toBe("=10");
            expect(ui.fx.getAttribute("aria-pressed")).toBe("true");
            expect(ui.browser()).not.toBeNull();
            expect(document.activeElement).toBe(ui.search());
            ui.type("round");
            expect(ui.active()).toBe("ROUND");
            ui.key(ui.search(), "Enter");
            expect(ui.browser()).toBeNull();
            expect(ui.bar.value).toBe("=ROUND(10)");
            expect(document.activeElement).toBe(ui.bar);
            expect(ui.bar.selectionStart).toBe(9);
            ui.bar.value = "=ROUND(10/3, 2)";
            ui.key(ui.bar, "Enter");
            expect(ui.cell(1, 1).textContent).toBe("3.33");

            ui.select("B2");
            expect(ui.fx.getAttribute("aria-pressed")).toBe("true");
            ui.fx.click();
            expect(ui.bar.value).toBe("3.33");
            expect(ui.fx.getAttribute("aria-pressed")).toBe("false");
            expect(ui.cell(1, 1).textContent).toBe("3.33");
            const exported = await ui.viewer.exports!()
                .find((e) => e.extension === ".xlsx")!
                .produce();
            const back = await readWorkbook(exported as Uint8Array, "xlsx");
            expect(back.value.sheets[0].cells["B2"].f).toBeUndefined();
            expect(back.value.sheets[0].cells["B2"].v).toBe(3.33);

            ui.q<HTMLButtonElement>('[aria-label="Undo"]').click();
            ui.select("B2");
            expect(ui.bar.value).toBe("=ROUND(10/3, 2)");
        } finally {
            ui.dispose();
        }
    });

    test("fx on text starts an empty formula; a second click restores the text", async () => {
        const ui = await setup();
        try {
            ui.select("A2");
            ui.fx.click();
            expect(ui.bar.value).toBe("=");
            expect(ui.browser()).not.toBeNull();
            ui.fx.click();
            expect(ui.browser()).toBeNull();
            expect(ui.bar.value).toBe("Food");
            expect(ui.cell(1, 0).textContent).toBe("Food");
            expect(ui.q<HTMLButtonElement>('[aria-label="Undo"]').disabled).toBe(true);
        } finally {
            ui.dispose();
        }
    });

    test("a formula error becomes its error value", async () => {
        const ui = await setup();
        try {
            ui.select("C1");
            ui.bar.value = "=1/0";
            ui.key(ui.bar, "Enter");
            ui.select("C1");
            ui.fx.click();
            expect(ui.bar.value).toBe("#DIV/0!");
            expect(ui.cell(0, 2).textContent).toBe("#DIV/0!");
        } finally {
            ui.dispose();
        }
    });

    test("Shift+F3 opens the browser; keys browse, the category filters, Escape returns to the formula bar", async () => {
        const ui = await setup();
        try {
            ui.select("C2");
            const grid = ui.cell(1, 2).closest("table")!.parentElement!;
            ui.key(grid, "F3", { shiftKey: true });
            expect(ui.browser()).not.toBeNull();
            expect(ui.bar.value).toBe("=");
            const names = [...FORMULA_FUNCTIONS].sort((a, b) => a.localeCompare(b));
            expect(ui.active()).toBe(names[0]);
            expect(ui.q("[role=listbox]", document).querySelectorAll("[role=option]").length).toBeLessThan(
                names.length,
            );
            ui.key(ui.search(), "ArrowDown");
            expect(ui.active()).toBe(names[1]);
            ui.key(ui.search(), "End", { ctrlKey: true });
            expect(ui.active()).toBe(names.at(-1));
            ui.key(ui.search(), "Home", { ctrlKey: true });
            ui.key(ui.search(), "PageDown");
            expect(names.indexOf(ui.active()!)).toBeGreaterThan(1);

            const category = ui.q<HTMLSelectElement>('[aria-label="Function category"]', document);
            category.value = "Logical";
            category.dispatchEvent(new Event("change"));
            expect(ui.active()).toBe("AND");
            ui.type("if");
            expect(ui.active()).toBe("IF");
            const detail = ui.browser()!.textContent ?? "";
            expect(detail).toContain("IF(logical_test, value_if_true, [value_if_false])");
            expect(detail).toContain('=IF(A1>=50, "Pass", "Fail")');
            expect(detail).toContain("Returned when the condition is TRUE.");

            ui.key(ui.search(), "Escape");
            expect(ui.browser()).toBeNull();
            expect(document.activeElement).toBe(ui.bar);
            expect(ui.bar.value).toBe("=");
        } finally {
            ui.dispose();
        }
    });

    test("Shift+F3 while typing a name searches for it and replaces it on insert", async () => {
        const ui = await setup();
        try {
            ui.select("C2");
            ui.bar.focus();
            ui.bar.value = "=1+vlo";
            ui.bar.setSelectionRange(6, 6);
            ui.key(ui.bar, "F3", { shiftKey: true });
            expect(ui.search().value).toBe("vlo");
            expect(ui.active()).toBe("VLOOKUP");
            const option = document.getElementById(ui.search().getAttribute("aria-activedescendant")!)!;
            option.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            expect(ui.bar.value).toBe("=1+VLOOKUP()");
            expect(ui.bar.selectionStart).toBe(11);
        } finally {
            ui.dispose();
        }
    });

    test("clicking outside closes the browser and drops an empty formula", async () => {
        const ui = await setup();
        try {
            ui.select("A3");
            ui.fx.click();
            expect(ui.bar.value).toBe("=");
            ui.cell(0, 0).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
            expect(ui.browser()).toBeNull();
            expect(ui.cell(2, 0).textContent).toBe("Rent");
        } finally {
            ui.dispose();
        }
    });

    test("the Functions menu offers the browser", async () => {
        const ui = await setup();
        try {
            ui.select("C2");
            ui.q<HTMLButtonElement>('[aria-label="Functions"]').click();
            ui.q<HTMLButtonElement>(
                '[aria-label="More functions…"]',
                document.querySelector('[role="menu"]')!,
            ).click();
            expect(ui.browser()).not.toBeNull();
            expect(ui.bar.value).toBe("=");
        } finally {
            ui.dispose();
        }
    });
});
