// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type INode, type ISelection, PartStudioTimeline, TIMELINE_GROUPS_KEY } from "@chili3d/core";
import {
    createMockSelection,
    TestDocument,
    TestFeatureListNode,
    TestStepNode,
} from "@chili3d/core/test-utils";

rs.mock("../src/project/nodeContextMenu", () => ({ showNodeContextMenu: () => {} }));
rs.mock("../src/property/featureContextMenu", () => ({
    showFeatureContextMenu: () => {},
    closeFeatureContextMenu: () => {},
}));

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ownershipLanes, TimelineBar } from "../src/project/timeline/partStudioTimelineBar";
import { OWNER_PALETTE } from "../src/project/tree/ownerColors";
import { mustQuery } from "./_helpers/domHelpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The part bars, picking and groups of the timeline (the identity locale: keys are the texts). */

let host: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
    act(() => root.render(node));
}

/** A document whose selection records what the timeline selects and reports it back. */
function documentWithSelection() {
    const selected: INode[][] = [];
    let current: INode[] = [];
    const selection: ISelection = {
        ...createMockSelection(),
        setSelectedNodes: (nodes: INode[]) => {
            current = nodes;
            selected.push(nodes);
            selection.onNodeChanged.emit(nodes);
            return nodes.length;
        },
        getSelectedNodes: () => current,
    };
    const document = new TestDocument({ selection });
    (document.visual as { eventHandler: unknown }).eventHandler = { treeSelection: true };
    return { document, selected };
}

/** S1 shared by A and B; B uses A as a tool; S2 is drawn on A and feeds C. */
function parts() {
    const { document, selected } = documentWithSelection();
    const s1 = new TestStepNode(document, "S1");
    const s2 = new TestStepNode(document, "S2");
    s2.nodeIds = ["A"];
    s2.anchors = { A: 1 };
    const a = new TestFeatureListNode(document, "A", [{ id: "f1", nodeIds: ["S1"] }, { id: "f2" }]);
    const b = new TestFeatureListNode(document, "B", [
        { id: "g1", nodeIds: ["S1"] },
        { id: "g2", nodeIds: ["A"] },
    ]);
    const c = new TestFeatureListNode(document, "C", [{ id: "h1", nodeIds: ["S2"] }]);
    document.modelManager.addNode(s1, a, b, s2, c);
    const timeline = PartStudioTimeline.of(document);
    timeline.refresh();
    return { document, timeline, selected, s1, a, b, c };
}

const steps = () => [...host.querySelectorAll<HTMLElement>("[data-key]")];
const step = (key: string) => mustQuery<HTMLElement>(host, `[data-key="${key}"]`);
const lanesOf = (key: string) => mustQuery<HTMLElement>(step(key), "[data-lanes]");
const marker = () => mustQuery<HTMLElement>(host, '[role="slider"]');
const groupButton = () => mustQuery<HTMLButtonElement>(host, 'button[aria-label="timeline.group"]');
const chip = () => host.querySelector<HTMLElement>("[data-group] > button");
const chipSlot = () => host.querySelector<HTMLElement>("[data-group]");

function mouse(target: HTMLElement, type: string, init: MouseEventInit = {}) {
    act(() => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
}

function key(target: HTMLElement, name: string) {
    act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    });
}

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    rs.restoreAllMocks();
});

describe("part bars", () => {
    test("a part's run is one joined bar; a shared step stacks the other parts above the owner's bar", () => {
        const { document: doc } = parts();
        render(<TimelineBar document={doc} />);
        expect(steps().map((element) => element.dataset["key"])).toEqual([
            "S1",
            "A/f1",
            "A/f2",
            "B/g1",
            "B/g2",
            "S2",
            "C/h1",
        ]);
        // The sketch belongs to the first part reading it and carries the second.
        expect(lanesOf("S1").dataset["lanes"]).toBe("A,B");
        expect(lanesOf("S1").dataset["join"]).toBe("right");
        expect(lanesOf("A/f1").dataset["lanes"]).toBe("A,B,C");
        expect(lanesOf("A/f1").dataset["join"]).toBe("left right");
        expect(lanesOf("A/f2").dataset["lanes"]).toBe("A,B");
        expect(lanesOf("A/f2").dataset["join"]).toBe("left");
        // B's own steps break A's bar: B's colour only, joined with each other.
        expect(lanesOf("B/g1").dataset["lanes"]).toBe("B");
        expect(lanesOf("B/g1").dataset["join"]).toBe("right");
        expect(lanesOf("B/g2").dataset["join"]).toBe("left");
        expect(lanesOf("S2").dataset["lanes"]).toBe("C");
        expect(lanesOf("C/h1").dataset["join"]).toBe("left");
        // Three bars: the owner's thicker one lowest, one per other part above it.
        const bars = [...lanesOf("A/f1").children].map((bar) => (bar as HTMLElement).style.background);
        expect(bars).toHaveLength(3);
        expect(new Set(bars).size).toBe(3);
        expect(lanesOf("A/f1").dataset["shared"]).toBeUndefined();
        // Every part has its own colour, the first one blue; a step no part reads has no bar.
        expect(bars[0]).toBe("#3a86e8");
        expect(step("A/f1").title).toContain("timeline.partOfA");
        expect(step("A/f1").title).toContain("timeline.usedByB, C");
    });

    test("more than three parts on a step make the cross-hatched bar, which lists them on a click", () => {
        const { document: doc, selected } = documentWithSelection();
        const s1 = new TestStepNode(doc, "S1");
        const bodies = ["A", "B", "C", "D"].map(
            (name) => new TestFeatureListNode(doc, name, [{ id: "f", nodeIds: ["S1"] }]),
        );
        doc.modelManager.addNode(s1, ...bodies);
        PartStudioTimeline.of(doc).refresh();
        render(<TimelineBar document={doc} />);
        const lanes = lanesOf("S1");
        expect(lanes.dataset["shared"]).toBe("4");
        expect(lanes.children).toHaveLength(0);
        expect(lanesOf("A/f").dataset["shared"]).toBeUndefined();

        mouse(lanes, "click", { clientX: 40, clientY: 20 });
        const dialog = mustQuery<HTMLElement>(host, '[role="dialog"]');
        const names = [...dialog.querySelectorAll("button")].map((button) => button.textContent);
        expect(names).toEqual(["A", "B", "C", "D"]);
        // The click opened the list instead of picking the step.
        expect(selected).toEqual([]);
        mouse(dialog.querySelectorAll("button")[2], "click");
        expect(selected).toEqual([[bodies[2]]]);
        expect(host.querySelector('[role="dialog"]')).toBeNull();
    });
});

describe("picking and groups", () => {
    test("click, Ctrl and Shift pick steps and select their nodes; the picked steps group into a chip", () => {
        const { document: doc, timeline, selected, a, b } = parts();
        render(<TimelineBar document={doc} />);
        expect(groupButton().disabled).toBe(true);

        mouse(step("A/f1"), "click");
        expect(step("A/f1").dataset["picked"]).toBe("true");
        expect(selected.at(-1)).toEqual([a]);
        mouse(step("B/g1"), "click", { shiftKey: true });
        expect(steps().map((element) => element.dataset["picked"] ?? "")).toEqual([
            "",
            "true",
            "true",
            "true",
            "",
            "",
            "",
        ]);
        expect(selected.at(-1)).toEqual([a, b]);
        mouse(step("A/f2"), "click", { ctrlKey: true });
        expect(step("A/f2").dataset["picked"]).toBeUndefined();
        expect(selected.at(-1)).toEqual([a, b]);
        expect(groupButton().disabled).toBe(false);

        mouse(groupButton(), "click");
        const group = timeline.groups[0];
        expect(group.keys).toEqual(["A/f1", "A/f2", "B/g1"]);
        expect(doc.userData?.[TIMELINE_GROUPS_KEY]).toHaveLength(1);
        // Collapsed: one chip stands for the three steps, which are gone from the track.
        expect(chip()?.getAttribute("aria-expanded")).toBe("false");
        expect(chipSlot()?.dataset["span"]).toBe("3");
        expect(chip()?.textContent).toContain("timeline.groupName1");
        expect(steps().map((element) => element.dataset["key"])).toEqual(["S1", "B/g2", "S2", "C/h1"]);
        expect(groupButton().disabled).toBe(true);

        // Open: the chip heads its steps, bracketed.
        mouse(chip()!, "click");
        expect(timeline.groups[0].collapsed).toBe(false);
        expect(chip()?.getAttribute("aria-expanded")).toBe("true");
        expect(chipSlot()?.dataset["span"]).toBe("0");
        expect(steps().map((element) => element.dataset["grouped"] ?? "")).toEqual([
            "",
            "start",
            "middle",
            "end",
            "",
            "",
            "",
        ]);
        expect(chipSlot()?.nextElementSibling).toBe(step("A/f1"));
    });

    test("a chip renames on a double-click and its menu ungroups; the marker inside a collapsed group opens it", () => {
        const { document: doc, timeline } = parts();
        render(<TimelineBar document={doc} />);
        act(() => {
            timeline.group(["A/f1", "B/g1"], "Base");
        });
        mouse(chip()!, "dblclick");
        const input = mustQuery<HTMLInputElement>(host, 'input[aria-label="timeline.renameGroup"]');
        expect(input.value).toBe("Base");
        input.value = "Core";
        key(input, "Enter");
        expect(timeline.groups[0].name).toBe("Core");
        expect(chip()?.textContent).toContain("Core");

        // The marker between the group's steps: the group shows them.
        act(() => {
            timeline.rollTo(3);
        });
        expect(chip()?.getAttribute("aria-expanded")).toBe("true");
        expect(marker().previousElementSibling).toBe(step("A/f2"));
        expect(marker().nextElementSibling).toBe(step("B/g1"));
        act(() => {
            timeline.end();
        });
        expect(chip()?.getAttribute("aria-expanded")).toBe("false");

        mouse(chip()!, "contextmenu", { clientX: 10, clientY: 12 });
        const menu = mustQuery<HTMLElement>(host, '[role="menu"][aria-label="Core"]');
        const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        expect(items.map((item) => item.textContent)).toEqual([
            "timeline.expand",
            "timeline.renameGroup",
            "timeline.ungroup",
        ]);
        mouse(items[2], "click");
        expect(timeline.groups).toEqual([]);
        expect(chip()).toBeNull();
        expect(steps()).toHaveLength(7);
        doc.history.undo();
        expect(timeline.groups).toHaveLength(1);
    });

    test("dragging the marker over a collapsed group counts all of its steps", () => {
        const { document: doc, timeline } = parts();
        render(<TimelineBar document={doc} />);
        act(() => {
            timeline.group(["A/f1", "B/g1"]);
        });
        const elements = [...host.querySelectorAll<HTMLElement>("[data-span]")];
        expect(elements.map((element) => element.dataset["span"])).toEqual(["1", "3", "1", "1", "1"]);
        for (const [i, element] of elements.entries()) {
            rs.spyOn(element, "getBoundingClientRect").mockReturnValue({
                left: i * 30,
                width: 30,
                top: 0,
                height: 26,
            } as DOMRect);
        }
        act(() => {
            marker().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        });
        act(() => {
            window.dispatchEvent(new PointerEvent("pointermove", { clientX: 50 }));
        });
        // Past the chip's centre: the three grouped steps count.
        expect(marker().getAttribute("aria-valuenow")).toBe("4");
        act(() => {
            window.dispatchEvent(new PointerEvent("pointerup"));
        });
        expect(timeline.position).toBe(4);
    });
});

describe("tree colours on the timeline", () => {
    test("steps take the owner colours the Features tree draws, in the tree's palette", () => {
        const { document: doc, timeline, s1, a, b } = parts();
        // The tree's ownership: S1 owns itself; A and B read it (B reads A too).
        const ownership = {
            owners: [s1, a, b],
            ownersOf: new Map([
                [s1.id, [0, 1, 2]],
                [a.id, [1, 2]],
                [b.id, [2]],
            ]),
        };
        const lanes = ownershipLanes(ownership, timeline.entries)!;
        expect(lanes.colors.get(s1)).toBe(OWNER_PALETTE[0]);
        expect(lanes.colors.get(a)).toBe(OWNER_PALETTE[1]);
        expect(lanes.lanes[0]).toEqual({ owner: s1, users: [a, b] });
        expect(lanes.lanes[1]).toEqual({ owner: a, users: [b] });
        expect(lanes.lanes[3]).toEqual({ owner: b, users: [] });
        // Nothing owned (the tree's colouring off): the timeline uses its own lanes.
        expect(ownershipLanes({ owners: [], ownersOf: new Map() }, timeline.entries)).toBeUndefined();
        expect(doc).toBeDefined();
    });
});
