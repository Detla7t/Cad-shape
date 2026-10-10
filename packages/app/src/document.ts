// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Act,
    Constants,
    DOCUMENT_SCHEMA_VERSION,
    type DocumentMigrationRegistry,
    DocumentVersionControl,
    documentConfiguration,
    documentMigrations,
    documentSchemaHeader,
    EDITOR_DRAFTS_KEY,
    EditorBuffers,
    History,
    I18n,
    type IApplication,
    type IDocument,
    Id,
    InternalClassName,
    type IPicker,
    type ISelection,
    type IVariableTable,
    type IVisual,
    isCancelableCommand,
    Logger,
    ModelManager,
    Observable,
    ObservableCollection,
    PubSub,
    restoreConfiguration,
    type SaveOptions,
    type Serialized,
    Serializer,
    StorageHistoryPersistence,
    type StorageOperation,
    storedEditorDrafts,
    VariableTable,
    writeStorageBatch,
} from "@chili3d/core";
import { Picker } from "./picker";
import { SelectionManager } from "./selectionManager";

export class Document extends Observable implements IDocument {
    readonly visual: IVisual;
    readonly history: History;
    readonly selection: ISelection;
    readonly picker: IPicker;
    readonly acts = new ObservableCollection<Act>();
    readonly modelManager: ModelManager;
    /** Document-wide parameters shared by every body and sketch. */
    readonly variables: IVariableTable;
    userData: Record<string, unknown> = {};
    private saveQueue: Promise<void> = Promise.resolve();
    private versioningError: unknown;

    /** The document schema this build writes (see `DOCUMENT_SCHEMA_VERSION`). */
    static readonly version = DOCUMENT_SCHEMA_VERSION;

    get name(): string {
        return this.getPrivateValue("name");
    }
    set name(name: string) {
        if (this.name === name) return;
        this.setProperty("name", name);
        if (this.modelManager.rootNode) this.modelManager.rootNode.name = name;
    }

    constructor(
        readonly application: IApplication,
        name: string,
        readonly id: string = Id.generate(),
    ) {
        super();
        this.setPrivateValue("name", name);
        this.modelManager = new ModelManager(this);
        this.history = new History();
        this.variables = new VariableTable(this);
        this.selection = new SelectionManager(this);
        this.picker = new Picker(this);
        this.visual = application.visualFactory.create(this);

        application.documents.add(this);
    }

    serialize(): Serialized {
        const serialized: Serialized = {
            [InternalClassName]: "Document",
            ...documentSchemaHeader(__APP_VERSION__),
            id: this.id,
            name: this.name,
            models: this.modelManager.serialize(),
            variables: this.variables.items,
            acts: this.acts.map((x) => Serializer.serializeObject(x)),
            userData: this.userData,
        };
        // Additive: a document without configurations serializes exactly as before.
        const configuration = documentConfiguration(this.variables);
        if (configuration !== undefined) serialized["configuration"] = configuration;
        return serialized;
    }

    override disposeInternal(): void {
        super.disposeInternal();

        DocumentVersionControl.of(this)?.dispose();
        this.modelManager.dispose();
        this.visual.dispose();
        this.history.dispose();
        this.variables.dispose();
        this.selection.dispose();
        this.acts.forEach((x) => x.dispose());
        this.acts.clear();
    }

    save(options: SaveOptions = {}): Promise<void> {
        // A later save cannot overtake an earlier one and replace it with an older
        // snapshot. Failure must not poison the queue or lose unsaved history objects.
        const save = this.saveQueue.then(() => this.saveCurrent(options.auto === true));
        this.saveQueue = save.catch(() => {});
        return save;
    }

    /**
     * `auto`: a recovery save — the thumbnail is not re-rendered (the last saved one stays)
     * and `documentAutosaved` is published instead of `documentSaved`, so links that follow
     * this document's branch do not advance on every edit.
     */
    private async saveCurrent(auto = false): Promise<void> {
        if (this._isDisposed) throw new Error("The document is closed");
        if (this.versioningError !== undefined)
            throw new Error("The version history could not be loaded; saving would risk losing it", {
                cause: this.versioningError,
            });
        const data = structuredClone(this.serialize());
        // Unsaved editor drafts ride along in the stored record (outside `serialize()`, so they
        // never enter the version history or a project file); reopening offers them back.
        const drafts = EditorBuffers.snapshots(this);
        if (drafts.length > 0) data[EDITOR_DRAFTS_KEY] = drafts;
        const view =
            this.application.activeView?.document === this
                ? this.application.activeView
                : this.application.views.find((item) => item.document === this);
        const previous = async () =>
            (await this.application.storage.get(Constants.DBName, Constants.RecentTable, this.id))?.image;
        const image = view && !auto ? (view.toThumbnail?.() ?? view.toImage()) : await previous();
        const writes: StorageOperation[] = [
            { type: "put", table: Constants.DocumentTable, id: this.id, value: data },
            {
                type: "put",
                table: Constants.RecentTable,
                id: this.id,
                value: {
                    id: this.id,
                    name: data["name"],
                    date: Date.now(),
                    branch: DocumentVersionControl.of(this)?.currentBranch,
                    image,
                },
            },
        ];
        const control = DocumentVersionControl.of(this);
        if (control !== undefined) {
            await control.persist(
                new StorageHistoryPersistence(
                    this.application.storage,
                    Constants.DBName,
                    Constants.HistoryTable,
                    writes,
                ),
            );
        } else {
            await writeStorageBatch(this.application.storage, Constants.DBName, writes);
        }
        if (!this._isDisposed) PubSub.default.pub(auto ? "documentAutosaved" : "documentSaved", this);
    }

    /**
     * Closes the document. Editors holding unsaved edits ask first — Save commits them (one undo
     * step each) and saves the document, Discard drops them and closes without saving, Cancel
     * keeps the document open. Otherwise the save question is asked as before. A close that does
     * not save also drops the drafts stored for recovery, so they are not offered again.
     */
    async close() {
        const running = this.application.executingCommand;
        if (this.application.activeView?.document === this && running && isCancelableCommand(running))
            await running.cancel();
        const dirty = EditorBuffers.dirtyBuffers(this);
        let save: boolean;
        if (dirty.length > 0) {
            const decision = await EditorBuffers.ask(dirty);
            if (decision === "cancel") return;
            if (decision === "save" && !(await EditorBuffers.commitAll(dirty))) return;
            if (decision === "discard") EditorBuffers.revertAll(dirty);
            save = decision === "save";
        } else {
            save = window.confirm(I18n.translate("prompt.saveDocument{0}", this.name));
        }
        if (save) await this.save();
        else await this.dropStoredDrafts();
        EditorBuffers.forget(this);

        const views = this.application.views.filter((x) => x.document === this);
        this.application.views.remove(...views);
        this.application.activeView = this.application.views.at(0);
        views.forEach((view) => view.dispose());
        this.application.documents.delete(this);

        PubSub.default.pub("documentClosed", this);

        Logger.info(`document: ${this.name} closed`);
        this.dispose();
    }

    /** Removes the recovery drafts from the stored record (after the queued saves). */
    private dropStoredDrafts(): Promise<void> {
        const drop = this.saveQueue.then(async () => {
            const storage = this.application.storage;
            const stored = (await storage.get(Constants.DBName, Constants.DocumentTable, this.id)) as
                | Serialized
                | undefined;
            if (stored === undefined || !(EDITOR_DRAFTS_KEY in stored)) return;
            const { [EDITOR_DRAFTS_KEY]: _drafts, ...rest } = stored;
            await storage.put(Constants.DBName, Constants.DocumentTable, this.id, rest);
        });
        this.saveQueue = drop.catch(() => {});
        return drop.catch((error) => Logger.warn(`document: drafts of ${this.name} not dropped`, error));
    }

    /**
     * Opens a stored document. Unsaved editor drafts stored with it are handed to
     * `EditorBuffers`; the application offers them back once the document is shown.
     */
    static async open(application: IApplication, id: string) {
        const data = (await application.storage.get(
            Constants.DBName,
            Constants.DocumentTable,
            id,
        )) as Serialized;
        if (data === undefined) {
            Logger.warn(`document: ${id} not find`);
            return;
        }
        const document = await Document.load(application, data);
        if (document !== undefined) {
            EditorBuffers.setRecovered(document, storedEditorDrafts(data));
            Logger.info(`document: ${document.name} opened`);
        }
        return document;
    }

    /**
     * Loads a serialized document, migrated to the current schema first. A document this build
     * cannot read — above all one saved with a newer schema — is refused with a message and
     * nothing loads, so it can never be saved back over in an older format. `migrations` is the
     * application's registry unless a test supplies its own.
     */
    static async load(
        app: IApplication,
        serialized: Serialized,
        migrations: DocumentMigrationRegistry = documentMigrations,
    ): Promise<IDocument | undefined> {
        const prepared = migrations.prepare(serialized);
        if (!prepared.isOk) {
            Logger.warn(`document: ${prepared.error.message}`);
            alert(prepared.error.message);
            return undefined;
        }
        const data = prepared.value.document;
        if (prepared.value.applied.length > 0)
            Logger.info(
                `document: upgraded from schema ${prepared.value.fromVersion}`,
                prepared.value.applied,
            );
        const document = new Document(app, data["name"], data["id"]);
        document.history.disabled = true;
        // Before the models: a body's feature chain resolves its parameters against
        // the scope — the configuration and the table — and deserializing a body rebuilds it.
        restoreConfiguration(document.variables, data["configuration"]);
        document.variables.setItems(data["variables"] ?? []);
        document.acts.push(...data["acts"].map((x: Serialized) => Serializer.deserializeObject(document, x)));
        if (data["userData"]) {
            document.userData = data["userData"];
        }

        await document.modelManager.deserialize(data["models"]);
        document.history.disabled = false;
        await Document.startVersioning(document);
        return document;
    }

    /**
     * Puts a document under version control: its saved history is loaded (a document without
     * one starts with an initial commit) and every later change is captured as a microversion.
     */
    static async startVersioning(document: IDocument): Promise<void> {
        try {
            await DocumentVersionControl.attach(document, {
                persistence: new StorageHistoryPersistence(document.application.storage),
            });
            if (document instanceof Document) document.versioningError = undefined;
        } catch (error) {
            if (document instanceof Document) document.versioningError = error;
            Logger.warn(`version control could not start for ${document.name}`, error);
        }
    }
}
