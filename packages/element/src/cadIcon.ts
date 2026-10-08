// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandIcon } from "@chili3d/core";
import { createConstraintIcon } from "./constraintIcon";
import { createIcon } from "./elements";
import { createModelingIcon } from "./modelingIcon";
import { createOnshapeIcon } from "./onshapeIcon";

/** Original 20 px CAD symbols: neutral geometry, blue editable handles. */
const paths: Record<string, string> = {
    line: "M4 16 16 4",
    rectangle: "M3 5H17V15H3Z",
    circle: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M9 10h2 M10 9v2",
    arc: "M3 15a7 9 0 0 1 14 0 M9 15h2 M10 14v2",
    ellipse: "M18 10a8 5 0 1 1-16 0 8 5 0 0 1 16 0Z",
    polygon: "M10 2 18 8 15 17H5L2 8Z",
    sketch: "M3 14 13 4l3 3L6 17H3Z M11 6l3 3 M2 19h16",
    extrude: "M4 8 11 5 17 8 10 11Z M4 8v8l6 3 7-3V8 M10 11v8 M10 7V1 M8 3l2-2 2 2",
    revolve: "M7 3v14H3V8Z M11 5c8-2 9 10 0 10 M13 12l-2 3 3 2 M10 1v18",
    loft: "M5 4Q10 1 15 4Q10 7 5 4Z M5 4 2 15q8 6 16 0L15 4 M2 15q8-5 16 0",
    sweep: "M3 17V9Q3 3 10 3h7 M7 17V9q0-2 3-2h7 M3 17q2 2 4 0 M17 3q3 2 0 4",
    fillet: "M3 17V9a6 6 0 0 1 6-6h8 M7 17V9a2 2 0 0 1 2-2h8",
    chamfer: "M3 17V8l5-5h9 M7 17V10l3-3h7",
    box: "M3 6 10 2l7 4v9l-7 4-7-4Z M3 6l7 4 7-4 M10 10v9",
    fuse: "M2 5h10v10H2Z M8 9h10v9H8",
    cut: "M2 3h12v5H8v8H2Z M11 11h7v7h-7Z",
    common: "M2 3h11v11H2Z M8 8h10v10H8Z M8 8h5v6H8Z",
    move: "M10 1v18 M1 10h18 M7 4l3-3 3 3 M7 16l3 3 3-3 M4 7l-3 3 3 3 M16 7l3 3-3 3",
    rotate: "M4 6a7 7 0 1 1-1 7 M4 2v4H0 M7 8h5v5H7Z",
    mirror: "M10 1v18 M2 5v10h5Z M18 5v10h-5Z",
    trim: "M2 3 17 18 M3 17 17 3 M2 14a3 3 0 1 0 3 3 M2 6a3 3 0 1 1 3-3",
    horizontal: "M2 10h16",
    vertical: "M10 2v16",
    horizontalAlign: "M2 10h16 M4 7v6 M16 7v6",
    verticalAlign: "M10 2v16 M7 4h6 M7 16h6",
    perpendicular: "M3 16h14 M7 16V3 M7 12h4v4",
    parallel: "M3 3 13 17 M7 3 17 17",
    equal: "M3 7h14 M3 13h14",
    tangent: "M3 17 17 3 M12 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z",
    coincident: "M2 17 10 9 18 2 M13 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    pointOn: "M2 17 18 3 M12 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
    midpoint: "M2 14h16 M7 11l3-5 3 5Z",
    symmetric: "M10 1v18 M2 6h4v8H2Z M14 6h4v8h-4Z",
    fix: "M4 9h12v9H4Z M6 9V6a4 4 0 0 1 8 0v3 M10 12v3",
    distance: "M3 2v16 M17 2v16 M3 7h14 M6 5 3 7l3 2 M14 5l3 2-3 2 M5 17h10",
    radius: "M3 15a7 7 0 1 1 13-1 M9 11 17 3 M13 4l4-1-1 4 M8 11h2 M9 10v2",
    angle: "M3 3v14h14 M3 8a9 9 0 0 1 9 9 M3 17 16 4",
    construction: "M2 16l3-3 M7 11l3-3 M12 6l3-3 M17 1l1-1",
    normal: "M3 8 11 5 17 8 9 11Z M10 9V1 M7 4l3-3 3 3 M3 8v7l6 3 8-3V8 M9 11v7",
    projectEdges: "M2 2h10v10H2Z M8 8h10v10H8Z M5 5l10 10 M11 15h4v-4",
    undo: "M7 3 2 7l5 4 M2 7h9q7 0 6 9",
    redo: "M13 3l5 4-5 4 M18 7h-9q-7 0-6 9",
    save: "M3 2h12l3 3v13H2V2Z M6 2v6h8V2 M6 18v-6h8v6",
    delete: "M3 5h14 M7 5V2h6v3 M5 5l1 13h8l1-13 M8 8v7 M12 8v7",
    search: "M13 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z M12 12l6 6",
    menu: "M3 5h14 M3 10h14 M3 15h14",
    check: "M3 10l5 5L17 5",
    close: "M5 5l10 10 M15 5 5 15",
    variable: "M8 2Q4 2 4 6v2l-2 2 2 2v2q0 4 4 4 M12 2q4 0 4 4v2l2 2-2 2v2q0 4-4 4 M8 8l4 4 M12 8l-4 4",
    history:
        "M5 2v16 M5 5h8v6h4 M3 5a2 2 0 1 1 4 0 2 2 0 0 1-4 0Z M3 15a2 2 0 1 1 4 0 2 2 0 0 1-4 0Z M15 11h4v4h-4Z",
    plane: "M2 6 13 2l5 12-11 4Z M7 4v12 M4 11l11-4",
    configuration: "M2 2h15v15H2Z M2 7h15 M7 2v15 M11 11h7 M14 8v6",
    tables: "M2 2h16v16H2Z M2 7h16 M2 12h16 M7 2v16 M12 2v16",
    inspection: "M2 2h12v16H2Z M5 6h6 M5 10h3 M10 13l3 3 5-7",
    newStudio: "M3 2h10l4 4v12H3Z M12 2v5h5 M6 10l-2 2 2 2 M14 10l2 2-2 2 M11 9l-2 6",
};
const aliases: Record<string, string> = {
    circle3Point: "circle",
    create: "sketch",
    enter: "sketch",
    exit: "check",
    cancel: "close",
    horizontalDistance: "distance",
    verticalDistance: "distance",
    pointLineDistance: "distance",
    toggleExternal: "projectEdges",
    insert: "newStudio",
    editStudio: "newStudio",
};
const handles: Record<string, number[][]> = {
    line: [
        [4, 16],
        [16, 4],
    ],
    rectangle: [
        [3, 5],
        [17, 5],
        [3, 15],
        [17, 15],
    ],
    arc: [
        [3, 15],
        [17, 15],
    ],
    circle: [[10, 10]],
    coincident: [[9, 9]],
};

export function createCadIcon(command: string, fallback?: CommandIcon): Element {
    const source = createOnshapeIcon(command);
    if (source) return source;
    const constraint = createConstraintIcon(command);
    if (constraint) return constraint;
    const modeling = createModelingIcon(command);
    if (modeling) return modeling;
    const leaf = command.split(".").at(-1)!;
    const key = command === "plane.create" ? "plane" : (aliases[leaf] ?? leaf);
    if (!paths[key] && fallback) {
        const icon = createIcon(fallback);
        icon.setAttribute("style", "filter: grayscale(1)");
        return icon;
    }
    const ns = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(ns, "svg");
    icon.setAttribute("viewBox", "0 0 20 20");
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("fill", "none");
    icon.style.fill = "none";
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.25");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", paths[key] ?? paths["box"]);
    icon.append(path);
    for (const [x, y] of handles[key] ?? []) {
        const point = document.createElementNS(ns, "rect");
        point.setAttribute("x", String(x - 1.2));
        point.setAttribute("y", String(y - 1.2));
        point.setAttribute("width", "2.4");
        point.setAttribute("height", "2.4");
        point.setAttribute("fill", "var(--panel-background-color, white)");
        point.setAttribute("stroke", "#548ad0");
        point.setAttribute("stroke-width", ".8");
        icon.append(point);
    }
    return icon;
}
