// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IPropertyChanged } from "@chili3d/core";
import style from "./propertyBase.module.css";

/** An object a property editor edits: its properties are read and written by name. */
export type PropertyHost = IPropertyChanged & Record<string, unknown>;

/** Views the objects of a selection as property hosts — the one place their shape is opened up. */
export function asPropertyHosts(objects: readonly object[]): readonly PropertyHost[] {
    return objects as readonly PropertyHost[];
}

export abstract class PropertyBase<T extends object = PropertyHost> extends HTMLElement {
    constructor(readonly objects: readonly T[]) {
        super();
        this.className = style.panel;
        if (objects.length === 0) {
            throw new Error(`there are no objects`);
        }
    }
}
