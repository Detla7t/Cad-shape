// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication, IDocument, IView } from "@chili3d/core";
import { createContext, type ReactNode, useContext } from "react";
import { useObservable } from "./observable";

const ApplicationContext = createContext<IApplication | undefined>(undefined);

/** Makes a booted application available to every component below (`useApplication`). */
export function ApplicationProvider(props: { application: IApplication; children?: ReactNode }) {
    return (
        <ApplicationContext.Provider value={props.application}>{props.children}</ApplicationContext.Provider>
    );
}

/** The application of the nearest `ApplicationProvider`; undefined outside one. */
export function useApplication(): IApplication | undefined {
    return useContext(ApplicationContext);
}

/** The view the user works in, following view switches. */
export function useActiveView(): IView | undefined {
    return useObservable(useApplication(), "activeView");
}

/** The document of the active view. */
export function useActiveDocument(): IDocument | undefined {
    return useActiveView()?.document;
}
