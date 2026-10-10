// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ConfigurationInputKind, I18n } from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./modelTable.module.css";

/** A single footer menu for independent configuration inputs. */
export class ConfigurationInputMenu {
    readonly element = document.createElement("div");
    private readonly add = document.createElement("button");
    private menu?: HTMLElement;
    private events?: AbortController;

    constructor(private readonly onChoose: (kind: ConfigurationInputKind) => void) {
        this.element.className = style.inputFooter;
        this.add.append(
            createCadIcon("tables"),
            document.createTextNode(`${I18n.translate("configuration.addInput")} ▴`),
        );
        this.add.setAttribute("aria-label", "Add configuration input");
        this.add.setAttribute("aria-haspopup", "menu");
        this.add.setAttribute("aria-expanded", "false");
        this.add.onclick = () => (this.menu ? this.close() : this.open());
        this.element.append(this.add);
    }
    private open() {
        const menu = document.createElement("div");
        menu.className = style.inputMenu;
        menu.setAttribute("role", "menu");
        for (const [kind, label, icon] of [
            ["list", "configuration.kind.list", "tables"],
            ["checkbox", "configuration.kind.checkbox", "check"],
            ["variable", "configuration.kind.variable", "variable"],
        ] as const) {
            const choice = document.createElement("button");
            choice.setAttribute("role", "menuitem");
            choice.dataset["inputKind"] = kind;
            choice.append(createCadIcon(icon), document.createTextNode(I18n.translate(label)));
            choice.onclick = () => {
                this.close();
                this.onChoose(kind);
            };
            menu.append(choice);
        }
        menu.onkeydown = (event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
                this.close();
                this.add.focus();
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const rows = Array.from(menu.querySelectorAll("button"));
                const current = rows.indexOf(document.activeElement as HTMLButtonElement);
                rows[(current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
            }
        };
        this.element.append(menu);
        this.menu = menu;
        this.add.setAttribute("aria-expanded", "true");
        this.events = new AbortController();
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (!this.element.contains(event.target as Node)) this.close();
            },
            { signal: this.events.signal },
        );
        menu.querySelector("button")?.focus();
    }
    close() {
        this.events?.abort();
        this.menu?.remove();
        this.menu = undefined;
        this.add.setAttribute("aria-expanded", "false");
    }
}
