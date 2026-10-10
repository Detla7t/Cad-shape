// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument, TestStepNode } from "@chili3d/core/test-utils";
import { TreeModel } from "../src/project/tree/treeModel";

test("a row draws one bar per owner lane, flat where it joins its neighbours and rounded at a strip's ends", () => {
    const document = new TestDocument();
    const node = new TestStepNode(document, "S");
    document.modelManager.addNode(node);
    const row = new TreeModel(document, node);
    globalThis.document.body.append(row);
    try {
        const lanes = () => [...row.mainElement().querySelectorAll<HTMLElement>("i[data-lane]")];
        row.setOwnerBars(
            { lanes: ["#111111", undefined, "#222222"], many: false },
            { up: [true, false, false], down: [false, false, true] },
        );
        expect(row.mainElement().dataset["owners"]).toBe("lanes");
        expect(lanes().map((lane) => lane.dataset["lane"])).toEqual(["0", "2"]);
        expect(lanes().map((lane) => lane.style.left)).toEqual(["1px", "9px"]);
        expect(lanes().map((lane) => lane.dataset["join"])).toEqual(["up", "down"]);
        // a recolour replaces the bars; both joins make a bar flat at both ends
        row.setOwnerBars(
            { lanes: [undefined, "#333333", undefined], many: false },
            { up: [false, true, false], down: [false, true, false] },
        );
        expect(lanes().map((lane) => [lane.dataset["lane"], lane.dataset["join"], lane.style.left])).toEqual([
            ["1", "both", "5px"],
        ]);
        // without joins a bar stands alone
        row.setOwnerBars({ lanes: ["#444444", undefined, undefined], many: false });
        expect(lanes().map((lane) => lane.dataset["join"])).toEqual(["none"]);
        // too many owners: the striped bar, no lanes
        row.setOwnerBars({ lanes: [], many: true });
        expect(row.mainElement().dataset["owners"]).toBe("many");
        expect(lanes()).toHaveLength(0);
        // no owners: nothing
        row.setOwnerBars({ lanes: [], many: false });
        expect(row.mainElement().dataset["owners"]).toBeUndefined();
        expect(lanes()).toHaveLength(0);
    } finally {
        row.remove();
        document.dispose();
    }
});
