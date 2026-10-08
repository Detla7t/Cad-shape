// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createEditableTitle } from "../src/editableTitle";

test("the pencil edits inline; Enter saves and Escape only cancels the name edit", () => {
    let name = "Sketch 1";
    let bubbled = 0;
    const title = createEditableTitle(
        () => name,
        (value) => {
            name = value;
        },
    );
    document.body.append(title.element);
    title.element.addEventListener("keydown", () => bubbled++);
    const pencil = title.element.querySelector<HTMLButtonElement>("button");
    const input = title.element.querySelector<HTMLInputElement>("input");
    expect(pencil).not.toBeNull();
    expect(input).not.toBeNull();
    try {
        pencil!.click();
        expect(input!.hidden).toBe(false);
        expect(input!.value).toBe("Sketch 1");
        input!.value = " End Cap ";
        input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(name).toBe("End Cap");
        expect(title.element.querySelector("strong")?.textContent).toBe("End Cap");
        pencil!.click();
        input!.value = "Discard";
        input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(name).toBe("End Cap");
        expect(input!.hidden).toBe(true);
        expect(bubbled).toBe(0);
        pencil!.click();
        input!.value = " ";
        title.commit();
        expect(name).toBe("End Cap");
    } finally {
        title.element.remove();
    }
});
