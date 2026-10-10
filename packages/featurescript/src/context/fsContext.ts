// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DataTable,
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    Plane,
    type Result,
    type ShapeType,
    ShapeTypes,
    type TrackedShape,
    XYZ,
} from "@chili3d/core";
import { FsOpaque, type FsValue, fail } from "../lang/values";
import { makePlaneData, type PlaneData, type Vec3 } from "../std/geometry";
import { fsModelingHost } from "./modelingHost";

/**
 * The FeatureScript modeling `Context`: the bodies a feature run has built so far.
 *
 * Every body carries one attribute per sub-shape (faces, edges, vertices — aligned with
 * `findSubShapes` order). Attributes are what queries resolve against and are what
 * makes them survive later operations: an operation that rebuilds a body copies each
 * output entity's attribute from the input entity the kernel history (completed by
 * geometric identity) says it derives from, so `qCreatedBy(id + "extrude1", FACE)`
 * still finds the extrude's faces after a fillet, and a transient query handed out by
 * `evaluateQuery` follows its entity through modifications.
 *
 * Lengths here are kernel millimetres; the FeatureScript side converts at the boundary
 * (`MM_PER_METER`).
 */

export const MM_PER_METER = 1000;

/** `createdBy` of the host body's input — what `qHostBody()` names. */
export const HOST_ID = "_input";

export type EntityKind = "BODY" | "FACE" | "EDGE" | "VERTEX";
export type BodyKind = "SOLID" | "SHEET" | "WIRE" | "POINT";
/** Std's `BodyType`: the geometric kinds plus the bodies that carry no geometry of their own. */
export type BodyType = BodyKind | "MATE_CONNECTOR" | "COMPOSITE";
export type CapKind = "START" | "END";

/** A mate connector's coordinate system (meters) and what it belongs to. */
export interface MateConnectorData {
    readonly origin: Vec3;
    readonly xAxis: Vec3;
    readonly zAxis: Vec3;
    /** Body serial of the owner part, if any. */
    readonly owner?: number;
    /** Body serial of what the connector follows through transforms. */
    readonly attachedTo?: number;
}

/** A composite part: a grouping of other bodies (by body serial). */
export interface CompositeData {
    /** A closed composite consumes its constituents (`qConsumed`). */
    readonly closed: boolean;
    members: number[];
}

export interface EntityAttribute {
    /** Stable per-run serial — what a transient query names. Inherited through history. */
    readonly serial: number;
    /** `/`-joined Id of the operation that created the entity. */
    readonly createdBy: string;
    readonly cap?: CapKind;
    /** Index of the host body's input sub-shape this entity derives from (stable-id tracking). */
    readonly hostIndex?: number;
    /** The sketch entity id an edge (or a sketch point vertex) was drawn as. */
    readonly sketchEntity?: string;
    /** Nesting depth of a sketch region (0 = not inside another region). */
    readonly regionDepth?: number;
}

/** One `findSubShapes` kind of a body, enumerated once per shape revision. */
interface SubShapeCache {
    faces?: IFace[];
    edges?: IEdge[];
    vertices?: IVertex[];
}

export class FsBody {
    private _shape: IShape;
    private cache: SubShapeCache = {};
    faceAttrs: EntityAttribute[] = [];
    edgeAttrs: EntityAttribute[] = [];
    vertexAttrs: EntityAttribute[] = [];
    /** Display name set through `setProperty(... PropertyType.NAME ...)`. */
    name?: string;

    constructor(
        readonly context: FsContext,
        readonly key: number,
        shape: IShape,
        readonly bodyAttr: EntityAttribute,
        public kind: BodyKind,
        readonly flags: {
            construction?: boolean;
            sketch?: boolean;
            plane?: PlaneData;
            defaultGeometry?: boolean;
            mateConnector?: MateConnectorData;
            composite?: CompositeData;
        },
    ) {
        this._shape = shape;
    }

    get shape(): IShape {
        return this._shape;
    }

    /** Replaces the geometry; callers set the new attributes right after. */
    setShape(shape: IShape): void {
        this._shape = shape;
        this.cache = {};
        this.kind = bodyKindOf(shape);
    }

    faces(): IFace[] {
        this.cache.faces ??= this.context.track(this._shape.findSubShapes(ShapeTypes.face)) as IFace[];
        return this.cache.faces;
    }

    edges(): IEdge[] {
        this.cache.edges ??= this.context.track(this._shape.findSubShapes(ShapeTypes.edge)) as IEdge[];
        return this.cache.edges;
    }

    vertices(): IVertex[] {
        this.cache.vertices ??= this.context.track(this._shape.findSubShapes(ShapeTypes.vertex)) as IVertex[];
        return this.cache.vertices;
    }

    attrs(kind: Exclude<EntityKind, "BODY">): EntityAttribute[] {
        return kind === "FACE" ? this.faceAttrs : kind === "EDGE" ? this.edgeAttrs : this.vertexAttrs;
    }

    subShapes(kind: Exclude<EntityKind, "BODY">): IShape[] {
        return kind === "FACE" ? this.faces() : kind === "EDGE" ? this.edges() : this.vertices();
    }

    /** The geometry and attributes `ContextSnapshot` captures. */
    state(): BodyState {
        return {
            shape: this._shape,
            kind: this.kind,
            faceAttrs: this.faceAttrs,
            edgeAttrs: this.edgeAttrs,
            vertexAttrs: this.vertexAttrs,
            name: this.name,
        };
    }

    restore(state: BodyState): void {
        if (state.shape !== this._shape) {
            this._shape = state.shape;
            this.cache = {};
        }
        this.kind = state.kind;
        this.faceAttrs = state.faceAttrs;
        this.edgeAttrs = state.edgeAttrs;
        this.vertexAttrs = state.vertexAttrs;
        this.name = state.name;
    }

    /** True for bodies that end up in the feature's output (not sketches, planes or points). */
    get isModelGeometry(): boolean {
        return (
            !this.flags.construction &&
            !this.flags.sketch &&
            this.kind !== "POINT" &&
            this.flags.mateConnector === undefined &&
            this.flags.composite === undefined
        );
    }

    /** Std's `BodyType`: a mate connector or composite part, else the geometric kind. */
    get bodyType(): BodyType {
        if (this.flags.mateConnector !== undefined) return "MATE_CONNECTOR";
        if (this.flags.composite !== undefined) return "COMPOSITE";
        return this.kind;
    }
}

export interface BodyState {
    readonly shape: IShape;
    readonly kind: BodyKind;
    readonly faceAttrs: EntityAttribute[];
    readonly edgeAttrs: EntityAttribute[];
    readonly vertexAttrs: EntityAttribute[];
    readonly name?: string;
}

/** The bodies of a context at one moment — `abortFeature` rolls back to one. */
export interface ContextSnapshot {
    readonly bodies: readonly { readonly body: FsBody; readonly state: BodyState }[];
    /** Lengths of the operation and derivation logs then. */
    readonly operations?: number;
    readonly derivations?: number;
}

/**
 * How an entity came out of an operation: `modify` — the same entity changed (geometry or
 * owner body), keeping its serial; `split` — a piece of an input that got a fresh serial;
 * `merge` — one entity from several inputs; `create` — a new entity made from other ones
 * (a sweep's side face from a profile edge, a pattern copy from its seed).
 */
export type DerivationKind = "modify" | "split" | "merge" | "create";

/** One step of entity history: operation `op` (index into `FsContext.operations`) made `out` from `inputs`. */
export interface Derivation {
    readonly op: number;
    /** Serial of the entity made. */
    readonly out: number;
    /** Serials of the entities it derives from. */
    readonly inputs: readonly number[];
    readonly kind: DerivationKind;
}

export function bodyKindOf(shape: IShape): BodyKind {
    switch (shape.shapeType) {
        case ShapeTypes.solid:
        case ShapeTypes.compoundSolid:
            return "SOLID";
        case ShapeTypes.shell:
        case ShapeTypes.face:
            return "SHEET";
        case ShapeTypes.wire:
        case ShapeTypes.edge:
            return "WIRE";
        case ShapeTypes.vertex:
            return "POINT";
        default: {
            // A compound takes the highest-dimension kind it contains.
            if (shape.findSubShapes(ShapeTypes.solid).length > 0) return "SOLID";
            if (shape.findSubShapes(ShapeTypes.face).length > 0) return "SHEET";
            if (shape.findSubShapes(ShapeTypes.edge).length > 0) return "WIRE";
            return "POINT";
        }
    }
}

/** An entity a query resolved to. `index` is -1 for a body. */
export interface EntityRef {
    readonly body: FsBody;
    readonly kind: EntityKind;
    readonly index: number;
}

export function entityKey(ref: EntityRef): string {
    return `${ref.body.key}:${ref.kind}:${ref.index}`;
}

export function entityAttr(ref: EntityRef): EntityAttribute {
    return ref.kind === "BODY" ? ref.body.bodyAttr : ref.body.attrs(ref.kind)[ref.index];
}

export function entityShape(ref: EntityRef): IShape {
    return ref.kind === "BODY" ? ref.body.shape : ref.body.subShapes(ref.kind)[ref.index];
}

/** The inputs of a history-tracked rebuild: each body's sub-shapes, in kernel order. */
export interface HistorySource {
    /** The body the sub-shapes belong to (an entity changing body counts as modified). */
    readonly body?: FsBody;
    readonly faces: readonly IFace[];
    readonly edges: readonly IEdge[];
    readonly vertices: readonly IVertex[];
    readonly faceAttrs: readonly EntityAttribute[];
    readonly edgeAttrs: readonly EntityAttribute[];
    readonly vertexAttrs: readonly EntityAttribute[];
}

export function historySource(body: FsBody): HistorySource {
    return {
        body,
        faces: body.faces(),
        edges: body.edges(),
        vertices: body.vertices(),
        faceAttrs: body.faceAttrs,
        edgeAttrs: body.edgeAttrs,
        vertexAttrs: body.vertexAttrs,
    };
}

/** Finds a document data table by reference (`findDataTable`); what `getDataTable` reads. */
export type FsDataTableSource = (reference: string) => Result<DataTable>;

/** What a run reports besides geometry. */
export interface FsRunNotes {
    readonly warnings: string[];
    readonly infos: string[];
}

export class FsContext {
    readonly bodies: FsBody[] = [];
    readonly variables = new Map<string, FsValue>();
    /** Names in `variables` that are configuration variables — `getAllVariables` can leave them out. */
    readonly configurationVariables = new Set<string>();
    /** The document's data tables, set by the runner; undefined when the run has no document. */
    dataTables: FsDataTableSource | undefined;
    readonly notes: FsRunNotes = { warnings: [], infos: [] };
    /** Ids (`/`-joined) of the operations that changed geometry, in run order. */
    readonly operations: string[] = [];
    /** Entity history, in run order: what tracking and dependency queries walk. */
    readonly derivations: Derivation[] = [];
    /** Sketches opened by `newSketch` and not yet solved, by Id string. */
    readonly openSketches = new Map<string, unknown>();
    /** Every shape wrapper created during the run; disposed by `dispose` except what is kept. */
    private readonly arena = new Set<IShape>();
    /** Shapes owned by someone else (the host input); never disposed here. */
    private readonly foreign = new Set<IShape>();
    private nextSerial = 1;
    private nextKey = 1;
    readonly value: FsOpaque;

    constructor() {
        this.value = new FsOpaque("Context", this);
        this.addDefaultGeometry();
    }

    static of(value: FsValue): FsContext {
        if (value instanceof FsOpaque && value.payload instanceof FsContext) return value.payload;
        fail(`Expected a Context, got ${value instanceof FsOpaque ? value.typeName : typeof value}`);
    }

    // ------------------------------------------------------------------ Shape lifetime

    /** Registers kernel shapes created during the run for disposal; returns them for chaining. */
    track<T extends IShape | IShape[]>(shapes: T): T {
        for (const shape of Array.isArray(shapes) ? shapes : [shapes]) {
            if (!this.foreign.has(shape)) this.arena.add(shape);
        }
        return shapes;
    }

    /** Disposes every shape of the run except `keep` (and foreign shapes). */
    dispose(keep: readonly IShape[] = []): void {
        const kept = new Set(keep);
        for (const shape of this.arena) {
            if (!kept.has(shape)) shape.dispose();
        }
        this.arena.clear();
    }

    // ------------------------------------------------------------------ Bodies

    newSerial(): number {
        return this.nextSerial++;
    }

    /** The next serial to be handed out: entities with this serial or above are newer. */
    serialMark(): number {
        return this.nextSerial;
    }

    // ------------------------------------------------------------------ History

    /** The log index of operation `opId`, appending it when it is not the latest one. */
    noteOperation(opId: string): number {
        if (this.operations[this.operations.length - 1] !== opId) this.operations.push(opId);
        return this.operations.length - 1;
    }

    /** Records that operation `opId` made the entity with serial `out` from `inputs`. */
    derive(opId: string, out: number, inputs: readonly number[], kind: DerivationKind): void {
        if (inputs.length === 0) return;
        this.derivations.push({ op: this.noteOperation(opId), out, inputs, kind });
    }

    freshAttr(
        createdBy: string,
        extra?: Partial<Omit<EntityAttribute, "serial" | "createdBy">>,
    ): EntityAttribute {
        return { serial: this.newSerial(), createdBy, ...extra };
    }

    /** Adds a body whose every entity is brand new, created by `createdBy`. */
    addBody(
        shape: IShape,
        createdBy: string,
        flags: FsBody["flags"] = {},
        options: { faceExtra?: (index: number) => Partial<EntityAttribute> } = {},
    ): FsBody {
        this.track(shape);
        if (!flags.defaultGeometry) this.noteOperation(createdBy);
        const body = new FsBody(
            this,
            this.nextKey++,
            shape,
            this.freshAttr(createdBy),
            bodyKindOf(shape),
            flags,
        );
        body.faceAttrs = body.faces().map((_, i) => this.freshAttr(createdBy, options.faceExtra?.(i)));
        body.edgeAttrs = body.edges().map(() => this.freshAttr(createdBy));
        body.vertexAttrs = body.vertices().map(() => this.freshAttr(createdBy));
        this.bodies.push(body);
        return body;
    }

    /**
     * Adds the host body's input shape: every entity remembers its input index so the
     * feature can hand stable ids back to the parametric body afterwards. A compound of
     * several solids — the parts a parametric body holds after a pattern, a mirror or a
     * transform copy — enters as one body per solid, the way Onshape's Part Studio lists
     * its parts, so part queries (`EntityType.BODY`) pick single parts; indexes stay
     * those of the whole input.
     */
    addHostBody(shape: IShape): FsBody[] {
        this.foreign.add(shape);
        const parts = hostParts(shape);
        if (parts === undefined) {
            const body = new FsBody(
                this,
                this.nextKey++,
                shape,
                this.freshAttr(HOST_ID),
                bodyKindOf(shape),
                {},
            );
            body.faceAttrs = body.faces().map((_, i) => this.freshAttr(HOST_ID, { hostIndex: i }));
            body.edgeAttrs = body.edges().map((_, i) => this.freshAttr(HOST_ID, { hostIndex: i }));
            body.vertexAttrs = body.vertices().map(() => this.freshAttr(HOST_ID));
            this.bodies.push(body);
            return [body];
        }
        const faces = shape.findSubShapes(ShapeTypes.face);
        const edges = shape.findSubShapes(ShapeTypes.edge);
        const indexIn = (all: IShape[], item: IShape) => all.findIndex((candidate) => candidate.isSame(item));
        const bodies = parts.map((part) => {
            this.track([part]);
            const body = new FsBody(
                this,
                this.nextKey++,
                part,
                this.freshAttr(HOST_ID),
                bodyKindOf(part),
                {},
            );
            body.faceAttrs = body
                .faces()
                .map((face) => this.freshAttr(HOST_ID, { hostIndex: indexIn(faces, face) }));
            body.edgeAttrs = body
                .edges()
                .map((edge) => this.freshAttr(HOST_ID, { hostIndex: indexIn(edges, edge) }));
            body.vertexAttrs = body.vertices().map(() => this.freshAttr(HOST_ID));
            this.bodies.push(body);
            return body;
        });
        for (const face of faces) face.dispose();
        for (const edge of edges) edge.dispose();
        return bodies;
    }

    /** The host entity at `index` of the whole input's enumeration (faces or edges). */
    hostEntity(kind: "FACE" | "EDGE", index: number): EntityRef | undefined {
        for (const body of this.bodies) {
            if (body.bodyAttr.createdBy !== HOST_ID) continue;
            const local = body.attrs(kind).findIndex((attr) => attr.hostIndex === index);
            if (local >= 0) return { body, kind, index: local };
        }
        return undefined;
    }

    /** The host bodies — one per part of the input (see `addHostBody`). */
    hostBodies(): FsBody[] {
        return this.bodies.filter((body) => body.bodyAttr.createdBy === HOST_ID);
    }

    /** Captures every body's geometry and attributes (shapes are immutable, so this is cheap). */
    snapshot(): ContextSnapshot {
        return {
            bodies: this.bodies.map((body) => ({ body, state: body.state() })),
            operations: this.operations.length,
            derivations: this.derivations.length,
        };
    }

    /** Rolls back to a snapshot: later bodies vanish, modified ones get their old geometry back. */
    restore(snapshot: ContextSnapshot): void {
        this.bodies.length = 0;
        for (const { body, state } of snapshot.bodies) {
            body.restore(state);
            this.bodies.push(body);
        }
        if (snapshot.operations !== undefined) this.operations.length = snapshot.operations;
        if (snapshot.derivations !== undefined) this.derivations.length = snapshot.derivations;
    }

    removeBody(body: FsBody): void {
        const index = this.bodies.indexOf(body);
        if (index >= 0) this.bodies.splice(index, 1);
    }

    /**
     * Rebuilds `body` with `result`, inheriting attributes along the kernel history.
     * `sources` lists the history inputs in kernel order (the body itself first, then any
     * tools); entities without an ancestor are created by `createdBy`.
     */
    rebuildBody(
        body: FsBody,
        result: IShape | TrackedShape,
        sources: readonly HistorySource[],
        createdBy: string,
        extra?: { capFaces?: ReadonlySet<number>; startFaces?: ReadonlySet<number> },
    ): void {
        const tracked = isTracked(result) ? result : undefined;
        const shape = tracked?.shape ?? (result as IShape);
        this.track(shape);
        body.setShape(shape);
        const attrs = this.inheritAttributes(body, sources, createdBy, tracked, extra);
        body.faceAttrs = attrs.faces;
        body.edgeAttrs = attrs.edges;
        body.vertexAttrs = attrs.vertices;
        this.derive(createdBy, body.bodyAttr.serial, [body.bodyAttr.serial], "modify");
    }

    /** Adds a body built by a history-tracked operation (the same inheritance as `rebuildBody`). */
    addDerivedBody(
        result: IShape | TrackedShape,
        sources: readonly HistorySource[],
        createdBy: string,
        flags: FsBody["flags"] = {},
        extra?: { capFaces?: ReadonlySet<number>; startFaces?: ReadonlySet<number> },
    ): FsBody {
        const tracked = isTracked(result) ? result : undefined;
        const shape = tracked?.shape ?? (result as IShape);
        this.track(shape);
        const body = new FsBody(
            this,
            this.nextKey++,
            shape,
            this.freshAttr(createdBy),
            bodyKindOf(shape),
            flags,
        );
        const attrs = this.inheritAttributes(body, sources, createdBy, tracked, extra);
        body.faceAttrs = attrs.faces;
        body.edgeAttrs = attrs.edges;
        body.vertexAttrs = attrs.vertices;
        const owners = sources.flatMap((source) => (source.body === undefined ? [] : [source.body]));
        this.derive(
            createdBy,
            body.bodyAttr.serial,
            owners.map((owner) => owner.bodyAttr.serial),
            "create",
        );
        this.bodies.push(body);
        return body;
    }

    private inheritAttributes(
        body: FsBody,
        sources: readonly HistorySource[],
        createdBy: string,
        tracked: TrackedShape | undefined,
        extra?: { capFaces?: ReadonlySet<number>; startFaces?: ReadonlySet<number> },
    ): { faces: EntityAttribute[]; edges: EntityAttribute[]; vertices: EntityAttribute[] } {
        const inputFaces = sources.flatMap((source) => source.faces);
        const inputEdges = sources.flatMap((source) => source.edges);
        const faceAttrs = sources.flatMap((source) => source.faceAttrs);
        const edgeAttrs = sources.flatMap((source) => source.edgeAttrs);
        const outputFaces = body.faces();
        const outputEdges = body.edges();
        const faceMap = fsModelingHost().completeFaceHistory(
            inputFaces,
            outputFaces,
            alignedMap(tracked?.faceMap, outputFaces.length, inputFaces.length),
        );
        const edgeMap = fsModelingHost().completeEdgeHistory(
            inputEdges,
            outputEdges,
            alignedMap(tracked?.edgeMap, outputEdges.length, inputEdges.length),
        );
        const isCap = (i: number) => extra?.capFaces?.has(i) === true || extra?.startFaces?.has(i) === true;
        const faces = this.uniqueSerials(
            faceMap.map((input, i) => {
                if (extra?.capFaces?.has(i)) return this.freshAttr(createdBy, { cap: "END" });
                if (extra?.startFaces?.has(i)) return this.freshAttr(createdBy, { cap: "START" });
                return input >= 0 ? faceAttrs[input] : this.freshAttr(createdBy);
            }),
        );
        const edges = this.uniqueSerials(
            edgeMap.map((input) => (input >= 0 ? edgeAttrs[input] : this.freshAttr(createdBy))),
        );
        const owner = (list: readonly HistorySource[], kind: "faces" | "edges" | "vertices") =>
            list.flatMap((source) => source[kind].map(() => source.body));
        this.recordInheritance(createdBy, {
            output: body,
            outputs: outputFaces,
            attrs: faces,
            inputs: inputFaces,
            inputAttrs: faceAttrs,
            owners: owner(sources, "faces"),
            map: faceMap.map((input, i) => (isCap(i) ? -1 : input)),
            ancestors: tracked?.faceAncestors,
        });
        this.recordInheritance(createdBy, {
            output: body,
            outputs: outputEdges,
            attrs: edges,
            inputs: inputEdges,
            inputAttrs: edgeAttrs,
            owners: owner(sources, "edges"),
            map: edgeMap,
            ancestors: tracked?.edgeAncestors,
        });
        const inherited = this.inheritVertices(body.vertices(), sources, createdBy);
        this.recordInheritance(createdBy, {
            output: body,
            outputs: body.vertices(),
            attrs: inherited.attrs,
            inputs: sources.flatMap((source) => source.vertices),
            inputAttrs: sources.flatMap((source) => source.vertexAttrs),
            owners: owner(sources, "vertices"),
            map: inherited.map,
        });
        return { faces, edges, vertices: inherited.attrs };
    }

    /**
     * Logs how a rebuild's outputs relate to its inputs: a piece of a split input
     * (fresh serial), a merge of several inputs (kernel ancestor pairs), or the input
     * itself modified — changed geometry or moved to another body. Untouched entities
     * (same kernel shape, same body) and brand-new ones are not logged.
     */
    private recordInheritance(
        opId: string,
        step: {
            output: FsBody;
            outputs: readonly IShape[];
            attrs: readonly EntityAttribute[];
            inputs: readonly IShape[];
            inputAttrs: readonly EntityAttribute[];
            owners: readonly (FsBody | undefined)[];
            map: readonly number[];
            ancestors?: readonly number[];
        },
    ): void {
        const merged = new Map<number, Set<number>>();
        const ancestors = step.ancestors ?? [];
        for (let k = 0; k + 1 < ancestors.length; k += 2) {
            const [out, input] = [ancestors[k], ancestors[k + 1]];
            if (out < 0 || out >= step.outputs.length || input < 0 || input >= step.inputAttrs.length)
                continue;
            const set = merged.get(out) ?? new Set<number>();
            set.add(step.inputAttrs[input].serial);
            merged.set(out, set);
        }
        step.outputs.forEach((shape, i) => {
            const input = step.map[i];
            if (input === undefined || input < 0) return;
            const serial = step.attrs[i].serial;
            const source = step.inputAttrs[input].serial;
            const all = merged.get(i);
            if (all !== undefined && all.size > 1) {
                this.derive(opId, serial, [...all], "merge");
            } else if (serial !== source) {
                this.derive(opId, serial, [source], "split");
            } else if (step.owners[input] !== step.output || !shape.isSame(step.inputs[input])) {
                this.derive(opId, serial, [serial], "modify");
            }
        });
    }

    /**
     * A split entity's pieces all derive from one input: the first keeps its serial (and so
     * the transient queries naming it), the rest get fresh ones — a transient id must name
     * exactly one entity.
     */
    private uniqueSerials(attrs: EntityAttribute[]): EntityAttribute[] {
        const used = new Set<number>();
        return attrs.map((attr) => {
            if (!used.has(attr.serial)) {
                used.add(attr.serial);
                return attr;
            }
            return { ...attr, serial: this.newSerial() };
        });
    }

    /**
     * Vertices have no kernel history: a vertex at an input vertex's exact position inherits
     * it. `map` gives each output's input (flat over the sources, -1 = new).
     */
    private inheritVertices(
        vertices: readonly IVertex[],
        sources: readonly HistorySource[],
        createdBy: string,
    ): { attrs: EntityAttribute[]; map: number[] } {
        const inputs: { point: XYZ; attr: EntityAttribute; flat: number }[] = [];
        let flat = 0;
        for (const source of sources) {
            source.vertices.forEach((vertex, i) => {
                const point = safePoint(vertex);
                if (point !== undefined) inputs.push({ point, attr: source.vertexAttrs[i], flat: flat + i });
            });
            flat += source.vertices.length;
        }
        const claimed = new Set<number>();
        const map: number[] = [];
        const attrs = vertices.map((vertex) => {
            const point = safePoint(vertex);
            if (point !== undefined) {
                const index = inputs.findIndex(
                    (input, i) => !claimed.has(i) && input.point.distanceTo(point) < 1e-7,
                );
                if (index >= 0) {
                    claimed.add(index);
                    map.push(inputs[index].flat);
                    return inputs[index].attr;
                }
            }
            map.push(-1);
            return this.freshAttr(createdBy);
        });
        return { attrs, map };
    }

    // ------------------------------------------------------------------ Default geometry

    /** Onshape's default planes and origin: Top (XY), Front (XZ, normal -Y), Right (YZ). */
    private addDefaultGeometry(): void {
        const planes: [string, Vec3, Vec3][] = [
            ["Top", [0, 0, 1], [1, 0, 0]],
            ["Front", [0, -1, 0], [1, 0, 0]],
            ["Right", [1, 0, 0], [0, 1, 0]],
        ];
        for (const [name, normal, x] of planes) {
            const plane = makePlaneData([0, 0, 0], normal, x);
            const face = shapeFactory.rect(toKernelPlane(plane, -50, -50), 100, 100);
            if (!face.isOk) continue;
            this.addBody(face.value, name, { construction: true, plane, defaultGeometry: true });
        }
        const origin = shapeFactory.point({ x: 0, y: 0, z: 0 });
        if (origin.isOk) this.addBody(origin.value, "Origin", { construction: true, defaultGeometry: true });
    }
}

/**
 * The solids of a host input that holds two or more and nothing else; undefined keeps the
 * input whole (a single solid, a sheet, a wire, or a mix with loose faces or edges).
 */
function hostParts(shape: IShape): IShape[] | undefined {
    if (shape.shapeType !== ShapeTypes.compound && shape.shapeType !== ShapeTypes.compoundSolid)
        return undefined;
    const count = (owner: IShape, type: ShapeType) => {
        const items = owner.findSubShapes(type);
        for (const item of items) item.dispose();
        return items.length;
    };
    const solids = shape.findSubShapes(ShapeTypes.solid);
    let solidFaces = 0;
    let solidEdges = 0;
    for (const solid of solids) {
        solidFaces += count(solid, ShapeTypes.face);
        solidEdges += count(solid, ShapeTypes.edge);
    }
    if (
        solids.length < 2 ||
        solidFaces !== count(shape, ShapeTypes.face) ||
        solidEdges !== count(shape, ShapeTypes.edge)
    ) {
        for (const solid of solids) solid.dispose();
        return undefined;
    }
    return solids;
}

function isTracked(value: IShape | TrackedShape): value is TrackedShape {
    return (value as TrackedShape).faceMap !== undefined && (value as TrackedShape).shape !== undefined;
}

/** A kernel map padded/clipped to the output count, with out-of-range inputs dropped. */
function alignedMap(map: readonly number[] | undefined, outputs: number, inputs: number): number[] {
    return Array.from({ length: outputs }, (_, i) => {
        const index = map?.[i] ?? -1;
        return index >= 0 && index < inputs ? index : -1;
    });
}

function safePoint(vertex: IVertex): XYZ | undefined {
    try {
        return vertex.point();
    } catch {
        return undefined;
    }
}

/** A plane (meters) as a kernel `Plane` (mm), with its origin moved by (u, v) mm in-plane. */
export function toKernelPlane(plane: PlaneData, u = 0, v = 0): Plane {
    const y: Vec3 = [
        plane.normal[1] * plane.x[2] - plane.normal[2] * plane.x[1],
        plane.normal[2] * plane.x[0] - plane.normal[0] * plane.x[2],
        plane.normal[0] * plane.x[1] - plane.normal[1] * plane.x[0],
    ];
    const origin = new XYZ(
        plane.origin[0] * MM_PER_METER + plane.x[0] * u + y[0] * v,
        plane.origin[1] * MM_PER_METER + plane.x[1] * u + y[1] * v,
        plane.origin[2] * MM_PER_METER + plane.x[2] * u + y[2] * v,
    );
    return new Plane({
        origin,
        normal: new XYZ(plane.normal[0], plane.normal[1], plane.normal[2]),
        xvec: new XYZ(plane.x[0], plane.x[1], plane.x[2]),
    });
}
