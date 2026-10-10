// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { closeElementMenu, showElementMenu } from "../src/elements/elementMenu";

describe("element menu", () => {
    afterEach(() => closeElementMenu());

    test("rows read their text, groups start with a separator, disabled rows do not fire", () => {
        const picked: string[] = [];
        const menu = showElementMenu(
            [
                {
                    label: "command.featurescript.newStudio",
                    text: "Create Feature Studio",
                    onSelect: () => picked.push("fs"),
                },
                {
                    label: "elements.partStudio{0}",
                    text: "Create Part Studio",
                    disabled: true,
                    tooltip: "elements.partStudio.one",
                    separator: true,
                    onSelect: () => picked.push("ps"),
                },
                { label: "command.file.import", text: "Import…", onSelect: () => picked.push("import") },
            ],
            { x: 10, y: 400 },
        );
        const rows = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
        expect(rows.map((row) => row.textContent)).toEqual([
            "Create Feature Studio",
            "Create Part Studio",
            "Import…",
        ]);
        expect(menu.querySelectorAll("[role=separator]")).toHaveLength(1);
        expect(rows[1].title).toBe("elements.partStudio.one");
        rows[1].click();
        expect(picked).toEqual([]);
        expect(menu.isConnected).toBe(true);
        rows[2].click();
        expect(picked).toEqual(["import"]);
        expect(menu.isConnected).toBe(false);
    });
});
