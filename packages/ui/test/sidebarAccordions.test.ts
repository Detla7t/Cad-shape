// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { SidebarAccordions } from "../src/project/sidebarAccordions";

const key = "test.sidebar.layout";
function panel() {
    return new SidebarAccordions(
        ["Configurations", "Features", "Parts"].map((title, i) => ({
            id: title.toLowerCase(),
            title,
            content: document.createElement("div"),
            weight: [0.2, 0.5, 0.3][i],
        })),
        key,
    );
}
afterEach(() => {
    localStorage.removeItem(key);
    document.body.replaceChildren();
    rs.restoreAllMocks();
});

test("collapsing one section preserves the other sections and restores its expanded size preference", () => {
    const view = panel();
    document.body.append(view);
    const section = view.sections[0];
    const expanded = section.element.style.flex;
    section.toggle.click();
    expect(section.content.hidden).toBe(true);
    expect(section.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.sections.slice(1).map((s) => s.content.hidden)).toEqual([false, false]);
    expect(view.sections.slice(1).reduce((sum, s) => sum + Number(s.element.style.flexGrow), 0)).toBeCloseTo(
        1,
    );
    const restored = panel();
    expect(restored.sections[0].content.hidden).toBe(true);
    restored.sections[0].toggle.click();
    expect(restored.sections[0].element.style.flex).toBe(expanded);
});

test("divider drag resizes adjacent sections, clamps at minimums, and remembers the result", () => {
    const view = panel();
    document.body.append(view);
    [180, 360, 200].forEach((height, i) => {
        rs.spyOn(view.sections[i].element, "getBoundingClientRect").mockReturnValue({ height } as DOMRect);
    });
    const dividers = view.querySelectorAll<HTMLElement>('[role="separator"]');
    expect(dividers).toHaveLength(2);
    dividers[0].dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1, clientY: 180 }));
    expect(document.activeElement).toBe(dividers[0]);
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 250 }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientY: 250 }));
    expect(view.sections[0].weight).toBeGreaterThan(0.2);
    expect(view.sections[1].weight).toBeLessThan(0.5);
    expect(view.sections[2].weight).toBe(0.3);
    expect(panel().sections.map((s) => s.weight)).toEqual(view.sections.map((s) => s.weight));
    dividers[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(view.sections[0].weight).toBeGreaterThan(0);
    expect(view.sections[0].weight).toBeLessThan(0.01);
    expect(view.sections[0].element.style.minHeight).toBe("64px");
});

test("keyboard resizing skips a collapsed middle section and detached panels stop pointer tracking", () => {
    const view = panel();
    document.body.append(view);
    [224, 28, 304].forEach((height, i) => {
        rs.spyOn(view.sections[i].element, "getBoundingClientRect").mockReturnValue({ height } as DOMRect);
    });
    view.sections[1].toggle.click();
    const divider = view.querySelector<HTMLElement>('[role="separator"]');
    expect(divider).not.toBeNull();
    divider!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(view.sections[0].weight).toBeGreaterThan(0.2);
    expect(view.sections[1].content.hidden).toBe(true);
    divider!.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, clientY: 180 }));
    view.remove();
    const sizes = view.sections.map((s) => s.weight);
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 400 }));
    expect(view.sections.map((s) => s.weight)).toEqual(sizes);
});
