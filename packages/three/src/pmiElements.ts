// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type PmiAnnotation,
    PmiDatum,
    PmiDimension,
    PmiFeatureControlFrame,
    PmiFlag,
    PmiNote,
    type PmiTerminatorShape,
} from "@chili3d/core";
import { div, span } from "@chili3d/element";
import style from "./threePmi.module.css";

const SVG_NS = "http://www.w3.org/2000/svg";

export function pmiColor(color: number): string {
    return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

function svgElement(tag: string, attributes: Record<string, string>): SVGElement {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
}

/**
 * The HTML frame of an annotation, built once per view and placed by the view's CSS2D
 * renderer. Clicking it selects the node so the properties panel edits the text.
 */
export function buildPmiFrame(annotation: PmiAnnotation, onSelect?: () => void): HTMLElement {
    const element = div({ className: `${style.pmi} ${style[annotation.kind] ?? ""}` });
    element.style.setProperty("--pmi-color", pmiColor(annotation.color));
    element.style.fontSize = `${annotation.textSize}px`;
    element.dataset["kind"] = annotation.kind;
    element.dataset["nodeId"] = annotation.id;
    if (annotation.locked) element.dataset["locked"] = "true";
    element.append(...frameContent(annotation));
    for (const type of ["pointerdown", "pointerup", "dblclick"] as const) {
        element.addEventListener(type, (event) => event.stopPropagation());
    }
    element.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelect?.();
    });
    return element;
}

function frameContent(annotation: PmiAnnotation): HTMLElement[] {
    if (annotation instanceof PmiNote) {
        return annotation.lines().map((line) => div({ className: style.line, textContent: line || " " }));
    }
    if (annotation instanceof PmiFlag) {
        return [hexagon(), span({ className: style.flagText, textContent: annotation.content })];
    }
    if (annotation instanceof PmiFeatureControlFrame) {
        return annotation.cells().map((cell, index) =>
            span({
                className: index === 0 ? `${style.cell} ${style.symbol}` : style.cell,
                textContent: cell,
            }),
        );
    }
    if (annotation instanceof PmiDatum) {
        return [span({ className: style.cell, textContent: annotation.label })];
    }
    if (annotation instanceof PmiDimension) {
        return [span({ className: style.dimensionText, textContent: annotation.text() })];
    }
    return [span({ textContent: annotation.text() })];
}

/** A flag note's hexagon, drawn behind its number. */
function hexagon(): HTMLElement {
    const svg = svgElement("svg", { viewBox: "0 0 28 24", class: style.hexagon, "aria-hidden": "true" });
    svg.append(
        svgElement("polygon", {
            points: "7.5,1 20.5,1 27,12 20.5,23 7.5,23 1,12",
            fill: "var(--pmi-background)",
            stroke: "currentColor",
            "stroke-width": "1.2",
        }),
    );
    return svg as unknown as HTMLElement;
}

/**
 * The marker where a leader or dimension line meets the model: an arrowhead with its tip at
 * the element's centre, a dot, or a datum triangle with its base at the centre. The inner
 * svg is rotated by the view every frame so the body follows the line on screen.
 */
export function buildTerminator(shape: PmiTerminatorShape, color: number): HTMLElement {
    const element = div({ className: `${style.terminator} ${style[shape] ?? ""}` });
    element.style.setProperty("--pmi-color", pmiColor(color));
    element.dataset["shape"] = shape;
    const svg = svgElement("svg", { viewBox: "-16 -8 32 16", class: style.marker, "aria-hidden": "true" });
    switch (shape) {
        case "arrow":
            svg.append(svgElement("polygon", { points: "0,0 13,-3.5 13,3.5", fill: "currentColor" }));
            break;
        case "dot":
            svg.append(svgElement("circle", { cx: "0", cy: "0", r: "2.6", fill: "currentColor" }));
            break;
        case "triangle":
            svg.append(svgElement("polygon", { points: "0,-5 0,5 11,0", fill: "currentColor" }));
            break;
        default:
            break;
    }
    element.append(svg as unknown as HTMLElement);
    return element;
}

/** Points the terminator's body along the screen angle (radians, clockwise, 0 = right). */
export function orientTerminator(element: HTMLElement, angle: number): void {
    const marker = element.firstElementChild as HTMLElement | null;
    if (marker) marker.style.transform = `rotate(${angle}rad)`;
}
