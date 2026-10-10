// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    acceptFormulaCompletion,
    type FormulaCompletion,
    formulaArgumentHelp,
    formulaCompletion,
} from "@chili3d/sheet/formulaSuggestions";
import { FUNCTION_INFO } from "@chili3d/sheet/functionInfo";
import style from "../spreadsheet.module.css";

let nextId = 0;

/** One accessible popup shared by the formula bar and the active cell editor. */
export function createFormulaAssist(ranges: () => readonly string[] = () => []) {
    const popup = document.createElement("div");
    popup.className = style.formulaAssist;
    popup.hidden = true;
    popup.id = `sheet-formulas-${++nextId}`;
    let active: HTMLInputElement | undefined;
    let completion: FormulaCompletion | undefined;
    let selected = 0;
    const bound = new Map<HTMLInputElement, () => void>();

    const hide = () => {
        popup.hidden = true;
        active?.setAttribute("aria-expanded", "false");
        active?.removeAttribute("aria-activedescendant");
    };
    const position = () => {
        if (!active || popup.hidden) return;
        const box = active.getBoundingClientRect();
        const width = Math.min(360, window.innerWidth - 16);
        popup.style.width = `${width}px`;
        popup.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
        const height = popup.offsetHeight;
        popup.style.top = `${Math.max(8, box.bottom + height > window.innerHeight - 8 ? box.top - height : box.bottom + 3)}px`;
    };
    const accept = () => {
        if (!active || !completion) return;
        const result = acceptFormulaCompletion(active.value, completion, completion.names[selected]);
        active.value = result.text;
        active.setSelectionRange(result.cursor, result.cursor);
        active.dispatchEvent(new Event("input", { bubbles: true }));
        active.focus();
    };
    const render = () => {
        if (!active) return;
        popup.replaceChildren();
        const help = formulaArgumentHelp(active.value, active.selectionStart ?? active.value.length);
        const name = completion?.names[selected] ?? help?.name;
        if (!name) {
            hide();
            return;
        }
        const info = FUNCTION_INFO[name];
        if (info) {
            const description = document.createElement("div");
            description.className = style.functionHelp;
            const signature = document.createElement("div");
            signature.className = style.signature;
            signature.append(`${name}(`);
            info[0].split(", ").forEach((arg, i) => {
                if (i) signature.append(", ");
                const parameter = document.createElement("span");
                parameter.textContent = arg;
                if (!completion && help?.argument === i) parameter.className = style.activeArgument;
                signature.append(parameter);
            });
            signature.append(")");
            const summary = document.createElement("div");
            summary.textContent = info[1];
            description.append(signature, summary);
            popup.append(description);
        }
        if (completion) {
            const list = document.createElement("div");
            list.className = style.functionList;
            list.setAttribute("role", "listbox");
            list.setAttribute("aria-label", "Formula suggestions");
            for (const [i, name] of completion.names.entries()) {
                const item = document.createElement("div");
                item.id = `${popup.id}-${i}`;
                item.setAttribute("role", "option");
                item.setAttribute("aria-selected", String(i === selected));
                item.textContent = name;
                item.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                item.addEventListener("click", () => {
                    selected = i;
                    accept();
                });
                list.append(item);
            }
            popup.append(list);
            const footer = document.createElement("div");
            footer.className = style.suggestionFooter;
            footer.textContent = "Tab or Enter to accept · ↑ ↓ to navigate · Esc to dismiss";
            popup.append(footer);
            active.setAttribute("aria-activedescendant", `${popup.id}-${selected}`);
            (list.children[selected] as HTMLElement)?.scrollIntoView?.({ block: "nearest" });
        } else active.removeAttribute("aria-activedescendant");
        if (!popup.isConnected) document.body.append(popup);
        popup.hidden = false;
        active.setAttribute("aria-expanded", String(!!completion));
        position();
    };
    const refresh = (box: HTMLInputElement) => {
        active = box;
        completion = formulaCompletion(box.value, box.selectionStart ?? box.value.length, ranges());
        selected = 0;
        render();
    };
    const bind = (box: HTMLInputElement) => {
        box.setAttribute("role", "combobox");
        box.setAttribute("aria-autocomplete", "list");
        box.setAttribute("aria-controls", popup.id);
        box.setAttribute("aria-expanded", "false");
        const update = () => refresh(box);
        const keydown = (event: KeyboardEvent) => {
            if (event.isComposing || active !== box || popup.hidden) return;
            if (completion && ["ArrowDown", "ArrowUp", "Tab", "Enter"].includes(event.key)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    selected =
                        (selected + (event.key === "ArrowDown" ? 1 : -1) + completion.names.length) %
                        completion.names.length;
                    render();
                } else accept();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                hide();
            }
        };
        const keyup = (event: KeyboardEvent) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) update();
        };
        box.addEventListener("input", update);
        box.addEventListener("click", update);
        box.addEventListener("keydown", keydown, true);
        box.addEventListener("keyup", keyup);
        box.addEventListener("blur", hide);
        const dispose = () => {
            box.removeEventListener("input", update);
            box.removeEventListener("click", update);
            box.removeEventListener("keydown", keydown, true);
            box.removeEventListener("keyup", keyup);
            box.removeEventListener("blur", hide);
            bound.delete(box);
            if (active === box) {
                hide();
                active = undefined;
            }
        };
        bound.set(box, dispose);
        return dispose;
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return {
        bind,
        refresh,
        hide,
        dispose: () => {
            for (const dispose of [...bound.values()]) dispose();
            window.removeEventListener("resize", position);
            window.removeEventListener("scroll", position, true);
            popup.remove();
        },
    };
}
