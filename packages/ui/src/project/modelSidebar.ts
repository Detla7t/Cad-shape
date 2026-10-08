// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IApplication, type IDocument, type IView, PubSub } from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { ConfigurationBar } from "../property/configuration/configurationBar";
import { showConfigurationVisibility } from "../property/configuration/visibilityEditor";
import style from "./modelSidebar.module.css";
import { PartsList } from "./partsList";
import { ProjectView } from "./projectView";
import { SidebarAccordions } from "./sidebarAccordions";
import { ToolBar } from "./toolBar";

/** Onshape-style navigation: configuration choices, modeling features, then their solid results. */
export class ModelSidebar extends HTMLElement {
    private readonly parts = new PartsList();
    private readonly configuration: ConfigurationBar;
    private readonly project: ProjectView;

    constructor(private readonly app: IApplication) {
        super();
        this.className = style.root;
        this.configuration = new ConfigurationBar(app, true);
        this.project = new ProjectView({ className: "", showHeader: false });
        const accordions = new SidebarAccordions(
            [
                { id: "configurations", title: "Configurations", content: this.configuration, weight: 0.15 },
                { id: "features", title: "Features", content: this.project, weight: 0.6 },
                { id: "parts", title: "Parts", content: this.parts, weight: 0.25 },
            ],
            "chili.modelSidebar.v1",
        );
        const edit = document.createElement("button");
        edit.type = "button";
        edit.title = "Edit configurations";
        edit.setAttribute("aria-label", edit.title);
        edit.append(createCadIcon("tables"));
        edit.onclick = () => {
            const model = this.configuration.document;
            if (model) PubSub.default.pub("editConfiguration", model);
        };
        accordions.sections[0].actions.append(edit);
        const menu = document.createElement("select");
        menu.setAttribute("aria-label", "Configuration options");
        menu.title = "Configuration options";
        for (const [value, label] of [
            ["", "▾"],
            ["visibility", "Modify visibility conditions…"],
            ["reset", "Reset to default"],
        ]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            menu.append(option);
        }
        menu.className = style.configurationOptions;
        menu.onchange = () => {
            const model = this.configuration.document;
            if (model && menu.value === "visibility") showConfigurationVisibility(model);
            if (model && menu.value === "reset") model.variables.setActiveConfiguration({});
            menu.value = "";
        };
        accordions.sections[0].actions.append(menu);
        accordions.sections[1].actions.append(new ToolBar(this.project));
        // The accessible section name stays "Parts" while the button reports the live count.
        accordions.sections[2].element.setAttribute("aria-label", "Parts");
        this.parts.onCountChanged = (count) => {
            accordions.sections[2].toggle.textContent = `Parts (${count})`;
        };
        this.append(accordions);
    }

    connectedCallback() {
        PubSub.default.sub("activeViewChanged", this.activeViewChanged);
        PubSub.default.sub("documentClosed", this.documentClosed);
        this.activeViewChanged(this.app.activeView);
    }
    disconnectedCallback() {
        PubSub.default.remove("activeViewChanged", this.activeViewChanged);
        PubSub.default.remove("documentClosed", this.documentClosed);
        this.parts.dispose();
    }
    private readonly activeViewChanged = (view: IView | undefined) => this.parts.setDocument(view?.document);
    private readonly documentClosed = (model: IDocument) => {
        if (model === this.app.activeView?.document) this.parts.setDocument(undefined);
    };
}

customElements.define("chili-model-sidebar", ModelSidebar);
