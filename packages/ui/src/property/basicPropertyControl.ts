// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Logger, type Property } from "@chili3d/core";
import { CheckProperty } from "./check";
import { ColorProperty } from "./colorProperty";
import { ComboboxProperty } from "./comboboxProperty";
import { InputProperty } from "./input";
import { MaterialProperty } from "./materialProperty";
import { asPropertyHosts } from "./propertyBase";

export function basicPropertyControl(document: IDocument, objs: readonly object[], prop: Property) {
    if (prop === undefined || objs.length === 0) return "";

    if (prop.type === "color") {
        return new ColorProperty(document, objs, prop);
    }

    if (prop.type === "materialId" && canShowMaterialProperty(objs, prop)) {
        return new MaterialProperty(document, objs, prop);
    }

    if (prop.combobox !== undefined) {
        return new ComboboxProperty(document, objs, prop, prop.combobox);
    }

    const value = asPropertyHosts(objs)[0][prop.name];
    if (["object", "string", "number"].includes(typeof value)) {
        return new InputProperty(document, objs, prop);
    }

    if (typeof value === "boolean") {
        return new CheckProperty(document, objs, prop);
    }

    Logger.warn(`Property ${prop.name} not found in ${Object.getPrototypeOf(objs[0]).constructor.name}`);
    return "";
}

function canShowMaterialProperty(objs: readonly object[], prop: Property) {
    if (objs.length === 0) return false;
    if (objs.length === 1) return true;
    const hosts = asPropertyHosts(objs);
    return hosts.every((obj) => obj[prop.name] === hosts[0][prop.name]);
}
