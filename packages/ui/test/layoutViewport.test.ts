// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IView, PubSub, XYZ } from "@chili3d/core";
import { createMockApplication, createMockView, TestDocument } from "@chili3d/core/test-utils";
import { afterEach, expect, rs, test } from "@rstest/core";
import { LayoutViewport } from "../src/viewport/layoutViewport";

let layout: LayoutViewport;
afterEach(() => layout?.remove());

test("split views share a document, preserve the active camera, and close only excess panes", () => {
    const app = createMockApplication();
    const model = new TestDocument();
    const makeView = (name: string) => {
        const view = createMockView({ document: model, name });
        Object.assign(view.cameraController, {
            cameraPosition: new XYZ({ x: 100, y: 100, z: 100 }),
            cameraTarget: XYZ.zero,
            cameraUp: XYZ.unitZ,
            cameraType: "orthographic",
            lookAt: rs.fn(),
        });
        view.close = rs.fn(() => app.views.remove(view));
        app.views.push(view);
        return view;
    };
    model.visual.createView = (name) => makeView(name);
    const first = makeView("3d");
    app.activeView = first;
    layout = new LayoutViewport(app);
    document.body.append(layout);
    layout.setLayout("four");
    expect(app.views.length).toBe(4);
    expect(layout.querySelectorAll('[data-active="true"]')).toHaveLength(1);
    for (const view of app.views.filter((v) => v !== first)) {
        expect(view.document).toBe(model);
        expect(view.cameraController.lookAt).toHaveBeenCalledWith(
            first.cameraController.cameraPosition,
            XYZ.zero,
            XYZ.unitZ,
        );
    }
    const selected = app.views.at(2)!;
    app.activeView = selected;
    PubSub.default.pub("activeViewChanged", selected);
    expect(layout.querySelector('[data-active="true"]')?.getAttribute("aria-label")).toBe(selected.name);
    layout.setLayout("columns");
    expect(app.views.length).toBe(2);
    expect(layout.dataset["layout"]).toBe("columns");
    layout.setLayout("single");
    expect(app.views.length).toBe(1);
    expect(app.views.at(0)).toBe(selected);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(selected.close).not.toHaveBeenCalled();
});

test("switching documents does not display panes from another document", () => {
    const app = createMockApplication();
    const first = createMockView();
    const second = createMockView();
    app.views.push(first, second);
    app.activeView = first;
    layout = new LayoutViewport(app);
    document.body.append(layout);
    app.activeView = second;
    PubSub.default.pub("activeViewChanged", second);
    expect(layout.querySelectorAll('[data-active="true"]')).toHaveLength(1);
    expect([...layout.querySelectorAll("chili-uiview")].map((v) => v.getAttribute("data-active"))).toEqual([
        "false",
        "true",
    ]);
});
