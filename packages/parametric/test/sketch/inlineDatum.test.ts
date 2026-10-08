// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { rs } from "@rstest/core";
import { promptDatum } from "../../src/sketch/editor/datumPrompt";

test("inline dimension validates expressions, applies with Enter and cancels without applying", () => {
    const apply = rs.fn((_value: number | string) => {});
    const canceled = rs.fn();
    const close = promptDatum(10, apply, () => Result.ok(undefined), canceled, {
        inlineAt: { x: 200, y: 150 },
        resolve: (value) => (value === "width" ? Result.ok(25) : Result.err("Unknown variable")),
    });
    try {
        const input = document.querySelector<HTMLInputElement>("[aria-label='Dimension value']");
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
        input!.value = "missing";
        input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(apply).not.toHaveBeenCalled();
        expect(document.querySelector("[aria-label='Edit dimension']")?.textContent).toContain(
            "Unknown variable",
        );
        input!.value = "width";
        input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(apply).toHaveBeenCalledWith("width");
        expect(document.querySelector("[aria-label='Edit dimension']")).toBeNull();
        close?.();
        expect(canceled).not.toHaveBeenCalled();
        promptDatum(10, apply, () => Result.ok(undefined), canceled, { inlineAt: { x: 100, y: 100 } });
        const second = document.querySelector<HTMLInputElement>("[aria-label='Dimension value']");
        expect(second).not.toBeNull();
        second!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(apply).toHaveBeenCalledTimes(1);
        expect(canceled).toHaveBeenCalledTimes(1);
        expect(document.querySelector("[aria-label='Edit dimension']")).toBeNull();
    } finally {
        close?.();
    }
});
