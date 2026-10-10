// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    type FeatureItem,
    type IApplication,
    type INode,
    type ISelection,
    type IView,
    Observable,
    PartStudioTimeline,
    PubSub,
} from "@chili3d/core";
import {
    createMockSelection,
    TestDocument,
    TestFeatureListNode,
    TestStepNode,
} from "@chili3d/core/test-utils";

const menus = rs.hoisted(() => ({
    node: [] as [node: unknown, x: number, y: number][],
    feature: [] as [document: unknown, node: unknown, item: unknown, anchor: unknown][],
}));
rs.mock("../src/project/nodeContextMenu", () => ({
    showNodeContextMenu: (node: unknown, x: number, y: number) => menus.node.push([node, x, y]),
}));
rs.mock("../src/property/featureContextMenu", () => ({
    showFeatureContextMenu: (document: unknown, node: unknown, item: unknown, anchor: unknown) =>
        menus.feature.push([document, node, item, anchor]),
    closeFeatureContextMenu: () => {},
}));

import { ApplicationProvider } from "@chili3d/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PartStudioTimelineBar, TimelineBar } from "../src/project/timeline/partStudioTimelineBar";
import { mustQuery } from "./_helpers/domHelpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
    act(() => root.render(node));
}

/** S1, Body(f1 ← S1, f2 ← S2), S2 — the timeline orders it S1, f1, S2, f2. */
function fixture(options: { error?: string } = {}) {
    const selected: INode[][] = [];
    const selection: ISelection = {
        ...createMockSelection(),
        setSelectedNodes: (nodes: INode[]) => {
            selected.push(nodes);
            return nodes.length;
        },
    };
    const document = new TestDocument({ selection });
    (document.visual as { eventHandler: unknown }).eventHandler = { treeSelection: true };
    const s1 = new TestStepNode(document, "S1");
    const s2 = new TestStepNode(document, "S2");
    const body = new TestFeatureListNode(document, "B", [
        { id: "f1", nodeIds: ["S1"], icon: "icon-prism" },
        { id: "f2", nodeIds: ["S2"], icon: "icon-fillet", error: options.error },
    ]);
    document.modelManager.addNode(s1, body, s2);
    const timeline = PartStudioTimeline.of(document);
    timeline.refresh();
    return { document, s1, s2, body, timeline, selected };
}

const steps = () => [...host.querySelectorAll<HTMLElement>("[data-key]")];
const step = (key: string) => mustQuery<HTMLElement>(host, `[data-key="${key}"]`);
const marker = () => mustQuery<HTMLElement>(host, '[role="slider"]');
const playButton = () => mustQuery<HTMLButtonElement>(host, "button[aria-pressed]:not([data-key])");

function key(target: HTMLElement, name: string) {
    act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    });
}

function mouse(target: HTMLElement, type: string, init: MouseEventInit = {}) {
    act(() => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
}

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    menus.node.length = 0;
    menus.feature.length = 0;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    rs.useRealTimers();
    rs.restoreAllMocks();
});

describe("TimelineBar", () => {
    test("renders the steps in application order with the marker at the end", () => {
        const { document: doc } = fixture();
        render(<TimelineBar document={doc} />);
        expect(steps().map((element) => element.dataset["key"])).toEqual(["S1", "B/f1", "S2", "B/f2"]);
        expect(marker().getAttribute("aria-valuenow")).toBe("4");
        expect(marker().getAttribute("aria-valuemax")).toBe("4");
        expect(marker().previousElementSibling).toBe(step("B/f2"));
        expect(steps().every((element) => element.dataset["future"] === "false")).toBe(true);
        // Each step draws the tree's type icon.
        expect(step("B/f1").querySelector("svg")).not.toBeNull();
    });

    test("a roll from another view greys the future and moves the marker", () => {
        const { document: doc, timeline } = fixture();
        render(<TimelineBar document={doc} />);
        act(() => {
            timeline.rollTo(2);
        });
        expect(steps().map((element) => element.dataset["future"])).toEqual([
            "false",
            "false",
            "true",
            "true",
        ]);
        expect(marker().nextElementSibling).toBe(step("S2"));
        expect(marker().getAttribute("aria-valuenow")).toBe("2");
    });

    test("the marker moves with the arrow keys, Home and End, and keeps focus", () => {
        const { document: doc, timeline } = fixture();
        render(<TimelineBar document={doc} />);
        act(() => marker().focus());
        key(marker(), "ArrowLeft");
        expect(timeline.position).toBe(3);
        expect(document.activeElement).toBe(marker());
        key(marker(), "Home");
        expect(timeline.position).toBe(0);
        expect(marker().nextElementSibling).toBe(step("S1"));
        key(marker(), "ArrowRight");
        expect(timeline.position).toBe(1);
        key(marker(), "End");
        expect(timeline.position).toBe(4);
        key(marker(), "ArrowRight");
        expect(timeline.position).toBe(4);
        expect(marker().getAttribute("aria-valuenow")).toBe("4");
        expect(document.activeElement).toBe(marker());
    });

    test("dragging the marker previews the position between steps and applies it on release", () => {
        const { document: doc, timeline } = fixture();
        render(<TimelineBar document={doc} />);
        for (const [i, element] of steps().entries()) {
            rs.spyOn(element, "getBoundingClientRect").mockReturnValue({
                left: i * 26,
                width: 26,
                top: 0,
                height: 26,
            } as DOMRect);
        }
        act(() => {
            marker().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        });
        act(() => {
            window.dispatchEvent(new PointerEvent("pointermove", { clientX: 30 }));
        });
        // Past the first step's centre only: the preview sits after it, nothing applied yet.
        expect(marker().getAttribute("aria-valuenow")).toBe("1");
        expect(step("B/f1").dataset["future"]).toBe("true");
        expect(timeline.position).toBe(4);
        act(() => {
            window.dispatchEvent(new PointerEvent("pointerup"));
        });
        expect(timeline.position).toBe(1);
        expect(marker().nextElementSibling).toBe(step("B/f1"));
    });

    test("click selects, double-click opens and right-click shows the tree's menus", () => {
        const { document: doc, s1, body, selected } = fixture();
        const published: unknown[][] = [];
        rs.spyOn(PubSub.default, "pub").mockImplementation(((...args: unknown[]) => {
            published.push(args);
        }) as typeof PubSub.default.pub);
        render(<TimelineBar document={doc} />);

        mouse(step("B/f1"), "click");
        expect(selected).toEqual([[body]]);
        // Ctrl adds the step: the selection holds both steps' nodes.
        mouse(step("S1"), "click", { ctrlKey: true });
        expect(selected.at(-1)).toEqual([body, s1]);

        mouse(step("B/f2"), "dblclick");
        mouse(step("S1"), "dblclick");
        expect(published).toEqual([
            ["editFeature", body, "f2"],
            ["nodeDoubleClicked", s1],
        ]);

        mouse(step("B/f1"), "contextmenu", { clientX: 30, clientY: 40 });
        mouse(step("S1"), "contextmenu", { clientX: 5, clientY: 6 });
        expect(menus.feature).toHaveLength(1);
        const [menuDocument, menuNode, item, anchor] = menus.feature[0];
        expect(menuDocument).toBe(doc);
        expect(menuNode).toBe(body);
        expect((item as FeatureItem).id).toBe("f1");
        expect(anchor).toEqual({ x: 30, y: 40 });
        expect(menus.node).toEqual([[s1, 5, 6]]);
    });

    test("play steps from the start to the end and stop pauses it", () => {
        rs.useFakeTimers();
        const { document: doc, timeline } = fixture();
        render(<TimelineBar document={doc} playInterval={100} />);
        mouse(playButton(), "click");
        expect(timeline.position).toBe(0);
        expect(playButton().getAttribute("aria-pressed")).toBe("true");
        act(() => {
            rs.advanceTimersByTime(100);
        });
        expect(timeline.position).toBe(1);
        mouse(playButton(), "click");
        expect(playButton().getAttribute("aria-pressed")).toBe("false");
        act(() => {
            rs.advanceTimersByTime(1000);
        });
        expect(timeline.position).toBe(1);

        mouse(playButton(), "click");
        act(() => {
            rs.advanceTimersByTime(1000);
        });
        expect(timeline.position).toBe(4);
        expect(playButton().getAttribute("aria-pressed")).toBe("false");
    });

    test("a failed feature carries the shared evaluation indicator", () => {
        const { document: doc } = fixture({ error: "Fillet radius too large" });
        render(<TimelineBar document={doc} />);
        expect(step("B/f2").querySelector('[data-evaluation="failed"]')).not.toBeNull();
        expect(step("B/f1").querySelector("[data-evaluation]")).toBeNull();
    });
});

class TestApplication extends Observable {
    constructor(private readonly view: IView) {
        super();
    }
    get activeView(): IView {
        return this.view;
    }
}

describe("PartStudioTimelineBar", () => {
    test("the gear's Show timeline entry hides the bar through the saved preference", () => {
        const previous = Config.instance.preferences;
        const save = rs.spyOn(Config.instance, "saveToStorage").mockImplementation(() => {});
        try {
            Config.instance.preferences = { ...previous, showTimeline: true };
            const { document: doc } = fixture();
            const application = new TestApplication({
                document: doc,
            } as unknown as IView) as unknown as IApplication;
            render(
                <ApplicationProvider application={application}>
                    <PartStudioTimelineBar />
                </ApplicationProvider>,
            );
            expect(host.querySelector('[role="toolbar"]')).not.toBeNull();
            mouse(mustQuery(host, '[aria-haspopup="menu"]'), "click");
            const show = mustQuery(host, '[role="menuitemcheckbox"]');
            expect(show.getAttribute("aria-checked")).toBe("true");
            mouse(show, "click");
            expect(Config.instance.preferences.showTimeline).toBe(false);
            expect(save).toHaveBeenCalled();
            expect(host.querySelector('[role="toolbar"]')).toBeNull();
        } finally {
            Config.instance.preferences = previous;
        }
    });
});
