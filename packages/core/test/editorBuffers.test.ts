// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    DocumentElements,
    EDITOR_DRAFTS_KEY,
    EditorBufferRegistry,
    type EditorDraft,
    type EditorDraftData,
    FolderNode,
    type IDocument,
    type IEditorBuffer,
    type IEditorBufferPrompt,
    type INode,
    PubSub,
    type RecoveryDecision,
    Result,
    storedEditorDrafts,
    TextEditorBuffer,
    type UnsavedDecision,
} from "../src";
import { TestDocument } from "../test-utils";

/** An editor whose draft is a string field. */
class FakeBuffer implements IEditorBuffer {
    readonly editor: string;
    draft: string;
    committed: string;
    commits = 0;
    restored: EditorDraftData[] = [];
    fail: string | undefined;

    constructor(
        readonly document: IDocument,
        readonly node: INode,
        text = "saved",
        editor = "fake",
    ) {
        this.editor = editor;
        this.draft = text;
        this.committed = text;
    }

    isDirty(): boolean {
        return this.draft !== this.committed;
    }
    async commit(): Promise<Result<void>> {
        if (this.fail !== undefined) return Result.err(this.fail);
        this.committed = this.draft;
        this.commits++;
        return Result.ok(undefined);
    }
    revert(): void {
        this.draft = this.committed;
    }
    snapshot(): EditorDraftData | undefined {
        return this.isDirty() ? { data: this.draft } : undefined;
    }
    restore(draft: EditorDraftData): void {
        this.restored.push(draft);
        this.draft = draft.data;
    }
}

function promptAnswering(unsaved: UnsavedDecision, recovered: RecoveryDecision = "restore") {
    const calls = { unsaved: [] as string[][], recovered: [] as string[][] };
    const prompt: IEditorBufferPrompt = {
        unsaved: async (buffers) => {
            calls.unsaved.push(buffers.map((buffer) => buffer.node.name));
            return unsaved;
        },
        recovered: async (_document, drafts) => {
            calls.recovered.push(drafts.map((draft) => draft.name));
            return recovered;
        },
    };
    return { prompt, calls };
}

function folder(document: TestDocument, name: string): FolderNode {
    const node = new FolderNode({ document, name });
    document.modelManager.rootNode.add(node);
    return node;
}

function draftOf(node: INode, data: string, editor = "fake"): EditorDraft {
    return { nodeId: node.id, editor, name: node.name, data, savedAt: 1 };
}

describe("EditorBufferRegistry", () => {
    test("tracks registered buffers, their dirty state and tells listeners about each change", () => {
        const registry = new EditorBufferRegistry();
        const document = new TestDocument();
        const node = folder(document, "Notes");
        const seen: IDocument[] = [];
        registry.onChanged((changed) => seen.push(changed));
        const buffer = new FakeBuffer(document, node);
        const registration = registry.register(buffer);
        expect(registry.buffersOf(document)).toEqual([buffer]);
        expect(registry.isDirty(node)).toBe(false);

        buffer.draft = "edited";
        registration.changed();
        expect(registry.isDirty(node)).toBe(true);
        expect(registry.dirtyBuffers(document)).toEqual([buffer]);

        registration.dispose();
        registration.changed();
        expect(registry.buffersOf()).toEqual([]);
        expect(registry.isDirty(node)).toBe(false);
        // register, changed, dispose — nothing after the dispose
        expect(seen).toEqual([document, document, document]);
    });

    test("settle goes ahead without asking when nothing is dirty", async () => {
        const registry = new EditorBufferRegistry();
        const { prompt, calls } = promptAnswering("cancel");
        registry.setPrompt(prompt);
        const document = new TestDocument();
        registry.register(new FakeBuffer(document, folder(document, "A")));
        expect(await registry.settle(registry.buffersOf(document))).toBe(true);
        expect(calls.unsaved).toEqual([]);
    });

    test.each([
        { decision: "save" as const, proceeds: true, draft: "edited", committed: "edited" },
        { decision: "discard" as const, proceeds: true, draft: "saved", committed: "saved" },
        { decision: "cancel" as const, proceeds: false, draft: "edited", committed: "saved" },
    ])("settle: $decision", async ({ decision, proceeds, draft, committed }) => {
        const registry = new EditorBufferRegistry();
        const { prompt, calls } = promptAnswering(decision);
        registry.setPrompt(prompt);
        const document = new TestDocument();
        const clean = new FakeBuffer(document, folder(document, "Clean"));
        const dirty = new FakeBuffer(document, folder(document, "Studio"));
        dirty.draft = "edited";
        registry.register(clean);
        registry.register(dirty);

        expect(await registry.settle(registry.buffersOf(document))).toBe(proceeds);
        expect(calls.unsaved).toEqual([["Studio"]]);
        expect(dirty.draft).toBe(draft);
        expect(dirty.committed).toBe(committed);
        expect(clean.commits).toBe(0);
    });

    test("a failed commit stops the save, keeps the draft and is reported", async () => {
        const registry = new EditorBufferRegistry();
        registry.setPrompt(promptAnswering("save").prompt);
        const document = new TestDocument();
        const failing = new FakeBuffer(document, folder(document, "Sheet"));
        const later = new FakeBuffer(document, folder(document, "Later"));
        failing.draft = later.draft = "edited";
        failing.fail = "disk full";
        registry.register(failing);
        registry.register(later);
        const toasts: unknown[][] = [];
        const onToast = (...args: unknown[]) => toasts.push(args);
        PubSub.default.sub("showToast", onToast);
        try {
            expect(await registry.settle(registry.buffersOf(document))).toBe(false);
        } finally {
            PubSub.default.remove("showToast", onToast);
        }
        expect(failing.isDirty()).toBe(true);
        expect(later.commits).toBe(0);
        expect(toasts).toEqual([["error.default:{0}", "Sheet: disk full"]]);
    });

    test("snapshots hold every dirty draft and the recovered drafts no editor took back", () => {
        const registry = new EditorBufferRegistry();
        const document = new TestDocument();
        const a = folder(document, "A");
        const b = folder(document, "B");
        const c = folder(document, "C");
        const dirty = new FakeBuffer(document, a);
        dirty.draft = "draft A";
        registry.register(dirty);
        registry.register(new FakeBuffer(document, b));
        registry.setRecovered(document, [draftOf(a, "old A"), draftOf(c, "old C")]);

        const snapshots = registry.snapshots(document, 42);
        expect(snapshots).toEqual([
            { nodeId: a.id, editor: "fake", name: "A", savedAt: 42, data: "draft A" },
            draftOf(c, "old C"),
        ]);
        const other = new TestDocument();
        other.id = "other";
        expect(registry.snapshots(other)).toEqual([]);
    });

    test("restore puts each recovered draft back as its editor registers and opens its element", async () => {
        const registry = new EditorBufferRegistry();
        const { prompt, calls } = promptAnswering("save", "restore");
        registry.setPrompt(prompt);
        const document = new TestDocument();
        const open = folder(document, "Open");
        const closed = folder(document, "Closed");
        const gone: EditorDraft = { nodeId: "deleted", editor: "fake", name: "Gone", data: "x", savedAt: 1 };
        const mounted = new FakeBuffer(document, open);
        registry.register(mounted);
        registry.setRecovered(document, [
            { ...draftOf(open, "recovered open"), selection: { anchor: 2, head: 4 } },
            draftOf(closed, "recovered closed"),
            gone,
        ]);
        const opened: INode[] = [];
        const previous = DocumentElements.host;
        DocumentElements.setHost({
            openElement: (_document, node) => {
                opened.push(node);
                return true;
            },
            showPartStudio: () => {},
        });
        try {
            expect(await registry.offerRecovery(document)).toBe("restore");
        } finally {
            DocumentElements.setHost(previous);
        }
        expect(calls.recovered).toEqual([["Open", "Closed"]]);
        expect(mounted.restored).toEqual([{ data: "recovered open", selection: { anchor: 2, head: 4 } }]);
        expect(mounted.isDirty()).toBe(true);
        expect(opened).toEqual([closed]);

        // The closed element's editor mounts later and takes its draft.
        const late = new FakeBuffer(document, closed);
        registry.register(late);
        expect(late.draft).toBe("recovered closed");
        expect(registry.recoveredOf(document)).toEqual([]);
        // A draft for another editor of the same node is not handed to the wrong editor.
        expect(new FakeBuffer(document, closed, "saved", "other").restored).toEqual([]);
    });

    test("discarding recovered drafts forgets them, so the next save drops them", async () => {
        const registry = new EditorBufferRegistry();
        registry.setPrompt(promptAnswering("save", "discard").prompt);
        const document = new TestDocument();
        const node = folder(document, "Studio");
        registry.setRecovered(document, [draftOf(node, "old")]);
        const changed = rs.fn((_document: IDocument) => {});
        registry.onChanged(changed);

        expect(await registry.offerRecovery(document)).toBe("discard");
        expect(registry.recoveredOf(document)).toEqual([]);
        expect(registry.snapshots(document)).toEqual([]);
        expect(changed).toHaveBeenCalledWith(document);
        const buffer = new FakeBuffer(document, node);
        registry.register(buffer);
        expect(buffer.restored).toEqual([]);
        expect(await registry.offerRecovery(document)).toBeUndefined();
    });

    test("without a UI the confirm fallback never discards without an OK", async () => {
        const registry = new EditorBufferRegistry();
        const document = new TestDocument();
        const buffer = new FakeBuffer(document, folder(document, "Notes"));
        buffer.draft = "edited";
        registry.register(buffer);
        const confirm = rs.spyOn(window, "confirm").mockReturnValue(false);
        try {
            expect(await registry.ask([buffer])).toBe("cancel");
            confirm.mockReturnValue(true);
            expect(await registry.ask([buffer])).toBe("discard");
        } finally {
            confirm.mockRestore();
        }
    });

    test("storedEditorDrafts reads well-formed drafts of a stored record only", () => {
        const good = { nodeId: "n", editor: "text", name: "N", data: "x", savedAt: 1 };
        expect(storedEditorDrafts({ [EDITOR_DRAFTS_KEY]: [good, { nodeId: 3 }, null, "x"] })).toEqual([good]);
        expect(storedEditorDrafts({})).toEqual([]);
        expect(storedEditorDrafts(undefined)).toEqual([]);
    });
});

describe("TextEditorBuffer", () => {
    function setup() {
        const document = new TestDocument();
        const node = folder(document, "saved");
        let text = node.name;
        let selection: { anchor: number; head: number } | undefined;
        const changed = rs.fn(() => {});
        const buffer = new TextEditorBuffer({
            document,
            node,
            editor: "text",
            transaction: "edit text",
            read: () => node.name,
            write: (value) => {
                node.name = value;
            },
            text: () => text,
            show: (value, at) => {
                text = value;
                selection = at;
            },
            selection: () => ({ anchor: 1, head: 3 }),
            changed,
        });
        return {
            document,
            node,
            buffer,
            changed,
            type: (value: string) => {
                text = value;
            },
            text: () => text,
            selection: () => selection,
        };
    }

    test("a commit writes the draft as one undo step", async () => {
        const { document, node, buffer, type } = setup();
        type("draft");
        expect(buffer.isDirty()).toBe(true);
        const before = document.history.undoCount();
        expect((await buffer.commit()).isOk).toBe(true);
        expect(node.name).toBe("draft");
        expect(buffer.isDirty()).toBe(false);
        expect(document.history.undoCount()).toBe(before + 1);
        document.history.undo();
        expect(node.name).toBe("saved");
        // A clean commit adds nothing.
        await buffer.commit();
        expect(document.history.undoCount()).toBe(before);
    });

    test("revert drops the draft and shows the node's text", () => {
        const { buffer, type, text, changed } = setup();
        type("draft");
        buffer.revert();
        expect(text()).toBe("saved");
        expect(buffer.isDirty()).toBe(false);
        expect(changed).toHaveBeenCalledTimes(1);
    });

    test("snapshot and restore carry the draft and its selection", () => {
        const { buffer, type, text, selection } = setup();
        expect(buffer.snapshot()).toBeUndefined();
        type("draft");
        const snapshot = buffer.snapshot();
        expect(snapshot).toEqual({ data: "draft", selection: { anchor: 1, head: 3 } });
        buffer.revert();
        buffer.restore(snapshot!);
        expect(text()).toBe("draft");
        expect(selection()).toEqual({ anchor: 1, head: 3 });
        expect(buffer.isDirty()).toBe(true);
    });

    test("a node change is followed by a clean draft and kept out of a dirty one", async () => {
        const { document, node, buffer, type, text } = setup();
        type("draft");
        await buffer.commit();
        document.history.undo();
        expect(buffer.nodeChanged()).toBe(true);
        expect(text()).toBe("saved");
        expect(buffer.isDirty()).toBe(false);

        type("mine");
        document.history.redo();
        expect(buffer.nodeChanged()).toBe(false);
        expect(text()).toBe("mine");
        expect(buffer.saved).toBe("draft");
        expect(node.name).toBe("draft");
    });
});
