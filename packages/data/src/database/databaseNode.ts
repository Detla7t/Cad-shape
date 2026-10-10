// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    Id,
    type INode,
    type INodeIcon,
    type INodeSceneless,
    Node,
    serializable,
    serialize,
} from "@chili3d/core";

export interface DatabaseNodeOptions {
    document: IDocument;
    name?: string;
    fileName?: string;
    /** The SQLite file. */
    bytes?: Uint8Array;
    id?: string;
}

/**
 * A SQLite database kept in the document — the database manager's element (Onshape has no
 * equivalent; LibreOffice Base does). The file travels base64 in `content`, a recorded
 * property, so a save of the manager's edits is one undo step.
 */
@serializable({ id: "DatabaseNode" })
export class DatabaseNode extends Node implements INodeIcon, INodeSceneless {
    readonly sceneless = true as const;
    readonly icon = "icon-layer-group";

    constructor(options: DatabaseNodeOptions) {
        super(options.document, options.name ?? "Database", options.id ?? Id.generate());
        this.setPrivateValue("fileName", options.fileName ?? `${options.name ?? "Database"}.sqlite`);
        this.setPrivateValue("content", options.bytes === undefined ? "" : toBase64(options.bytes));
    }

    @serialize()
    get fileName(): string {
        return this.getPrivateValue("fileName");
    }
    set fileName(value: string) {
        this.setProperty("fileName", value);
    }

    /** The file, base64. */
    @serialize()
    get content(): string {
        return this.getPrivateValue("content");
    }
    set content(value: string) {
        this.setProperty("content", value);
    }

    get bytes(): Uint8Array {
        return fromBase64(this.content);
    }

    get size(): number {
        return this.bytes.length;
    }

    setBytes(bytes: Uint8Array): void {
        this.content = toBase64(bytes);
    }

    protected onVisibleChanged(): void {}
    protected onParentVisibleChanged(): void {}
}

export function isDatabaseNode(node: INode): node is DatabaseNode {
    return node instanceof DatabaseNode;
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
    if (text === "") return new Uint8Array();
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
