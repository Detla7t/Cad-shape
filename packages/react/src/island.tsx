// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication, IDisposable } from "@chili3d/core";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApplicationProvider } from "./application";

/**
 * A React tree living inside the custom-element UI — the way legacy panels are converted one
 * at a time: the element keeps its place in the old layout, its content becomes a component.
 */
export interface ReactIsland extends IDisposable {
    render(node: ReactNode): void;
}

export function mountIsland(host: Element, node: ReactNode, application?: IApplication): ReactIsland {
    const root: Root = createRoot(host);
    const wrap = (content: ReactNode) =>
        application === undefined ? (
            content
        ) : (
            <ApplicationProvider application={application}>{content}</ApplicationProvider>
        );
    root.render(wrap(node));
    return {
        render: (next) => root.render(wrap(next)),
        dispose: () => root.unmount(),
    };
}
