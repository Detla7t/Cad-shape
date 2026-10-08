// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createOnshapeIcon } from "../src/onshapeIcon";

test.each([
    "part",
    "sketch",
    "assembly",
    "drawing",
    "folder",
    "tables",
    "inspection",
    "variables",
])("%s uses toolbar artwork without the padded element-thumbnail canvas", (command) => {
    const icon = createOnshapeIcon(command);
    expect(icon).not.toBeUndefined();
    expect(icon!.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(icon!.children.length).toBeGreaterThan(0);
    expect(icon!.querySelector("use")).toBeNull();
});
