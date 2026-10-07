// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentElements, isVariableStudioNode } from "@chili3d/core";
import { DataSourceNode, DataSourceView } from "../src";
import { csvSource, newDoc, useNodeSqlJs } from "./_helpers";

beforeAll(() => useNodeSqlJs());

const texts = (elements: Iterable<Element>) => [...elements].map((element) => element.textContent ?? "");

/** Waits for the async re-read a settings change starts. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the Data Source tab", () => {
    test("is the element view of a Data Source node", () => {
        const doc = newDoc();
        const source = new DataSourceNode({ document: doc, name: "Empty" });
        doc.modelManager.addNode(source);
        expect(DocumentElements.kindOf(source)?.kind).toBe("dataSource");
        const view = DocumentElements.createView(source, doc);
        expect(view).toBeInstanceOf(DataSourceView);
        expect(view?.element.textContent).toContain("data.noTables");
        view?.dispose();
    });

    test("shows the table on its A1 grid; a clicked cell gives the expression that reads it", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", "Name,Value\nDepth,10\nAngle,30 deg");
        const view = new DataSourceView(source, doc);
        try {
            const grid = view.element.querySelector("table");
            expect(grid).not.toBeNull();
            expect(texts(grid?.querySelectorAll("thead th") ?? [])).toEqual(["", "A", "B"]);
            const rows = [...(grid?.querySelectorAll("tbody tr") ?? [])];
            expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual(["1", "2", "3"]);
            // The header row names each column and its type (keys: tests run on an identity locale);
            // a plain number beside an angle is an angle, as a literal would be.
            expect(texts(rows[0].querySelectorAll("td"))).toEqual([
                "Namedata.type.text",
                "Valuedata.type.angle",
            ]);
            expect(texts(rows[1].querySelectorAll("td"))).toEqual(["Depth", "10"]);

            (rows[2].querySelectorAll("td")[1] as HTMLElement).click();
            expect(view.element.textContent).toContain('data("Dims", "Value", 2)');
            expect(view.element.textContent).toContain('data("Dims", "B3")');

            await source.apply({ fileText: "Name,Value\nDepth,99" });
            expect(view.element.querySelector("tbody")?.textContent).toContain("99");
        } finally {
            view.dispose();
        }
    });

    test("the settings follow the kind; Import as variables makes a linked studio", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Params", "Name,Value\nw,40");
        const view = new DataSourceView(source, doc);
        try {
            const importButton = [...view.element.querySelectorAll("button")].find(
                (button) => button.textContent === "data.importVariables",
            );
            expect(importButton).toBeDefined();
            importButton?.click();
            const studios = doc.modelManager.findNodes(isVariableStudioNode);
            expect(studios).toHaveLength(1);
            expect(doc.variables.evaluate().scope.get("w")?.value).toBe(40);

            const kind = view.element.querySelector("select") as HTMLSelectElement;
            kind.value = "http";
            kind.dispatchEvent(new Event("change"));
            await settle();
            expect(source.definition.kind).toBe("http");
            const placeholders = [...view.element.querySelectorAll("input")].map(
                (input) => input.placeholder,
            );
            expect(placeholders).toContain("https://");
        } finally {
            view.dispose();
        }
    });
});
