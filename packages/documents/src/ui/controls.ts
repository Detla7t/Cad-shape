// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type I18nKeys, Localize } from "@chili3d/core";
import { button } from "@chili3d/element";
import style from "./documents.module.css";

/** Small building blocks the viewers share. */

export function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** A toolbar button showing `text` (a symbol or abbreviation) with a translated tooltip. */
export function toolButton(tooltip: I18nKeys, text: string, onclick: () => void): HTMLButtonElement {
    return button({
        className: style.toolButton,
        textContent: text,
        title: new Localize(tooltip),
        onmousedown: (e: MouseEvent) => e.preventDefault(), // keep the editor's selection
        onclick,
    });
}

/** A toolbar button with a translated label. */
export function labelButton(label: I18nKeys, onclick: () => void): HTMLButtonElement {
    return button({ className: style.button, textContent: new Localize(label), onclick });
}
