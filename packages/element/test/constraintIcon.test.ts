// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createCadIcon } from "../src/cadIcon";

test.each([
    "coincident",
    "horizontal",
    "vertical",
    "perpendicular",
    "parallel",
    "equal",
    "tangent",
    "midpoint",
    "symmetric",
    "fix",
])("%s renders self-contained source SVG artwork in each toolbar instance", (name) => {
    const first = createCadIcon(`constraint.${name}`);
    const second = createCadIcon(`constraint.${name}`);
    expect(first.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(first.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(first.querySelector("use")).toBeNull();
    expect(first.innerHTML).toBe(second.innerHTML);
    expect(first.firstElementChild).not.toBe(second.firstElementChild);
    expect((first as SVGSVGElement).style.getPropertyValue("--os-icon-outline-primary")).toBe("currentColor");
});
