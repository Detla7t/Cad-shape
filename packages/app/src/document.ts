// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Act,
    Constants,
    DocumentVersionControl,
    documentConfiguration,
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
    Logger,
    ModelManager,
    Observable,
    ObservableCollection,
    PubSub,
    restoreConfiguration,
    type Serialized,
    Serializer,
    StorageHistoryPersistence,
    type StorageOperation,
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

    static readonly version = __DOCUMENT_VERSION__;

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
            version: __DOCUMENT_VERSION__,
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

    save(): Promise<void> {
        // A later save cannot overtake an earlier one and replace it with an older
        // snapshot. Failure must not poison the queue or lose unsaved history objects.
        const save = this.saveQueue.then(() => this.saveCurrent());
        this.saveQueue = save.catch(() => {});
        return save;
    }

    private async saveCurrent(): Promise<void> {
        if (this._isDisposed) throw new Error("The document is closed");
        if (this.versioningError !== undefined)
            throw new Error("The version history could not be loaded; saving would risk losing it", {
                cause: this.versioningError,
            });
        const data = structuredClone(this.serialize());
        const view = this.application.activeView;
        const image = view?.document === this ? view.toImage() : undefined;
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
        if (!this._isDisposed) PubSub.default.pub("documentSaved", this);
    }

    async close() {
        if (window.confirm(I18n.translate("prompt.saveDocument{0}", this.name))) {
            await this.save();
        }

        const views = this.application.views.filter((x) => x.document === this);
        this.application.views.remove(...views);
        this.application.activeView = this.application.views.at(0);
        views.forEach((view) => view.dispose());
        this.application.documents.delete(this);

        PubSub.default.pub("documentClosed", this);

        Logger.info(`document: ${this.name} closed`);
        this.dispose();
    }

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
            Logger.info(`document: ${document.name} opened`);
        }
        return document;
    }

    static async load(app: IApplication, data: Serialized): Promise<IDocument | undefined> {
        if ((data as any).version !== __DOCUMENT_VERSION__) {
            alert(
                "The file version has been upgraded, no compatibility treatment was done in the development phase",
            );
            return undefined;
        }
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
