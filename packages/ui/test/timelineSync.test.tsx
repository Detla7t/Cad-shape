// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFeatureListNode, type INode, PartStudioTimeline } from "@chili3d/core";
import { TestDocument, TestFeatureListNode, TestStepNode } from "@chili3d/core/test-utils";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TimelineBar } from "../src/project/timeline/partStudioTimelineBar";
import { FeatureListProperty } from "../src/property/featureListProperty";
import { mustQuery } from "./_helpers/domHelpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The vertical feature-list bar and the horizontal timeline are views of one marker. */

let host: HTMLDivElement;
let root: Root;

function fixture() {
    const doc = new TestDocument();
    const s1 = new TestStepNode(doc, "S1");
    const s2 = new TestStepNode(doc, "S2");
    const body = new TestFeatureListNode(doc, "B", [
        { id: "f1", nodeIds: ["S1"] },
        { id: "f2", nodeIds: ["S2"] },
    ]);
    doc.modelManager.addNode(s1, body, s2);
    const timeline = PartStudioTimeline.of(doc);
    timeline.refresh();
    act(() => root.render(<TimelineBar document={doc} />));
    return { doc, body, timeline };
}

const horizontalMarker = () => mustQuery<HTMLElement>(host, '[role="slider"]');

function press(target: HTMLElement, key: string) {
    act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
}

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
});

test("the feature list's bar and the timeline move together", () => {
    const { doc, body, timeline } = fixture();
    const list = new FeatureListProperty(doc, body as unknown as INode & IFeatureListNode);
    document.body.append(list);
    const bar = mustQuery<HTMLElement>(list, '[role="slider"]');
    expect(bar.ariaValueNow).toBe("2");

    // Up in the body's list: before its second feature — the timeline marker follows.
    press(bar, "ArrowUp");
    expect(timeline.position).toBe(3);
    expect(body.rollbackIndex).toBe(1);
    expect(horizontalMarker().getAttribute("aria-valuenow")).toBe("3");

    // The timeline rolls before the body: the list's bar follows to its top.
    press(horizontalMarker(), "Home");
    expect(timeline.position).toBe(0);
    expect(mustQuery<HTMLElement>(list, '[role="slider"]').ariaValueNow).toBe("0");

    press(horizontalMarker(), "End");
    expect(mustQuery<HTMLElement>(list, '[role="slider"]').ariaValueNow).toBe("2");
});
