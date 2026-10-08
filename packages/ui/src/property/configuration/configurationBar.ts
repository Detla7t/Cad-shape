// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    configurationVisible,
    type IApplication,
    type IDocument,
    type IView,
    Localize,
    PubSub,
} from "@chili3d/core";
import { button, div, span, svg } from "@chili3d/element";
import { activeInputControl } from "./activeControls";
import style from "./configurationBar.module.css";
import { ConfigurationDataContent } from "./configurationDataContent";

/**
 * The active configuration, always in view: a slim bar just above the element tabs with one
 * control per configuration input of the active document — so switching the Part Studio to
 * another configuration is one click, wherever the Configuration panel is. It is absent for a
 * document without configuration inputs, and its button opens the panel to edit them.
 */
export class ConfigurationBar extends HTMLElement {
    private _document: IDocument | undefined;
    private content: ConfigurationDataContent | undefined;

    constructor(
        private readonly app: IApplication,
        private readonly embedded = false,
    ) {
        super();
        this.className = style.bar;
        this.dataset["embedded"] = String(embedded);
        this.render();
    }

    connectedCallback(): void {
        PubSub.default.sub("activeViewChanged", this.handleActiveViewChanged);
        PubSub.default.sub("documentClosed", this.handleDocumentClosed);
        this.setDocument(this.app.activeView?.document);
    }

    disconnectedCallback(): void {
        PubSub.default.remove("activeViewChanged", this.handleActiveViewChanged);
        PubSub.default.remove("documentClosed", this.handleDocumentClosed);
        this.setDocument(undefined);
    }

    /** The document whose configuration the bar shows. */
    get document(): IDocument | undefined {
        return this._document;
    }

    setDocument(document: IDocument | undefined): void {
        if (document === this._document) return;
        this._document?.variables.removePropertyChanged(this.handleChanged);
        this._document = document;
        this.content =
            document === undefined
                ? undefined
                : new ConfigurationDataContent(document, () => {
                      document.visual.update();
                      this.render();
                  });
        document?.variables.onPropertyChanged(this.handleChanged);
        this.render();
    }

    private readonly handleActiveViewChanged = (view: IView | undefined) => {
        this.setDocument(view?.document);
    };

    private readonly handleDocumentClosed = (document: IDocument) => {
        if (document === this._document) this.setDocument(undefined);
    };

    private readonly handleChanged = (property: string) => {
        if (property !== "configurationJson" && property !== "activeConfigurationJson") return;
        // The bar's own switch already shows its value; re-rendering would only drop the focus.
        if (this.content?.isWriting) return;
        this.render();
    };

    render(): void {
        const content = this.content;
        const inputs = content?.inputs.filter((x) => x !== null && typeof x === "object") ?? [];
        this.style.display = !this.embedded && inputs.length === 0 ? "none" : "";
        if (content === undefined || inputs.length === 0) {
            this.replaceChildren();
            if (this.embedded && content)
                this.append(div({ className: style.item }, span("Configuration"), span("Default")));
            return;
        }
        this.replaceChildren(
            ...(this.embedded
                ? []
                : [
                      svg({ className: style.icon, icon: "icon-layer-group" }),
                      span({ className: style.title, textContent: new Localize("configuration.title") }),
                  ]),
            ...inputs
                .filter((item) => configurationVisible(item.visibility, inputs, content.active))
                .map((item) =>
                    div(
                        { className: style.item },
                        span({ className: style.name, textContent: item.name }),
                        activeInputControl(content, item, style.control),
                    ),
                ),
            ...(this.embedded
                ? []
                : [
                      button(
                          {
                              className: style.edit,
                              title: new Localize("configuration.edit"),
                              onclick: () => PubSub.default.pub("editConfiguration", content.document),
                          },
                          svg({ icon: "icon-edit" }),
                      ),
                  ]),
        );
    }
}

customElements.define("chili-configuration-bar", ConfigurationBar);
