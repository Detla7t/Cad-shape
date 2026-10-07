// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    I18n,
    type I18nKeys,
    type IDisposable,
    type IDocument,
    type INodeWarning,
    type IShape,
    Matrix4,
    property,
    Result,
    ShapeNode,
    serializable,
    serialize,
    Transaction,
} from "@chili3d/core";
import { type ILinkConsumer, type LinkSlot, linkService } from "./linkRegistry";
import {
    describeLinkVersion,
    type LinkState,
    linkKeyOf,
    linkStatusKey,
    type PartLinkData,
    parseLink,
} from "./linkTypes";

export interface LinkedPartNodeOptions {
    document: IDocument;
    link?: PartLinkData;
    /** Serialized form; takes precedence over `link`. */
    linkJson?: string;
    name?: string;
    id?: string;
    materialId?: string;
}

export const LINK_SLOT = "link";

/**
 * A part of ANOTHER document, shown in this one (Onshape's derived part / "insert from another
 * document"). It stores no geometry of its own: `linkJson` names the source document, node and
 * version, and the geometry comes from the link cache keyed by the resolved commit — rebuilt
 * from the source's saved history on demand, kept in IndexedDB and in this document's
 * `.chili3d` file, so a missing source still shows the last geometry (with a broken-link badge).
 *
 * It is a shape node like any other: it can be moved (`transform`), colored, measured,
 * exported, used by booleans or instanced in an assembly.
 */
@serializable()
export class LinkedPartNode extends ShapeNode implements ILinkConsumer, INodeWarning {
    private _state: LinkState = { status: "pending" };
    private readonly _registration: IDisposable | undefined;
    private _shownKey: string | undefined;

    constructor(options: LinkedPartNodeOptions) {
        super({
            document: options.document,
            name: options.name ?? options.link?.nodeName,
            id: options.id,
            materialId: options.materialId,
        });
        this.setPrivateValue("linkJson", options.linkJson ?? JSON.stringify(options.link ?? {}));
        this._registration = linkService()?.register(this);
        this.showCached();
    }

    override display(): I18nKeys {
        return "link.linkedPart";
    }

    override get icon(): string {
        return "icon-share";
    }

    @serialize()
    get linkJson(): string {
        return this.getPrivateValue("linkJson");
    }
    set linkJson(value: string) {
        this.setProperty("linkJson", value, () => this.onLinkChanged());
    }

    /** The link, or undefined when the stored JSON is not one. */
    get link(): PartLinkData | undefined {
        return parseLink(this.linkJson);
    }

    get linkState(): LinkState {
        return this._state;
    }

    @property("link.source")
    get sourceLabel(): string {
        const link = this.link;
        if (link === undefined) return "";
        return `${link.documentName ?? link.documentId} › ${link.nodeName ?? link.nodeId}`;
    }

    @property("link.version")
    get versionLabel(): string {
        const link = this.link;
        return link === undefined ? "" : describeLinkVersion(link);
    }

    @property("link.status")
    get statusLabel(): string {
        const state = this._state;
        const base = I18n.translate(linkStatusKey(state));
        const detail = state.update?.label ?? state.message;
        return detail === undefined ? base : `${base}: ${detail}`;
    }

    // ------------------------------------------------------------------ INodeWarning

    get warningCount(): number {
        return this._state.status === "broken" ||
            this._state.status === "error" ||
            this._state.status === "updateAvailable"
            ? 1
            : 0;
    }

    get warningTooltip(): I18nKeys {
        return this._state.status === "updateAvailable" ? "link.updateAvailable" : "link.broken";
    }

    // ------------------------------------------------------------------ ILinkConsumer

    get attached(): boolean {
        let node = this.parent;
        const root = this.document.modelManager.rootNode;
        while (node !== undefined) {
            if (node === root) return true;
            node = node.parent;
        }
        return false;
    }

    linkSlots(): readonly LinkSlot[] {
        const link = this.link;
        return link === undefined ? [] : [{ slotId: LINK_SLOT, link }];
    }

    setLinkState(_slotId: string, state: LinkState): void {
        const previous = this._state;
        this._state = state;
        this.emitPropertyChanged("statusLabel" as keyof this, previous as never);
    }

    applyLink(_slotId: string, link: PartLinkData, message: string): void {
        Transaction.execute(this.document, message, () => {
            this.linkJson = JSON.stringify(link);
            if (link.nodeName !== undefined && this.name === this.link?.nodeName) this.name = link.nodeName;
        });
    }

    linkGeometryChanged(_slotId: string): void {
        this.showCached();
    }

    // ------------------------------------------------------------------ Geometry

    private onLinkChanged(): void {
        if (!this.showCached()) void linkService()?.loadGeometry(this, LINK_SLOT);
    }

    /** Shows the cached geometry of the resolved commit; false when it is not in memory yet. */
    private showCached(): boolean {
        const link = this.link;
        const key = link === undefined ? undefined : linkKeyOf(link);
        if (link === undefined || key === undefined) return false;
        if (key === this._shownKey && this._shape.isOk) return true;
        const resolved = linkService()?.shapesOf(link);
        if (resolved === undefined || resolved.shapes.length === 0) return false;
        const shape = placedShape(
            resolved.shapes,
            resolved.entry.parts.map((p) => p.transform),
        );
        if (shape === undefined) return false;
        this._shownKey = key;
        this.setShape(Result.ok(shape));
        this.document.visual.update();
        return true;
    }

    /** Derived state: recording the shape would let undo replay a disposed kernel shape. */
    protected override setShape(shape: Result<IShape>) {
        const history = this.document.history;
        const disabled = history.disabled;
        history.disabled = true;
        try {
            const previous = this._shape;
            super.setShape(shape);
            if (previous !== this._shape) previous.unchecked()?.dispose();
        } finally {
            history.disabled = disabled;
        }
    }

    override disposeInternal(): void {
        this._registration?.dispose();
        super.disposeInternal();
    }
}

/**
 * One owned shape for a link's solids: a located copy of a single part (the shared cache
 * shape is never handed out), or a compound of the placed parts of a linked assembly.
 */
function placedShape(
    shapes: readonly IShape[],
    transforms: readonly (readonly number[])[],
): IShape | undefined {
    const placed = shapes.map((shape, i) =>
        shape.transformed(Matrix4.fromArray(transforms[i] ?? identity())),
    );
    if (placed.length === 1) return placed[0];
    const combined = shapeFactory.combine(placed);
    for (const x of placed) x.dispose();
    return combined.isOk ? combined.value : undefined;
}

const identity = () => Matrix4.identity().toArray();

export function isLinkedPartNode(node: unknown): node is LinkedPartNode {
    return node instanceof LinkedPartNode;
}
