// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import style from "./historyBar.module.css";
/** A rollback marker sits between feature rows; down advances, up rewinds. */
export class HistoryBar {
    private stopDrag?: () => void;
    dispose(): void {
        this.stopDrag?.();
    }
    readonly element = document.createElement("div");
    /**
     * `isFuture` overrides which rows show as rolled back (default: every row at or after the
     * marker) — the tree's document bar leaves a body the marker splits to that body's own bar.
     */
    constructor(
        private readonly rows: () => HTMLElement[],
        private readonly read: () => number,
        private readonly apply: (position: number) => void,
        private readonly isFuture: (index: number, position: number) => boolean = (index, position) =>
            index >= position,
    ) {
        const bar = this.element;
        bar.className = style.bar;
        bar.tabIndex = 0;
        bar.role = "slider";
        bar.ariaLabel = "History bar";
        bar.title = "Drag up to roll back; drag down to advance. Double-click to roll to end.";
        bar.addEventListener("pointerdown", this.down);
        bar.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            this.apply(this.rows().length);
            this.refresh();
        });
        bar.addEventListener("keydown", (e) => {
            let position = this.read();
            if (e.key === "ArrowUp") position--;
            else if (e.key === "ArrowDown") position++;
            else if (e.key === "Home") position = 0;
            else if (e.key === "End") position = this.rows().length;
            else return;
            e.preventDefault();
            e.stopPropagation();
            this.apply(Math.max(0, Math.min(this.rows().length, position)));
            this.refresh();
        });
    }
    refresh(position = this.read()): void {
        const rows = this.rows(),
            parent = rows[0]?.parentElement;
        if (!parent) return;
        this.element.ariaValueMin = "0";
        this.element.ariaValueMax = String(rows.length);
        this.element.ariaValueNow = String(position);
        this.element.ariaValueText =
            position === rows.length ? "End of history" : `Before feature ${position + 1}`;
        const focused = document.activeElement === this.element;
        parent.insertBefore(this.element, rows[position] ?? null);
        if (focused) this.element.focus();
        rows.forEach((row, i) => row.classList.toggle(style.future, this.isFuture(i, position)));
    }
    private readonly down = (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.stopDrag?.();
        this.element.focus();
        let position = this.read();
        const move = (e: PointerEvent) => {
            const rows = this.rows();
            position = rows.filter(
                (row) => e.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2,
            ).length;
            this.refresh(position);
        };
        const up = () => {
            cleanup();
            this.apply(position);
            this.refresh();
        };
        const cancel = () => {
            cleanup();
            this.refresh();
        };
        const cleanup = () => {
            this.stopDrag = undefined;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
        };
        this.stopDrag = cleanup;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
        window.addEventListener("pointercancel", cancel, { once: true });
    };
}
