// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ConfigurationInputData, configurationVisible } from "@chili3d/core";
import { input, option, select } from "@chili3d/element";
import type { ConfigurationDataContent } from "./configurationDataContent";

/**
 * The control that switches one input of the active configuration — a dropdown for a list, a
 * checkbox, a value box for a configuration variable. Shared by the Configuration panel and
 * the always-visible configuration bar, so both switch the same way: unrecorded, one rebuild.
 */
export function activeInputControl(
    content: Pick<ConfigurationDataContent, "activeValue" | "setActive" | "inputs" | "active">,
    item: ConfigurationInputData,
    className: string,
): HTMLElement {
    const current = content.activeValue(item);
    if (item.kind === "list") {
        return select(
            {
                className,
                title: item.name,
                onchange: (e: Event) => content.setActive(item.name, (e.target as HTMLSelectElement).value),
            },
            ...(Array.isArray(item.options) ? item.options : [])
                .filter(
                    (choice) =>
                        choice.name === current ||
                        configurationVisible(choice.visibility, content.inputs, content.active),
                )
                .map((choice) =>
                    option({
                        value: choice.name,
                        textContent: choice.name,
                        selected: choice.name === current,
                        disabled: !configurationVisible(choice.visibility, content.inputs, content.active),
                    }),
                ),
        );
    }
    if (item.kind === "checkbox") {
        return input({
            type: "checkbox",
            className,
            title: item.name,
            checked: current === true,
            onclick: (e: MouseEvent) => content.setActive(item.name, (e.target as HTMLInputElement).checked),
        });
    }
    const commit = (box: HTMLInputElement) => {
        const text = box.value.trim();
        if (text !== String(current ?? "")) content.setActive(item.name, text);
    };
    return input({
        className,
        title:
            (item.min !== undefined || item.max !== undefined) &&
            configurationVisible(item.rangeVisibility, content.inputs, content.active)
                ? `${item.name} · Range: ${item.min ?? "−∞"} – ${item.max ?? "∞"}`
                : item.name,
        ariaLabel: item.name,
        value: String(current ?? ""),
        spellcheck: false,
        onblur: (e: FocusEvent) => commit(e.target as HTMLInputElement),
        onkeydown: (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        },
    });
}
