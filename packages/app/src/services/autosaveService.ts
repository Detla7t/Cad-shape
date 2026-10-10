// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    EditorBuffers,
    type IApplication,
    type IDisposable,
    type IDocument,
    type IService,
    type IView,
    Logger,
    PubSub,
} from "@chili3d/core";

/** Idle time after the last change before the recovery save runs. */
export const AUTOSAVE_DELAY_MS = 1500;

/**
 * Recovery saves: every document in use is written to storage shortly after each change —
 * Onshape-style, nothing is lost between explicit saves — while the version history keeps
 * recording microversions as it does. Autosaves publish `documentAutosaved`, not
 * `documentSaved`, so links following a document's branch keep waiting for a deliberate save.
 * Unsaved editor drafts (`EditorBuffers`) are part of the recovery: an edit in a Feature
 * Studio, a document element or an NC program schedules the same save, which stores the drafts
 * with the document, and leaving the page saves what is still pending at once.
 * The `autosave` preference turns it off.
 */
export class AutosaveService implements IService {
    private app?: IApplication;
    private readonly watched = new Map<IDocument, () => void>();
    private readonly timers = new Map<IDocument, ReturnType<typeof setTimeout>>();
    private buffers: IDisposable | undefined;
    /** What each document's stored drafts reflect: its dirty editors and undecided recovered drafts. */
    private readonly draftStates = new Map<IDocument, string>();

    constructor(private readonly delay = AUTOSAVE_DELAY_MS) {}

    register(app: IApplication): void {
        this.app = app;
        Logger.info(`${AutosaveService.name} registed`);
    }

    start(): void {
        PubSub.default.sub("activeViewChanged", this.handleActiveView);
        PubSub.default.sub("documentClosed", this.handleDocumentClosed);
        this.buffers = EditorBuffers.onChanged(this.handleBuffersChanged);
        globalThis.addEventListener?.("pagehide", this.flush);
        for (const document of this.app?.documents ?? []) this.watch(document);
        Logger.info(`${AutosaveService.name} started`);
    }

    stop(): void {
        PubSub.default.remove("activeViewChanged", this.handleActiveView);
        PubSub.default.remove("documentClosed", this.handleDocumentClosed);
        this.buffers?.dispose();
        this.buffers = undefined;
        globalThis.removeEventListener?.("pagehide", this.flush);
        for (const document of [...this.watched.keys()]) this.unwatch(document);
        Logger.info(`${AutosaveService.name} stoped`);
    }

    /** Documents whose changes are being followed. */
    get documents(): IDocument[] {
        return [...this.watched.keys()];
    }

    private readonly handleActiveView = (view: IView | undefined) => {
        if (view !== undefined) this.watch(view.document);
    };

    private readonly handleDocumentClosed = (document: IDocument) => this.unwatch(document);

    /**
     * A draft changed: its document's recovery save carries it. Saves while an editor is dirty
     * (each edit) and once more when the drafts to store change (a commit, a revert, recovered
     * drafts discarded) — not for a clean editor's cursor moves.
     */
    private readonly handleBuffersChanged = (document: IDocument) => {
        if (!this.watched.has(document)) return;
        const dirty = EditorBuffers.dirtyBuffers(document)
            .map((buffer) => `${buffer.node.id}/${buffer.editor}`)
            .sort();
        const state = `${dirty.join()}|${EditorBuffers.recoveredOf(document).length}`;
        const previous = this.draftStates.get(document) ?? "|0";
        this.draftStates.set(document, state);
        if (dirty.length > 0 || state !== previous) this.schedule(document);
    };

    /** Runs every pending recovery save now (the page is going away). */
    readonly flush = () => {
        for (const [document, timer] of [...this.timers]) {
            clearTimeout(timer);
            this.timers.delete(document);
            this.saveNow(document);
        }
    };

    private watch(document: IDocument): void {
        if (this.watched.has(document)) return;
        const listener = () => this.schedule(document);
        document.history.onChanged(listener);
        this.watched.set(document, () => document.history.removeChanged(listener));
    }

    private unwatch(document: IDocument): void {
        this.watched.get(document)?.();
        this.watched.delete(document);
        this.draftStates.delete(document);
        const timer = this.timers.get(document);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(document);
    }

    /** One save per burst of changes: the timer restarts on every change. */
    private schedule(document: IDocument): void {
        if (!Config.instance.preferences.autosave) return;
        const timer = this.timers.get(document);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.set(
            document,
            setTimeout(() => {
                this.timers.delete(document);
                this.saveNow(document);
            }, this.delay),
        );
    }

    private saveNow(document: IDocument): void {
        if (!this.watched.has(document) || !Config.instance.preferences.autosave) return;
        document.save({ auto: true }).catch((error) => {
            Logger.warn(`autosave of ${document.name} failed`, error);
        });
    }
}
