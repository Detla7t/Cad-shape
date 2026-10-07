// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    fileExtension,
    type IDocument,
    Id,
    type INode,
    type INodeIcon,
    type INodeSceneless,
    Node,
    registerProjectSourceElement,
    serializable,
    serialize,
} from "@chili3d/core";
import type { NcDialectId } from "./program";

export interface NcProgramNodeOptions {
    document: IDocument;
    name?: string;
    id?: string;
    /** The program text. */
    source?: string;
    /** The file it came from, extension included ("Bracket.nc"): the extension is kept on export. */
    fileName?: string;
    /** "auto" or a dialect id. */
    dialect?: NcDialectId | "auto";
    /** The machine profile the program is read for ("" for none). */
    machineId?: string;
}

/**
 * An NC Program: G-code kept in the document as its own element (a tab), read by the NC
 * reader into a backplot beside the Part Studio's viewport. The program text is a recorded
 * property — an edit is one undo step and one version-history change, stored as line
 * deltas — and in a `.chili3d` project it is a plain file under `nc/` with its own
 * extension. The dialect and machine choices are recorded too.
 */
@serializable()
export class NcProgramNode extends Node implements INodeIcon, INodeSceneless {
    get icon(): string {
        return NC_PROGRAM_ICON;
    }

    readonly sceneless = true as const;

    constructor(options: NcProgramNodeOptions) {
        super(options.document, options.name ?? "NC Program", options.id ?? Id.generate());
        this.setPrivateValue("source", options.source ?? "");
        this.setPrivateValue("fileName", options.fileName ?? `${options.name ?? "NC Program"}.nc`);
        this.setPrivateValue("dialect", options.dialect ?? "auto");
        this.setPrivateValue("machineId", options.machineId ?? "");
    }

    @serialize()
    get source(): string {
        return this.getPrivateValue("source");
    }
    set source(value: string) {
        this.setProperty("source", value);
    }

    @serialize()
    get fileName(): string {
        return this.getPrivateValue("fileName");
    }
    set fileName(value: string) {
        this.setProperty("fileName", value);
    }

    @serialize()
    get dialect(): NcDialectId | "auto" {
        return this.getPrivateValue("dialect") ?? "auto";
    }
    set dialect(value: NcDialectId | "auto") {
        this.setProperty("dialect", value);
    }

    @serialize()
    get machineId(): string {
        return this.getPrivateValue("machineId") ?? "";
    }
    set machineId(value: string) {
        this.setProperty("machineId", value);
    }

    /** The file's extension with the dot (".nc" when its name has none). */
    get extension(): string {
        return fileExtension(this.fileName) || ".nc";
    }

    /** The name to save the program under: the element's name with the file's extension. */
    get exportFileName(): string {
        return `${this.name}${this.extension}`;
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}

export function isNcProgramNode(node: INode): node is NcProgramNode {
    return node instanceof NcProgramNode;
}

/** Iconfont key of NC Program tabs and tree items (an SVG symbol, see `ui/ncIcon.ts`). */
export const NC_PROGRAM_ICON = "icon-nc-program";

/** The folder NC programs are written to in a `.chili3d` project. */
export const NC_PROGRAM_FOLDER = "nc/";

// In a `.chili3d` project each program is a plain file under nc/, named after the element.
registerProjectSourceElement({
    className: NcProgramNode.name,
    kind: "ncProgram",
    field: "source",
    folder: NC_PROGRAM_FOLDER,
    extension: ".nc",
    fileName: (node) => {
        const name = typeof node["name"] === "string" ? node["name"] : "program";
        const fileName = typeof node["fileName"] === "string" ? node["fileName"] : "";
        return `${name}${fileExtension(fileName) || ".nc"}`;
    },
});
