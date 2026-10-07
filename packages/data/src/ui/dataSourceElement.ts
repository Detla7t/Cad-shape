// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type INode, registerElementKind, registerElementView } from "@chili3d/core";
import { type DataSourceNode, isDataSourceNode } from "../dataSourceNode";
import { DataSourceView } from "./dataSourceView";

/** Data Sources as document elements: a bottom tab per source, showing its `DataSourceView`. */
export const DATA_SOURCE_ELEMENT_KIND = "dataSource";

registerElementKind({
    kind: DATA_SOURCE_ELEMENT_KIND,
    icon: "icon-layer-group",
    display: "data.source",
    isElement: isDataSourceNode,
    newCommand: "data.newSource",
});

registerElementView(
    DATA_SOURCE_ELEMENT_KIND,
    (node: INode, document: IDocument) => new DataSourceView(node as DataSourceNode, document),
);
