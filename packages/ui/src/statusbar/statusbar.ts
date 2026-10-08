// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, I18n, type I18nKeys, Navigation3D, PubSub } from "@chili3d/core";
import { div, label } from "@chili3d/element";
import { DocumentUnitsControl } from "./documentUnits";
import style from "./statusbar.module.css";

export class Statusbar extends HTMLElement {
    private _isDefaultTip = true;

    readonly tip = label({
        textContent: "",
        className: style.tip,
    });

    constructor(className: string) {
        super();
        this.className = `${style.panel} ${className}`;

        this.setDefaultTip();
        this.render();

        PubSub.default.sub("statusBarTip", this.statusBarTip);
        PubSub.default.sub("clearStatusBarTip", this.setDefaultTip);
        Config.instance.onPropertyChanged(this.handleConfigChanged);
    }

    private readonly handleConfigChanged = (prop: keyof Config) => {
        if (prop === "navigation3D" && this._isDefaultTip) {
            this.setDefaultTip();
        }
    };

    private render() {
        this.append(div({ className: style.left }, this.tip), new DocumentUnitsControl());
    }

    private readonly statusBarTip = (tip: I18nKeys) => {
        this._isDefaultTip = false;
        I18n.set(this.tip, "textContent", tip);
        this.tip.title = this.tip.textContent ?? "";
    };

    private readonly setDefaultTip = () => {
        this._isDefaultTip = true;
        const { pan, rotate } = Navigation3D.navigationKeyMap();
        I18n.set(this.tip, "textContent", "prompt.default{0}{1}", pan, rotate);
        this.tip.title = this.tip.textContent ?? "";
    };
}

customElements.define("chili-statusbar", Statusbar);
