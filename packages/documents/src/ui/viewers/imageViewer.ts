// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { div, img, span } from "@chili3d/element";
import { toolButton } from "../controls";
import style from "../documents.module.css";
import type { IDocumentViewer, ViewerContext } from "../viewer";

/**
 * Images (PNG, JPEG, GIF, WebP, BMP, SVG) on a checkerboard, fit or zoomed. An SVG is
 * shown through `<img>`, where its scripts never run.
 */
export function createImageViewer({ node }: ViewerContext): IDocumentViewer {
    const image = img({ className: style.checker, alt: node.name, draggable: false });
    const scroller = div({ className: style.canvasScroller }, image);
    const zoomLabel = span({ textContent: "" });
    let url: string | undefined;
    let zoom = 1;
    let fit = true;

    const layout = () => {
        const width = image.naturalWidth || 1;
        const height = image.naturalHeight || 1;
        if (fit) {
            zoom = Math.min(1, (scroller.clientWidth - 32) / width, (scroller.clientHeight - 32) / height);
            if (!(zoom > 0)) zoom = 1;
        }
        image.style.width = `${Math.round(width * zoom)}px`;
        image.style.height = `${Math.round(height * zoom)}px`;
        zoomLabel.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${Math.round(zoom * 100)}%`;
    };

    const load = () => {
        if (url !== undefined) URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob([node.bytes as BlobPart], { type: node.mimeType }));
        image.src = url;
    };
    image.addEventListener("load", layout);
    load();

    const setZoom = (next: number) => {
        fit = false;
        zoom = Math.min(16, Math.max(0.05, next));
        layout();
    };

    return {
        element: div(
            { className: style.body },
            div(
                { className: style.toolbar },
                toolButton("documents.zoomOut", "−", () => setZoom(zoom / 1.25)),
                toolButton("documents.zoomIn", "+", () => setZoom(zoom * 1.25)),
                toolButton("documents.actualSize", "1:1", () => setZoom(1)),
                toolButton("documents.fit", "⤢", () => {
                    fit = true;
                    layout();
                }),
                zoomLabel,
            ),
            scroller,
        ),
        reload: load,
        activated: layout,
        dispose: () => {
            if (url !== undefined) URL.revokeObjectURL(url);
        },
    };
}
