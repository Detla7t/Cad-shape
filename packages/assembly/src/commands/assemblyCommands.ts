// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    download,
    type IApplication,
    type ICommand,
    type IDocument,
    nextElementName,
    openElement,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { AssemblyNode } from "../model/assemblyNode";
import { evaluateAssembly, localAssemblies } from "../model/evaluate";
import { exportAssemblyShapes } from "../model/export";
import { solveAssembly } from "../model/solve";
import { showBomPanel } from "../ui/bomPanel";
import { showInsertDialog } from "../ui/insertDialog";
import { toast } from "../ui/linkUi";
// Registers the assembly element kind and its view.
import "../ui/assemblyElement";

/** The assembly a command acts on: the selected one, else the document's first. */
export function currentAssembly(document: IDocument): AssemblyNode | undefined {
    const selected = document.selection.getSelectedNodes().find((node) => node instanceof AssemblyNode);
    return (selected as AssemblyNode | undefined) ?? localAssemblies(document)[0];
}

/** Adds an Assembly element to the active document (one undo step) and opens its tab. */
@command({ key: "assembly.new", icon: "icon-layer-group" })
export class NewAssemblyCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const assembly = new AssemblyNode({ document, name: nextElementName(document, "Assembly") });
        Transaction.execute(document, "new assembly", () => {
            document.modelManager.addNode(assembly);
        });
        openElement(document, assembly);
    }
}

@command({ key: "assembly.insert", icon: "icon-import" })
export class InsertInstanceCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const assembly = currentAssembly(document);
        if (assembly === undefined) {
            PubSub.default.pub("executeCommand", "assembly.new");
            return;
        }
        openElement(document, assembly);
        showInsertDialog(assembly, document);
    }
}

@command({ key: "assembly.solve", icon: "icon-sync-alt" })
export class SolveAssemblyCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        const assembly = document === undefined ? undefined : currentAssembly(document);
        if (assembly === undefined) return;
        const result = solveAssembly(assembly);
        if (result.failingMates.length > 0) toast("assembly.conflicting{0}", result.failingMates.length);
        else toast("assembly.dof{0}", result.dof);
    }
}

@command({ key: "assembly.bom", icon: "icon-all" })
export class AssemblyBomCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        const assembly = document === undefined ? undefined : currentAssembly(document);
        if (document === undefined || assembly === undefined) return;
        showBomPanel(assembly, document);
    }
}

/** Exports the current assembly as STEP: every instance placed (the tab's own menu has the mesh formats). */
@command({ key: "assembly.export", icon: "icon-export" })
export class ExportAssemblyCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        const assembly = document === undefined ? undefined : currentAssembly(document);
        if (document === undefined || assembly === undefined) return;
        const result = exportAssemblyShapes(evaluateAssembly(document, assembly), ".step");
        if (!result.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", result.error);
            return;
        }
        download([result.value as BlobPart], `${assembly.name}.step`);
        toast("assembly.exported{0}", `${assembly.name}.step`);
    }
}
