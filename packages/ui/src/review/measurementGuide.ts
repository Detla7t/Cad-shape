// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { formatDocumentValue, type IView, LENGTH_UNITS, type MeasurementResult, XYZ } from "@chili3d/core";
import style from "./viewportUtilities.module.css";

const SVG = "http://www.w3.org/2000/svg";
export class MeasurementGuide {
    readonly element = document.createElementNS(SVG, "svg");
    private result?: MeasurementResult;
    private readonly resize: ResizeObserver;
    constructor(private readonly view: IView) {
        this.element.classList.add(style.guide);
        this.element.setAttribute("aria-label", "Measurement guide");
        this.element.setAttribute("aria-hidden", "true");
        view.cameraController.onPropertyChanged(this.render);
        this.resize = new ResizeObserver(this.render);
        this.resize.observe(this.element);
    }
    show(result?: MeasurementResult) {
        this.result = result;
        this.render();
    }
    private readonly render = () => {
        this.element.replaceChildren();
        const result = this.result;
        if (!result || !this.view.dom) return;
        const projected = result.segments
            .map(
                ([a, b]) =>
                    [this.view.worldToScreen(new XYZ(a)), this.view.worldToScreen(new XYZ(b))] as const,
            )
            .filter((pair) => pair.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
        if (!projected.length) return;
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("d", projected.map(([a, b]) => `M${a.x},${a.y}L${b.x},${b.y}`).join(" "));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#1683b9");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke-dasharray", "6 4");
        this.element.append(path);
        if (result.mode !== "length")
            for (const point of projected[0]) {
                const marker = document.createElementNS(SVG, "circle");
                marker.setAttribute("cx", String(point.x));
                marker.setAttribute("cy", String(point.y));
                marker.setAttribute("r", "3");
                marker.setAttribute("fill", "#1683b9");
                this.element.append(marker);
            }
        const [a, b] = projected[Math.floor(projected.length / 2)];
        const text = document.createElementNS(SVG, "text");
        text.setAttribute("x", String((a.x + b.x) / 2));
        text.setAttribute("y", String((a.y + b.y) / 2 - 9));
        text.setAttribute("text-anchor", "middle");
        text.textContent = `${result.label}: ${formatDocumentValue(result.value, this.view.document, LENGTH_UNITS)}`;
        this.element.append(text);
    };
    dispose() {
        this.resize.disconnect();
        this.view.cameraController.removePropertyChanged(this.render);
        this.element.remove();
    }
}
