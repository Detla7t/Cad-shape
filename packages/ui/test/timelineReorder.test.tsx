// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ComponentContext,
    ComponentFolderNode,
    type INode,
    type ISelection,
    PartStudioTimeline,
    PubSub,
} from "@chili3d/core";
import {
    createMockSelection,
    TestDocument,
    TestFeatureListNode,
    TestStepNode,
} from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";

rs.mock("../src/project/nodeContextMenu", () => ({ showNodeContextMenu: () => {} }));
rs.mock("../src/property/featureContextMenu", () => ({
    showFeatureContextMenu: () => {},
    closeFeatureContextMenu: () => {},
}));

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type DragState, dragShift, TimelineBar } from "../src/project/timeline/partStudioTimelineBar";
import { mustQuery } from "./_helpers/domHelpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Dragging steps, the rail's group expanders and the active component on the timeline. */

let host: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
    act(() => root.render(node));
}

/** S1, B(f1 ← S1, f2), S2 (free), C(g1) inside a "Sub" folder. */
function fixture() {
    const selection: ISelection = {
        ...createMockSelection(),
        setSelectedNodes: (nodes: INode[]) => nodes.length,
    };
    const document = new TestDocument({ selection });
    (document.visual as { eventHandler: unknown }).eventHandler = { treeSelection: true };
    const s1 = new TestStepNode(document, "S1");
    const s2 = new TestStepNode(document, "S2");
    const b = new TestFeatureListNode(document, "B", [{ id: "f1", nodeIds: ["S1"] }, { id: "f2" }]);
    const sub = new ComponentFolderNode({ document, name: "Sub" });
    const c = new TestFeatureListNode(document, "C", [{ id: "g1" }]);
    sub.add(c);
    document.modelManager.addNode(s1, b, s2, sub);
    const timeline = PartStudioTimeline.of(document);
    timeline.refresh();
    render(<TimelineBar document={document} />);
    return { document, timeline, s2, b, sub };
}

const keys = () => [...host.querySelectorAll<HTMLElement>("[data-key]")].map((el) => el.dataset["key"]);
const step = (key: string) => mustQuery<HTMLElement>(host, `[data-key="${key}"]`);
const slots = () => [...host.querySelectorAll<HTMLElement>("[data-slot]")];

/** Lays the track out as 30px items in a row, so pointer x maps to slots. */
function layout() {
    for (const [i, element] of slots().entries()) {
        rs.spyOn(element, "getBoundingClientRect").mockReturnValue({
            left: i * 30,
            width: 28,
            top: 0,
            height: 26,
            right: i * 30 + 28,
            bottom: 26,
        } as DOMRect);
    }
}

function pointer(target: EventTarget, type: string, init: PointerEventInit = {}) {
    act(() => {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
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

test("dragShift moves the block with the pointer and slides the others aside", () => {
    const drag: DragState = { keys: ["x"], from: 1, count: 1, to: 3, dx: 70, width: 30 };
    // Slot 1 is dragged; slots 2 and 3 (rest 1 and 2) slide left to make room at rest 3.
    expect([0, 1, 2, 3, 4].map((slot) => dragShift(drag, slot))).toEqual([0, 70, -30, -30, 0]);
    const back: DragState = { keys: ["x"], from: 3, count: 1, to: 1, dx: -70, width: 30 };
    expect([0, 1, 2, 3, 4].map((slot) => dragShift(back, slot))).toEqual([0, 30, 30, -70, 0]);
    expect(dragShift(undefined, 2)).toBe(0);
});

test("dragging a step past others reorders the document on release; a refused drop reports why", () => {
    const { timeline, b } = fixture();
    expect(keys()).toEqual(["S1", "B/f1", "B/f2", "S2", "C/g1"]);
    layout();
    // f2 (slot 2) dragged left over f1: it shifts f1 aside, lands before it.
    pointer(step("B/f2"), "pointerdown", { clientX: 74 });
    pointer(window, "pointermove", { clientX: 60 });
    pointer(window, "pointermove", { clientX: 40 });
    expect(step("B/f1").style.transform).toBe("translateX(30px)");
    expect(step("B/f2").style.transform).toBe("translateX(-34px)");
    pointer(window, "pointerup", { clientX: 40 });
    expect(b.features.map((feature) => feature.id)).toEqual(["f2", "f1"]);
    expect(keys()).toEqual(["S1", "B/f2", "B/f1", "S2", "C/g1"]);
    expect(step("B/f1").style.transform).toBe("");

    // f1 reads S1: dropping it before S1 is refused and reported.
    const errors: unknown[][] = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation(((...args: unknown[]) => {
        errors.push(args);
    }) as typeof PubSub.default.pub);
    layout();
    pointer(step("B/f1"), "pointerdown", { clientX: 74 });
    pointer(window, "pointermove", { clientX: 5 });
    pointer(window, "pointerup", { clientX: 5 });
    expect(errors).toEqual([["displayError", "timeline.reorderRefused"]]);
    expect(timeline.entries.map((entry) => entry.key)).toEqual(["S1", "B/f2", "B/f1", "S2", "C/g1"]);
});

test("a short press is a click, not a drag", () => {
    const { document: doc } = fixture();
    const selected: INode[][] = [];
    rs.spyOn(doc.selection, "setSelectedNodes").mockImplementation((nodes) => {
        selected.push(nodes);
        return nodes.length;
    });
    layout();
    pointer(step("S2"), "pointerdown", { clientX: 100 });
    pointer(window, "pointermove", { clientX: 101 });
    pointer(window, "pointerup", { clientX: 101 });
    act(() => step("S2").click());
    expect(selected).toHaveLength(1);
    expect(keys()).toEqual(["S1", "B/f1", "B/f2", "S2", "C/g1"]);
});

test("the +/− on the rail opens and closes a group; dragging the head moves the whole group", () => {
    const { timeline, b } = fixture();
    act(() => {
        timeline.group(["S2", "C/g1"], "Tail");
    });
    const toggle = () => mustQuery<HTMLButtonElement>(host, "[data-group] button[aria-label]:last-child");
    expect(toggle().textContent).toBe("+");
    expect(keys()).toEqual(["S1", "B/f1", "B/f2"]);
    act(() => toggle().click());
    expect(toggle().textContent).toBe("−");
    expect(keys()).toEqual(["S1", "B/f1", "B/f2", "S2", "C/g1"]);
    expect(mustQuery<HTMLElement>(host, "[data-group]").dataset["span"]).toBe("0");

    // Drag the open group's head before the body: S2 and C/g1 (with its folder) move together.
    layout();
    const head = mustQuery<HTMLElement>(host, "[data-group] button");
    pointer(head, "pointerdown", { clientX: 104 });
    pointer(window, "pointermove", { clientX: 60 });
    pointer(window, "pointermove", { clientX: 30 });
    pointer(window, "pointerup", { clientX: 30 });
    expect(timeline.entries.map((entry) => entry.key)).toEqual(["S1", "S2", "C/g1", "B/f1", "B/f2"]);
    expect(b.features.map((feature) => feature.id)).toEqual(["f1", "f2"]);
    expect(timeline.groups[0].keys).toEqual(["S2", "C/g1"]);
    // Between two features of one body is no place for a stranger nothing reads.
    expect(timeline.canMove(["S2"], 3)).toBe(false);
});

test("an active component shows only its steps, with a way back to the parent", () => {
    const { document: doc, sub } = fixture();
    expect(host.querySelector('button[aria-label^="timeline.backToParent"]')).toBeNull();
    act(() => {
        ComponentContext.activate(doc, sub);
    });
    expect(keys()).toEqual(["C/g1"]);
    expect(host.textContent).toContain("Sub");
    const back = mustQuery<HTMLButtonElement>(host, 'button[aria-label^="timeline.backToParent"]');
    expect(back.getAttribute("aria-label")).toBe(`timeline.backToParent${doc.modelManager.rootNode.name}`);
    act(() => back.click());
    expect(ComponentContext.activeOf(doc)).toBeUndefined();
    expect(doc.modelManager.currentNode).toBeUndefined();
    expect(keys()).toEqual(["S1", "B/f1", "B/f2", "S2", "C/g1"]);
});
