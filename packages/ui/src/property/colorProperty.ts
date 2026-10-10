// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Binding, type IDocument, Localize, type Property, PubSub, Transaction } from "@chili3d/core";
import { ColorConverter, div, input, label } from "@chili3d/element";
import colorStyle from "./colorPorperty.module.css";
import commonStyle from "./common.module.css";
import { asPropertyHosts, PropertyBase, type PropertyHost } from "./propertyBase";

export class ColorProperty extends PropertyBase {
    readonly converter = new ColorConverter();
    readonly input: HTMLInputElement;

    constructor(
        readonly document: IDocument,
        objects: readonly object[],
        readonly property: Property,
    ) {
        super(asPropertyHosts(objects));
        this.input = this.createInput(this.objects[0]);
        this.appendChild(this.createPanel());
    }

    private createInput(object: PropertyHost): HTMLInputElement {
        return input({
            className: colorStyle.color,
            type: "color",
            value: new Binding(object, this.property.name, this.converter),
            onchange: this.setColor,
        });
    }

    private createPanel(): HTMLElement {
        return div(
            { className: commonStyle.panel },
            label({
                className: commonStyle.propertyName,
                textContent: new Localize(this.property.display),
            }),
            this.input,
        );
    }

    disconnectedCallback(): void {
        this.input.removeEventListener("onchange", this.setColor);
    }

    private readonly setColor = (e: Event) => {
        const value = (e.target as HTMLInputElement).value;
        const color = this.converter.convertBack(value).value;
        if (color === undefined) {
            PubSub.default.pub("showToast", "toast.converter.invalidColor");
            return;
        }
        Transaction.execute(this.document, "change color", () => {
            this.objects.forEach((x) => {
                x[this.property.name] = color;
            });
        });
    };
}

customElements.define("chili-color-property", ColorProperty);
