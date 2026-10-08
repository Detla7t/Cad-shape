// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication } from "@chili3d/core";
import { div } from "@chili3d/element";
import style from "./versions.module.css";
import { VersionsPanel } from "./versionsPanel";

const MIN_WIDTH = 240;

/** The Versions & History panel docked at the left edge of the editor's content row. */
export class VersionsDock {
    private dock?: HTMLElement;
    private width = 340;

    constructor(
        private readonly app: IApplication,
        private readonly host: () => HTMLElement | null,
    ) {}

    get visible(): boolean {
        return this.dock !== undefined;
    }

    readonly toggle = () => {
        if (this.dock) this.hide();
        else this.show();
    };

    show(): void {
        const host = this.host();
        if (this.dock || host === null) return;
        const panel = new VersionsPanel(this.app);
        panel.onClose = () => this.hide();
        const dock = div(
            { className: style.dock },
            div({ className: style.dockResizer, onpointerdown: (e: PointerEvent) => this.startResize(e) }),
            panel,
        );
        dock.style.width = `${this.width}px`;
        host.insertBefore(dock, host.children[1] ?? null);
        this.dock = dock;
    }

    hide(): void {
        this.dock?.remove();
        this.dock = undefined;
    }

    private startResize(e: PointerEvent): void {
        e.preventDefault();
        const dock = this.dock;
        if (dock === undefined) return;
        const left = dock.getBoundingClientRect().left;
        const move = (ev: PointerEvent) => {
            this.width = Math.max(
                MIN_WIDTH,
                Math.min(Math.floor(window.innerWidth * 0.6), ev.clientX - left),
            );
            dock.style.width = `${this.width}px`;
        };
        const up = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            document.removeEventListener("pointercancel", up);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
    }
}
