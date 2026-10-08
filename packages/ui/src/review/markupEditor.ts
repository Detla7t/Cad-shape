// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IView, ReviewImage } from "@chili3d/core";
import { action, textElement } from "./helpers";
import style from "./review.module.css";

/** Markup is attached to a captured view, so it stays interpretable after geometry changes. */
export async function captureMarkup(view: IView): Promise<ReviewImage | undefined> {
    const source = view.toImage(),
        background = new Image();
    background.src = source;
    await background.decode();
    return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = style.markup;
        dialog.setAttribute("aria-label", "Sketch and part markup");
        const canvas = document.createElement("canvas");
        canvas.width = background.naturalWidth;
        canvas.height = background.naturalHeight;
        canvas.setAttribute("aria-label", "Draw markup");
        const ctx = canvas.getContext("2d")!;
        const history: ImageData[] = [];
        let start: { x: number; y: number } | undefined,
            previous: { x: number; y: number } | undefined,
            base: ImageData | undefined;
        const tool = document.createElement("select");
        tool.setAttribute("aria-label", "Markup tool");
        for (const name of ["Pen", "Arrow", "Rectangle"]) tool.add(new Option(name));
        const color = document.createElement("input");
        color.type = "color";
        color.value = "#e53935";
        color.setAttribute("aria-label", "Markup color");
        const reset = () => ctx.drawImage(background, 0, 0);
        reset();
        const point = (event: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: ((event.clientX - rect.x) * canvas.width) / rect.width,
                y: ((event.clientY - rect.y) * canvas.height) / rect.height,
            };
        };
        canvas.onpointerdown = (event) => {
            if (event.button !== 0) return;
            canvas.setPointerCapture(event.pointerId);
            start = previous = point(event);
            base = ctx.getImageData(0, 0, canvas.width, canvas.height);
        };
        canvas.onpointermove = (event) => {
            if (!start || !base || !previous) return;
            const p = point(event);
            ctx.strokeStyle = color.value;
            ctx.lineWidth = Math.max(2, canvas.width / 400);
            ctx.lineCap = "round";
            if (tool.value !== "Pen") ctx.putImageData(base, 0, 0);
            ctx.beginPath();
            if (tool.value === "Rectangle") ctx.rect(start.x, start.y, p.x - start.x, p.y - start.y);
            else {
                const from = tool.value === "Pen" ? previous : start;
                ctx.moveTo(from.x, from.y);
                ctx.lineTo(p.x, p.y);
                if (tool.value === "Arrow") {
                    const a = Math.atan2(p.y - start.y, p.x - start.x),
                        size = canvas.width / 35;
                    for (const d of [-0.45, 0.45]) {
                        ctx.moveTo(p.x, p.y);
                        ctx.lineTo(p.x - size * Math.cos(a + d), p.y - size * Math.sin(a + d));
                    }
                }
            }
            ctx.stroke();
            previous = p;
        };
        const finish = () => {
            if (base && start) history.push(base);
            start = previous = undefined;
            base = undefined;
        };
        canvas.onpointerup = finish;
        canvas.onpointercancel = finish;
        const close = (image?: ReviewImage) => {
            dialog.remove();
            resolve(image);
        };
        const header = document.createElement("header");
        header.append(
            textElement("strong", "Add markup"),
            tool,
            color,
            action("Undo stroke", () => {
                const image = history.pop();
                if (image) ctx.putImageData(image, 0, 0);
            }),
            action("Clear", () => {
                history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
                reset();
            }),
        );
        const footer = document.createElement("footer");
        footer.append(
            action("Cancel", () => close()),
            action("Attach markup", () =>
                close({
                    name: `${view.document.name} markup.png`,
                    dataUrl: canvas.toDataURL("image/png"),
                    markup: true,
                }),
            ),
        );
        dialog.oncancel = (event) => {
            event.preventDefault();
            close();
        };
        dialog.onkeydown = (event) => event.stopPropagation();
        dialog.append(header, canvas, footer);
        document.body.append(dialog);
        dialog.showModal();
    });
}
