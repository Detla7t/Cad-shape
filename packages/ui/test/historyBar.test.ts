// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { HistoryBar } from "../src/project/historyBar";

afterEach(() => {
    document.body.replaceChildren();
    rs.restoreAllMocks();
});
function fixture() {
    const parent = document.createElement("div"),
        rows = Array.from({ length: 3 }, () => document.createElement("div"));
    parent.append(...rows);
    document.body.append(parent);
    rows.forEach((row, i) =>
        rs.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: i * 30, height: 30 } as DOMRect),
    );
    let position = 3;
    const apply = rs.fn((value: number) => {
            position = value;
        }),
        bar = new HistoryBar(
            () => rows,
            () => position,
            apply,
        );
    bar.refresh();
    return { parent, rows, bar, apply };
}
test("history keyboard navigation preserves focus as the marker moves between features", () => {
    const { bar, rows } = fixture();
    bar.element.focus();
    bar.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(bar.element.nextElementSibling).toBe(rows[2]);
    expect(bar.element.ariaValueNow).toBe("2");
    expect(document.activeElement).toBe(bar.element);
    bar.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(bar.element.nextElementSibling).toBe(rows[0]);
    bar.element.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(bar.element.previousElementSibling).toBe(rows[2]);
    expect(bar.element.ariaValueText).toBe("End of history");
});
test("drag previews a rollback and applies it on release; detached bars stop tracking", () => {
    const { bar, rows, apply } = fixture();
    bar.element.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 35 }));
    expect(bar.element.nextElementSibling).toBe(rows[1]);
    expect(apply).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(apply).toHaveBeenCalledWith(1);
    bar.element.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    bar.dispose();
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 90 }));
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(apply).toHaveBeenCalledTimes(1);
});
