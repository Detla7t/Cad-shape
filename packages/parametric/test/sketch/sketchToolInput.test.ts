// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IView } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { sketchToolInput } from "../../src/sketch/commands/sketchToolInput";

afterEach(() => document.body.replaceChildren());
test("sketch tool fields show document units and resolve typed quantities to model units", async () => {
    const model = new TestDocument();
    model.userData = { displayUnits: { length: "in", angle: "rad", lengthPrecision: 3, anglePrecision: 3 } };
    const pending = sketchToolInput({ document: model, dom: document.body } as IView, "Offset", {
        "Offset (mm)": 25.4,
        "Rotation (deg)": 180,
        Instances: 3,
    });
    const length = document.querySelector<HTMLInputElement>('[aria-label="Offset (in)"]'),
        angle = document.querySelector<HTMLInputElement>('[aria-label="Rotation (rad)"]');
    expect(length).not.toBeNull();
    expect(angle).not.toBeNull();
    expect(length!.value).toBe("1.000");
    expect(angle!.value).toBe("3.142");
    expect(length!.selectionEnd! - length!.selectionStart!).toBe(length!.value.length);
    length!.value = "2 in";
    angle!.value = "90 deg";
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(await pending).toEqual({ "Offset (mm)": "50.8", "Rotation (deg)": "90", Instances: "3" });
});
