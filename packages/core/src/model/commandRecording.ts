// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import {
    ArrayRecord,
    type HistoryAction,
    type IHistoryRecord,
    NodeLinkedListHistoryRecord,
    type NodeRecord,
    PropertyHistoryRecord,
} from "../foundation/history";
import { Id } from "../foundation/id";
import { Result } from "../foundation/result";
import { Transaction } from "../foundation/transaction";
import { I18n } from "../i18n";
import type { VariableData } from "../parameters/variableData";
import { InternalClassName, type Serialized, Serializer } from "../serialize";
import { type INode, type INodeLinkedList, NodeUtils } from "./node";

/**
 * Command recording: while it is on, every completed modeling step of a document (one undo
 * step — a command's transaction, a property edit, a SET) is captured as the change it made
 * to the document — nodes added (serialized, with their parameters and stored references),
 * properties set, nodes moved or removed, variables written — and kept in the document's
 * `userData`, so the recording is saved and reloaded with it. Replaying applies those changes
 * again as ONE transaction. Undo, redo, selection, queries and previews never enter it.
 *
 * It records results, not the interactive pick sequence: a tool's picks end up as the stored
 * references of the node it created (`EdgeRef`, `ProfileRef`, node ids), which are exactly
 * what replay needs to rebuild equivalent geometry.
 */
export const COMMAND_RECORDING_KEY = "commandRecording";

/** The parent id of a node added directly under the document's root. */
export const RECORDED_ROOT = "$root";

export type RecordedChange =
    | {
          readonly kind: "add";
          /** The parent's id, or `RECORDED_ROOT`. */
          readonly parentId: string;
          /** The sibling the node follows; none = first child. */
          readonly previousId?: string;
          /** The node, then its new descendants in preorder, each child with a `parentId`. */
          readonly nodes: Serialized[];
      }
    | { readonly kind: "set"; readonly nodeId: string; readonly property: string; readonly value: unknown }
    | { readonly kind: "remove"; readonly nodeId: string }
    | {
          readonly kind: "move";
          readonly nodeId: string;
          readonly parentId: string;
          readonly previousId?: string;
      }
    | { readonly kind: "variables"; readonly upserts: VariableData[]; readonly removed: string[] }
    | { readonly kind: "configuration"; readonly json: string };

export interface RecordedStep {
    /** The undo step's name (the command or transaction). */
    readonly name: string;
    /** Epoch milliseconds. */
    readonly time: number;
    readonly changes: RecordedChange[];
    /** What the step changed that the recording cannot reproduce (replay skips it). */
    readonly unsupported: string[];
}

export interface CommandRecordingData {
    readonly version: 1;
    readonly steps: RecordedStep[];
}

export interface ReplaySummary {
    readonly steps: number;
    readonly added: number;
    readonly edited: number;
    readonly moved: number;
    readonly removed: number;
    readonly variables: number;
    /** Changes that could not be applied, and why. */
    readonly skipped: string[];
}

/** Undo steps that are not modeling: selection, timeline grouping, review comments. */
function isIgnoredLeaf(name: string): boolean {
    return name === "selection.clear" || name.startsWith("timeline:") || /review comment$/.test(name);
}

function leaves(record: IHistoryRecord, out: IHistoryRecord[] = []): IHistoryRecord[] {
    if (record instanceof ArrayRecord) {
        for (const child of record.records) leaves(child, out);
    } else {
        out.push(record);
    }
    return out;
}

function isAttached(document: IDocument, node: INode): boolean {
    const root = document.modelManager.rootNode;
    let current: INode | undefined = node;
    while (current !== undefined) {
        if (current === root) return true;
        current = current.parent;
    }
    return false;
}

function parentIdOf(document: IDocument, parent: INodeLinkedList | undefined): string {
    return parent === undefined || parent === document.modelManager.rootNode ? RECORDED_ROOT : parent.id;
}

function parseVariables(json: unknown): VariableData[] {
    if (typeof json !== "string" || json === "") return [];
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function variableChange(before: unknown, after: readonly VariableData[]): RecordedChange | undefined {
    const old = new Map(parseVariables(before).map((item) => [item.name, JSON.stringify(item)]));
    const upserts = after.filter((item) => old.get(item.name) !== JSON.stringify(item));
    const names = new Set(after.map((item) => item.name));
    const removed = [...old.keys()].filter((name) => !names.has(name));
    if (upserts.length === 0 && removed.length === 0) return undefined;
    return { kind: "variables", upserts: upserts.map((item) => ({ ...item })), removed };
}

const SKIPPED_SERIALIZED_KEYS = new Set(["id", InternalClassName]);

/**
 * The modeling change one completed undo step made, or undefined when it changed nothing a
 * recording keeps (a selection, a timeline group, a review comment).
 */
export function captureHistoryStep(document: IDocument, record: IHistoryRecord): RecordedStep | undefined {
    const changes: RecordedChange[] = [];
    const unsupported: string[] = [];
    try {
        const nodeRecords = new Map<INode, NodeRecord[]>();
        const sets = new Map<INode, Set<string>>();
        let variablesBefore: unknown;
        let variablesTouched = false;
        let configurationTouched = false;
        for (const leaf of leaves(record)) {
            if (leaf instanceof NodeLinkedListHistoryRecord) {
                for (const nodeRecord of leaf.records) {
                    const list = nodeRecords.get(nodeRecord.node) ?? [];
                    list.push(nodeRecord);
                    nodeRecords.set(nodeRecord.node, list);
                }
            } else if (leaf instanceof PropertyHistoryRecord) {
                const property = String(leaf.property);
                if (leaf.object === document.variables) {
                    if (property === "variablesJson") {
                        if (!variablesTouched) variablesBefore = leaf.oldValue;
                        variablesTouched = true;
                    } else if (property === "configurationJson") {
                        configurationTouched = true;
                    }
                } else if (leaf.object === document.modelManager) {
                    // The active component: where new nodes go, not a change of the model.
                } else if (isNodeLike(leaf.object)) {
                    const properties = sets.get(leaf.object) ?? new Set<string>();
                    properties.add(property);
                    sets.set(leaf.object, properties);
                } else {
                    unsupported.push(`${leaf.object?.constructor?.name ?? "object"}.${property}`);
                }
            } else if (!isIgnoredLeaf(leaf.name)) {
                unsupported.push(leaf.name);
            }
        }

        if (variablesTouched) {
            const change = variableChange(variablesBefore, document.variables.items);
            if (change !== undefined) changes.push(change);
        }
        if (configurationTouched) {
            changes.push({ kind: "configuration", json: document.variables.configurationJson });
        }

        const created = new Set<INode>();
        for (const [node, list] of nodeRecords) {
            const first = list[0].action;
            if (first === "add" || first === "insertAfter" || first === "insertBefore") created.add(node);
        }
        const serializedCache = new Map<INode, Serialized>();
        const serialized = (node: INode) => {
            let data = serializedCache.get(node);
            if (data === undefined) {
                data = Serializer.serializeObject(node);
                serializedCache.set(node, data);
            }
            return data;
        };
        const subtree = (node: INode, parentId: string | undefined, out: Serialized[]) => {
            const data: Serialized = { ...serialized(node) };
            if (parentId !== undefined) data["parentId"] = parentId;
            out.push(data);
            if (NodeUtils.isLinkedListNode(node)) {
                for (let child = node.firstChild; child !== undefined; child = child.nextSibling) {
                    if (created.has(child)) subtree(child, node.id, out);
                }
            }
            return out;
        };
        const root = document.modelManager.rootNode;
        for (const node of NodeUtils.children(root)) {
            const parentId = parentIdOf(document, node.parent);
            const previousId = node.previousSibling?.id;
            if (created.has(node)) {
                if (node.parent !== undefined && created.has(node.parent)) continue;
                changes.push({ kind: "add", parentId, previousId, nodes: subtree(node, undefined, []) });
            } else if (nodeRecords.has(node)) {
                changes.push({ kind: "move", nodeId: node.id, parentId, previousId });
            }
        }
        for (const [node, properties] of sets) {
            if (created.has(node) || !isAttached(document, node)) continue;
            const data = serialized(node);
            for (const property of properties) {
                if (SKIPPED_SERIALIZED_KEYS.has(property) || !(property in data)) continue;
                changes.push({ kind: "set", nodeId: node.id, property, value: data[property] });
            }
        }
        for (const node of nodeRecords.keys()) {
            if (!created.has(node) && !isAttached(document, node)) {
                changes.push({ kind: "remove", nodeId: node.id });
            }
        }
    } catch (error) {
        unsupported.push(`${record.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (changes.length === 0 && unsupported.length === 0) return undefined;
    return { name: record.name, time: Date.now(), changes, unsupported };
}

function isNodeLike(object: unknown): object is INode {
    return (
        typeof object === "object" &&
        object !== null &&
        typeof (object as INode).id === "string" &&
        "parent" in object &&
        "nextSibling" in object
    );
}

/** The document's recording, or an empty one. */
export function readRecording(document: IDocument): CommandRecordingData {
    const data = document.userData?.[COMMAND_RECORDING_KEY] as CommandRecordingData | undefined;
    if (data === undefined || !Array.isArray(data.steps)) return { version: 1, steps: [] };
    return data;
}

/** Stores the recording in the document (saved with it; not an undo step). */
export function writeRecording(document: IDocument, data: CommandRecordingData): void {
    document.userData = { ...document.userData, [COMMAND_RECORDING_KEY]: data };
}

export function clearRecording(document: IDocument): void {
    writeRecording(document, { version: 1, steps: [] });
}

/** Documents being replayed: the replay's own transaction is not recorded again. */
const replaying = new WeakSet<IDocument>();

/** Captures a document's completed undo steps into its recording while started. */
export class CommandRecorder {
    private static readonly recorders = new WeakMap<IDocument, CommandRecorder>();

    static of(document: IDocument): CommandRecorder {
        let recorder = CommandRecorder.recorders.get(document);
        if (recorder === undefined) {
            recorder = new CommandRecorder(document);
            CommandRecorder.recorders.set(document, recorder);
        }
        return recorder;
    }

    private _recording = false;

    private constructor(readonly document: IDocument) {}

    get recording(): boolean {
        return this._recording;
    }

    start(): void {
        if (this._recording) return;
        this._recording = true;
        this.document.history.onChanged(this.handleHistory);
    }

    stop(): void {
        if (!this._recording) return;
        this._recording = false;
        this.document.history.removeChanged(this.handleHistory);
    }

    private readonly handleHistory = (action: HistoryAction, record: IHistoryRecord) => {
        const history = this.document.history;
        if (action !== "add" || history.isUndoing || history.isRedoing || replaying.has(this.document))
            return;
        const step = captureHistoryStep(this.document, record);
        if (step === undefined) return;
        const recording = readRecording(this.document);
        writeRecording(this.document, { version: 1, steps: [...recording.steps, step] });
    };
}

/** The ids of the nodes the steps add, each mapped to a fresh id. */
function remapAddedIds(steps: readonly RecordedStep[]): RecordedStep[] {
    let json = JSON.stringify(steps);
    for (const step of steps) {
        for (const change of step.changes) {
            if (change.kind !== "add") continue;
            for (const node of change.nodes) {
                const id = node["id"];
                if (typeof id === "string" && id !== "") json = json.split(id).join(Id.generate());
            }
        }
    }
    return JSON.parse(json);
}

function findById(document: IDocument, id: string): INode | undefined {
    if (id === RECORDED_ROOT) return document.modelManager.rootNode;
    return document.modelManager.findNode((node) => node.id === id);
}

function asList(node: INode | undefined): INodeLinkedList | undefined {
    return node !== undefined && NodeUtils.isLinkedListNode(node) ? node : undefined;
}

/**
 * Applies the recorded steps to `document` as ONE undoable transaction. Nodes a step added
 * are added again with fresh ids (later steps' references to them follow); edits, moves and
 * removals of nodes the recording did not add apply to the document's node of that id.
 * Changes that cannot apply are skipped and listed in the summary.
 */
export function replayRecording(
    document: IDocument,
    steps: readonly RecordedStep[] = readRecording(document).steps,
): Result<ReplaySummary> {
    if (steps.length === 0) return Result.err("The recording is empty.");
    const remapped = remapAddedIds(steps);
    let added = 0;
    let edited = 0;
    let moved = 0;
    let removed = 0;
    let variables = 0;
    const skipped: string[] = [];
    replaying.add(document);
    try {
        Transaction.execute(document, I18n.translate("commandRecording.replay"), () => {
            for (const step of remapped) {
                for (const reason of step.unsupported) skipped.push(`${step.name}: ${reason}`);
                for (const change of step.changes) {
                    try {
                        const note = applyChange(document, change);
                        if (note !== undefined) skipped.push(`${step.name}: ${note}`);
                        if (change.kind === "add") added += change.nodes.length;
                        else if (change.kind === "set") edited++;
                        else if (change.kind === "move") moved++;
                        else if (change.kind === "remove") removed++;
                        else variables++;
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        skipped.push(`${step.name}: ${change.kind} failed (${message})`);
                    }
                }
            }
        });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    } finally {
        replaying.delete(document);
    }
    return Result.ok({ steps: remapped.length, added, edited, moved, removed, variables, skipped });
}

/** Applies one change; returns a note when it applied only partly, throws when it cannot. */
function applyChange(document: IDocument, change: RecordedChange): string | undefined {
    switch (change.kind) {
        case "add":
            return applyAdd(document, change);
        case "set": {
            const node = findById(document, change.nodeId);
            if (node === undefined) throw new Error(`no node ${change.nodeId}`);
            if (!Serializer.isWritable(node, change.property))
                throw new Error(`${change.property} is read-only`);
            (node as unknown as Record<string, unknown>)[change.property] = Serializer.deserialValue(
                document,
                change.value,
            );
            return undefined;
        }
        case "remove": {
            const node = findById(document, change.nodeId);
            if (node === undefined) throw new Error(`no node ${change.nodeId}`);
            node.parent?.remove(node);
            return undefined;
        }
        case "move": {
            const node = findById(document, change.nodeId);
            const parent = asList(findById(document, change.parentId));
            if (node === undefined || node.parent === undefined) throw new Error(`no node ${change.nodeId}`);
            if (parent === undefined) throw new Error(`no folder ${change.parentId}`);
            const previous =
                change.previousId === undefined ? undefined : findById(document, change.previousId);
            node.parent.move(node, parent, previous?.parent === parent ? previous : undefined);
            return undefined;
        }
        case "variables": {
            const removedNames = new Set(change.removed);
            const items = document.variables.items.filter((item) => !removedNames.has(item.name));
            for (const upsert of change.upserts) {
                const index = items.findIndex((item) => item.name === upsert.name);
                if (index >= 0) items[index] = { ...upsert, id: items[index].id };
                else items.push({ ...upsert });
            }
            document.variables.setItems(items);
            return undefined;
        }
        case "configuration":
            document.variables.configurationJson = change.json;
            return undefined;
    }
}

function applyAdd(document: IDocument, change: Extract<RecordedChange, { kind: "add" }>): string | undefined {
    let note: string | undefined;
    let parent = asList(findById(document, change.parentId));
    if (parent === undefined) {
        parent = document.modelManager.currentNode ?? document.modelManager.rootNode;
        note = `folder ${change.parentId} is gone; added to ${parent.name}`;
    }
    const created = new Map<string, INodeLinkedList>();
    const [top, ...rest] = change.nodes;
    const node = deserializeNode(document, top);
    const previous = change.previousId === undefined ? undefined : findById(document, change.previousId);
    if (previous !== undefined && previous.parent === parent) parent.insertAfter(previous, node);
    else if (change.previousId === undefined) parent.insertAfter(undefined, node);
    else parent.add(node);
    if (NodeUtils.isLinkedListNode(node)) created.set(node.id, node);
    for (const data of rest) {
        const child = deserializeNode(document, data);
        const owner = created.get(String(data["parentId"]));
        if (owner === undefined) throw new Error(`no parent for ${child.name}`);
        owner.add(child);
        if (NodeUtils.isLinkedListNode(child)) created.set(child.id, child);
    }
    return note;
}

function deserializeNode(document: IDocument, data: Serialized): INode {
    const { parentId: _parentId, ...rest } = data;
    return Serializer.deserializeObject(document, rest as Serialized) as INode;
}

const FS_UNITS: Record<string, string> = {
    mm: "millimeter",
    cm: "centimeter",
    m: "meter",
    in: "inch",
    ft: "foot",
    deg: "degree",
    "°": "degree",
    rad: "radian",
};

function featureScriptValue(item: VariableData): string | undefined {
    const match = /^\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*(mm|cm|m|in|ft|deg|°|rad)?\s*$/i.exec(item.expression);
    if (match === null) return undefined;
    const [, number, unit] = match;
    if (item.type === "unitless") return unit === undefined ? number : undefined;
    if (item.type !== "length" && item.type !== "angle") return undefined;
    const fsUnit =
        unit === undefined
            ? item.type === "length"
                ? "millimeter"
                : "degree"
            : FS_UNITS[unit.toLowerCase()];
    return fsUnit === undefined ? undefined : `${number} * ${fsUnit}`;
}

function describeChange(change: RecordedChange): string {
    switch (change.kind) {
        case "add":
            return `add ${change.nodes.map((node) => `${node[InternalClassName]} "${node["name"]}"`).join(", ")}`;
        case "set":
            return `set ${change.property} of ${change.nodeId}`;
        case "remove":
            return `remove ${change.nodeId}`;
        case "move":
            return `move ${change.nodeId}`;
        case "variables":
            return `variables ${change.upserts.map((item) => item.name).join(", ")}`;
        case "configuration":
            return "configuration inputs";
    }
}

/**
 * The recording as a FeatureScript Feature Studio source — best effort. Variable writes with
 * plain values become `setVariable` calls of one recorded feature; every other change is a
 * comment and is listed in `unsupported`. The recording is a diff of Chili3d's node graph
 * (bodies, sketches, features with stored references), and most of those nodes have no
 * faithful FeatureScript counterpart (std has no `fCuboid`, Chili3d's stored references are
 * not FeatureScript queries), so translating them would invent geometry rather than record it.
 */
export function recordingToFeatureScript(steps: readonly RecordedStep[]): {
    source: string;
    unsupported: string[];
} {
    const unsupported: string[] = [];
    const body: string[] = [];
    for (const step of steps) {
        body.push(`        // ${step.name}`);
        for (const reason of step.unsupported) {
            unsupported.push(`${step.name}: ${reason}`);
            body.push(`        // not recorded: ${reason}`);
        }
        for (const change of step.changes) {
            if (change.kind === "variables") {
                for (const item of change.upserts) {
                    const value = featureScriptValue(item);
                    if (value === undefined) {
                        unsupported.push(`${step.name}: variable ${item.name} = ${item.expression}`);
                        body.push(`        // not expressible: #${item.name} = ${item.expression}`);
                    } else {
                        body.push(`        setVariable(context, "${item.name}", ${value});`);
                    }
                }
                for (const name of change.removed) {
                    unsupported.push(`${step.name}: remove variable ${name}`);
                    body.push(`        // not expressible: remove #${name}`);
                }
                continue;
            }
            const text = describeChange(change);
            unsupported.push(`${step.name}: ${text}`);
            body.push(`        // not expressible: ${text.replace(/\n/g, " ")}`);
        }
    }
    const source = [
        "FeatureScript 3083;",
        'import(path : "onshape/std/geometry.fs", version : "3083.0");',
        "",
        "// Recorded in the Chili3d command window. Lines marked 'not expressible' are Chili3d",
        "// node changes with no FeatureScript counterpart; replay them with RECORD replay.",
        'annotation { "Feature Type Name" : "Recorded commands" }',
        "export const recordedCommands = defineFeature(function(context is Context, id is Id, definition is map)",
        "    precondition",
        "    {",
        "    }",
        "    {",
        ...body,
        "    });",
        "",
    ].join("\n");
    return { source, unsupported };
}
