// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Combobox, I18n, type IDocument, Localize, type Property, Transaction } from "@chili3d/core";
import { div, option, select, span } from "@chili3d/element";
import commonStyle from "./common.module.css";
import style from "./input.module.css";
import { PropertyBase } from "./propertyBase";

/**
 * A property that offers a fixed list of values (`Property.combobox`) edits through a
 * select: i18n keys read localized, other items through the combobox's converter.
 * Choosing an option writes the item itself to every object, as one undo step.
 */
export class ComboboxProperty extends PropertyBase {
    readonly select: HTMLSelectElement;

    constructor(
        readonly document: IDocument,
        objects: any[],
        readonly property: Property,
        readonly combobox: Combobox<any>,
    ) {
        super(objects);
        const current = objects[0][property.name];
        this.select = select(
            {
                className: style.box,
                onchange: this.onChange,
            },
            ...combobox.items.map((item, index) =>
                option({
                    value: String(index),
                    selected: item === current,
                    textContent:
                        typeof item === "string" && I18n.isI18nKey(item)
                            ? new Localize(item)
                            : (combobox.converter?.convert(item).unchecked() ?? String(item)),
                }),
            ),
        );
        this.append(
            div(
                { className: commonStyle.panel },
                span({ className: commonStyle.propertyName, textContent: new Localize(property.display) }),
                this.select,
            ),
        );
    }

    private readonly onChange = () => {
        const item = this.combobox.items.at(Number(this.select.value));
        if (item === undefined) return;
        Transaction.execute(this.document, "modify property", () => {
            for (const object of this.objects) {
                object[this.property.name] = item;
            }
            this.document.visual.update();
        });
    };
}

customElements.define("chili-combobox-property", ComboboxProperty);
