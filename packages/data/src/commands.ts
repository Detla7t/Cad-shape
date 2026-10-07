// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type IApplication,
    type ICommand,
    nextElementName,
    openElement,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { DataSourceNode, dataSourcesOf } from "./dataSourceNode";

/** Adds an empty Data Source to the active document (one undo step) and opens its tab. */
@command({ key: "data.newSource", icon: "icon-layer-group" })
export class NewDataSourceCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const source = new DataSourceNode({ document, name: nextElementName(document, "Data Source") });
        Transaction.execute(document, "new data source", () => document.modelManager.addNode(source));
        openElement(document, source);
    }
}

/** Re-reads every Data Source of the active document; failures show in each source's tab. */
@command({ key: "data.refreshAll", icon: "icon-sync-alt" })
export class RefreshDataSourcesCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const results = await Promise.all(dataSourcesOf(document).map((source) => source.refresh()));
        const failed = results.filter((result) => !result.isOk).length;
        if (failed > 0) PubSub.default.pub("showToast", "data.refreshFailed{0}", failed);
    }
}
