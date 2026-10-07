// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IApplication, registerProjectEntryProvider } from "@chili3d/core";
import { linkService, setLinkService } from "./link/linkRegistry";
import { createLinksEntryProvider } from "./link/linksEntryProvider";
import { PartLinkService } from "./link/partLinkService";
import "./versioning";
import "./commands/assemblyCommands";
import "./commands/linkCommands";

export * from "./commands/assemblyCommands";
export * from "./commands/linkCommands";
export * from "./link/detachedDocument";
export * from "./link/importSource";
export * from "./link/linkCache";
export * from "./link/linkedPartNode";
export * from "./link/linkRegistry";
export * from "./link/linksEntryProvider";
export * from "./link/linkTypes";
export * from "./link/partLinkService";
export * from "./link/sourceHistory";
export * from "./math/rigid";
export * from "./model/assemblyNode";
export * from "./model/assemblyTypes";
export * from "./model/bom";
export * from "./model/connectors";
export * from "./model/evaluate";
export * from "./model/export";
export * from "./model/insert";
export * from "./model/solve";
export * from "./solver/mateSolver";
export { ASSEMBLY_KIND } from "./ui/assemblyElement";

/**
 * Starts the assembly module for an application: the link service (reading link sources
 * from the application's storage and following their saves) and the `.chili3d` `links/`
 * folder. Returns the service; calling it again returns the installed one.
 */
export function installAssembly(application: IApplication): PartLinkService {
    const installed = linkService();
    if (installed instanceof PartLinkService) return installed;
    const service = new PartLinkService({ storage: application.storage, application });
    setLinkService(service);
    registerProjectEntryProvider(createLinksEntryProvider(() => linkService()));
    return service;
}
