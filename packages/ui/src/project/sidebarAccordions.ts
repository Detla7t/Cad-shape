// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import style from "./modelSidebar.module.css";

type SectionDefinition = { id: string; title: string; content: HTMLElement; weight: number };
type Section = {
    id: string;
    element: HTMLElement;
    toggle: HTMLButtonElement;
    actions: HTMLElement;
    content: HTMLElement;
    weight: number;
    collapsed: boolean;
};
const HEADER_HEIGHT = 28;
const MIN_EXPANDED_HEIGHT = 64;

/** Independent scrolling sections; dragging a divider redistributes only its two open neighbors. */
export class SidebarAccordions extends HTMLElement {
    readonly sections: Section[];
    private readonly dividers: HTMLElement[] = [];
    private drag?: AbortController;
    private observer?: ResizeObserver;

    constructor(
        definitions: SectionDefinition[],
        private readonly storageKey: string,
    ) {
        super();
        this.className = style.accordions;
        let saved: Record<string, { weight?: number; collapsed?: boolean }> = {};
        try {
            saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}") ?? {};
        } catch {}
        this.sections = definitions.map((definition) => {
            const element = document.createElement("section");
            element.className = style.section;
            element.dataset["section"] = definition.id;
            element.setAttribute("aria-label", definition.title);
            const header = document.createElement("div");
            header.className = style.sectionHeader;
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = style.toggle;
            toggle.textContent = definition.title;
            const actions = document.createElement("div");
            actions.className = style.headerActions;
            const content = document.createElement("div");
            content.className = style.sectionContent;
            content.append(definition.content);
            const value = saved[definition.id];
            const section = {
                id: definition.id,
                element,
                toggle,
                actions,
                content,
                weight:
                    typeof value?.weight === "number" && Number.isFinite(value.weight) && value.weight > 0
                        ? value.weight
                        : definition.weight,
                collapsed: value?.collapsed === true,
            };
            toggle.onclick = () => {
                section.collapsed = !section.collapsed;
                this.apply();
                this.save();
            };
            header.append(toggle, actions);
            element.append(header, content);
            return section;
        });
        this.sections.forEach((section, index) => {
            this.append(section.element);
            if (index === this.sections.length - 1) return;
            const divider = document.createElement("div");
            divider.className = style.divider;
            divider.tabIndex = 0;
            divider.setAttribute("role", "separator");
            divider.setAttribute("aria-orientation", "horizontal");
            divider.setAttribute(
                "aria-label",
                `Resize ${definitions[index].title} and ${definitions[index + 1].title}`,
            );
            divider.onpointerdown = (event) => this.startDrag(index, event);
            divider.onkeydown = (event) => {
                if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                const pair = this.neighbors(index);
                if (!pair) return;
                const delta =
                    event.key === "Home"
                        ? -Infinity
                        : event.key === "End"
                          ? Infinity
                          : (event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 40 : 10);
                this.resize(pair, delta);
                this.save();
            };
            this.dividers.push(divider);
            this.append(divider);
        });
        this.apply();
    }

    connectedCallback() {
        this.observer = new ResizeObserver(() => this.updateDividers());
        this.observer.observe(this);
    }
    disconnectedCallback() {
        this.drag?.abort();
        this.observer?.disconnect();
    }

    private neighbors(index: number) {
        const before = this.sections.slice(0, index + 1).findLast((s) => !s.collapsed);
        const after = this.sections.slice(index + 1).find((s) => !s.collapsed);
        if (!before || !after) return undefined;
        return {
            before,
            after,
            above: before.element.getBoundingClientRect().height,
            below: after.element.getBoundingClientRect().height,
        };
    }

    private resize(pair: NonNullable<ReturnType<SidebarAccordions["neighbors"]>>, delta: number) {
        const total = pair.above + pair.below;
        if (total <= MIN_EXPANDED_HEIGHT * 2) return;
        const above = Math.max(
            MIN_EXPANDED_HEIGHT,
            Math.min(total - MIN_EXPANDED_HEIGHT, pair.above + delta),
        );
        const weight = pair.before.weight + pair.after.weight;
        // Flex bases include the minimum section height, so distribute only the spare pixels.
        pair.before.weight =
            (weight * Math.max(0.001, above - MIN_EXPANDED_HEIGHT)) / (total - MIN_EXPANDED_HEIGHT * 2);
        pair.after.weight = Math.max(0.001, weight - pair.before.weight);
        this.apply();
    }

    private startDrag(index: number, event: PointerEvent) {
        if (event.button !== 0) return;
        const pair = this.neighbors(index);
        if (!pair) return;
        event.preventDefault();
        event.stopPropagation();
        (event.currentTarget as HTMLElement).focus();
        this.drag?.abort();
        const drag = new AbortController();
        this.drag = drag;
        const weights = [pair.before.weight, pair.after.weight];
        const move = (next: PointerEvent) => {
            if (next.pointerId !== event.pointerId) return;
            [pair.before.weight, pair.after.weight] = weights;
            this.resize(pair, next.clientY - event.clientY);
        };
        const end = (next: PointerEvent) => {
            if (next.pointerId !== event.pointerId) return;
            drag.abort();
            this.save();
        };
        document.addEventListener("pointermove", move, { signal: drag.signal });
        document.addEventListener("pointerup", end, { signal: drag.signal });
        document.addEventListener("pointercancel", end, { signal: drag.signal });
        window.addEventListener(
            "blur",
            () => {
                drag.abort();
                this.save();
            },
            { signal: drag.signal },
        );
    }

    private apply() {
        const expandedWeight = this.sections.reduce(
            (sum, section) => sum + (section.collapsed ? 0 : section.weight),
            0,
        );
        for (const section of this.sections) {
            section.toggle.setAttribute("aria-expanded", String(!section.collapsed));
            section.content.hidden = section.collapsed;
            section.element.style.flex = section.collapsed
                ? `0 0 ${HEADER_HEIGHT}px`
                : `${section.weight / expandedWeight} 1 ${MIN_EXPANDED_HEIGHT}px`;
            section.element.style.minHeight = `${section.collapsed ? HEADER_HEIGHT : MIN_EXPANDED_HEIGHT}px`;
        }
        this.updateDividers();
    }

    private updateDividers() {
        this.dividers.forEach((divider, index) => {
            const pair = this.neighbors(index);
            divider.setAttribute("aria-disabled", String(!pair));
            divider.tabIndex = pair ? 0 : -1;
            divider.setAttribute("aria-valuemin", String(MIN_EXPANDED_HEIGHT));
            divider.setAttribute(
                "aria-valuemax",
                String(
                    Math.round(
                        Math.max(
                            MIN_EXPANDED_HEIGHT,
                            (pair?.above ?? 0) + (pair?.below ?? 0) - MIN_EXPANDED_HEIGHT,
                        ),
                    ),
                ),
            );
            divider.setAttribute("aria-valuenow", String(Math.round(pair?.above ?? HEADER_HEIGHT)));
        });
    }

    private save() {
        try {
            localStorage.setItem(
                this.storageKey,
                JSON.stringify(
                    Object.fromEntries(
                        this.sections.map(({ id, weight, collapsed }) => [id, { weight, collapsed }]),
                    ),
                ),
            );
        } catch {
            /* Panel layout still works when browser storage is unavailable. */
        }
    }
}

customElements.define("chili-sidebar-accordions", SidebarAccordions);
