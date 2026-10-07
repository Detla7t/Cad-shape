// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    fileExtension,
    fileFormatById,
    type IApplication,
    type ICommand,
    type IDisposable,
    type IDocument,
    type IFileImporter,
    type ImportFile,
    type INode,
    nextElementName,
    openElement,
    PubSub,
    Result,
    registerFileImporter,
    Transaction,
} from "@chili3d/core";
import { machineProfiles } from "../../model/machine";
import { detectNcDialect, ncDialect } from "../dialects";
import { NC_PROGRAM_ICON, NcProgramNode } from "../ncProgramNode";
// Registers the NC Program element kind and its view.
import "./ncElement";

/** Adds an empty NC Program to the active document (one undo step) and switches to its tab. */
@command({ key: "nc.newProgram", icon: NC_PROGRAM_ICON })
export class NewNcProgramCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const name = nextElementName(document, "NC Program");
        const node = new NcProgramNode({ document, name, fileName: `${name}.nc` });
        Transaction.execute(document, "new NC program", () => {
            document.modelManager.addNode(node);
        });
        openElement(document, node);
    }
}

const baseName = (fileName: string) => {
    const name = fileName.replace(/^.*[\\/]/, "");
    const extension = fileExtension(name);
    return extension === "" ? name : name.slice(0, -extension.length);
};

function uniqueName(document: IDocument, base: string): string {
    const taken = new Set(document.modelManager.findNodes().map((node) => node.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
        const name = `${base} (${n})`;
        if (!taken.has(name.toLowerCase())) return name;
    }
}

/** UTF-8, or Latin-1 for programs from controls that write it (accented comments). */
function decode(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
        return new TextDecoder("latin1").decode(bytes);
    }
}

/**
 * Adds an NC program file as an NC Program element and opens it. Wire EDM programs get a
 * wire EDM machine profile (their UV plane height comes from it); the others start with
 * none, the dialect detected.
 */
export function addNcProgram(
    document: IDocument,
    fileName: string,
    text: string,
    open = true,
): NcProgramNode {
    const dialect = detectNcDialect(text);
    const kind = ncDialect(dialect).machineKind;
    const machineId = kind === "wireEdm" ? (machineProfiles("wireEdm")[0]?.id ?? "") : "";
    const node = new NcProgramNode({
        document,
        name: uniqueName(document, baseName(fileName)),
        fileName: fileName.replace(/^.*[\\/]/, ""),
        source: text,
        dialect: "auto",
        machineId,
    });
    document.modelManager.addNode(node);
    if (open) openElement(document, node);
    PubSub.default.pub("showToast", "toast.nc.imported{0}{1}", node.name, ncDialect(dialect).name);
    return node;
}

/** NC programs (`.nc`, `.ngc`, `.tap`, `.gcode`, `.mpf`, … or G-code by its content) open as NC Program elements. */
export const NC_PROGRAM_IMPORTER: IFileImporter = {
    id: "cam.ncProgram",
    extensions: fileFormatById("nc")?.extensions ?? [".nc"],
    accepts: (file: ImportFile) => file.format.id === "nc",
    import: async (document, file) =>
        Result.ok<INode[]>([addNcProgram(document, file.name, decode(file.bytes))]),
};

let registered: IDisposable | undefined;

/** Registers the importer (idempotent); the handle removes it again. */
export function registerNcProgramImporter(): IDisposable {
    if (registered !== undefined) return registered;
    const handle = registerFileImporter(NC_PROGRAM_IMPORTER);
    registered = {
        dispose: () => {
            handle.dispose();
            registered = undefined;
        },
    };
    return registered;
}

registerNcProgramImporter();
