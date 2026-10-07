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
    VariableTable,
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

    async save() {
        const data = this.serialize();
        await this.application.storage.put(Constants.DBName, Constants.DocumentTable, this.id, data);
        // The version history is saved with the document — never ahead of it.
        await DocumentVersionControl.of(this)?.persist();
        const image = this.application.activeView?.toImage();
        await this.application.storage.put(Constants.DBName, Constants.RecentTable, this.id, {
            id: this.id,
            name: this.name,
            date: Date.now(),
            image,
        });
    }

    async close() {
        if (window.confirm(I18n.translate("prompt.saveDocument{0}", this.name))) {
            await this.save();
        }

        const views = this.application.views.filter((x) => x.document === this);
        this.application.views.remove(...views);
        this.application.activeView = this.application.views.at(0);
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
        } catch (error) {
            Logger.warn(`version control could not start for ${document.name}`, error);
        }
    }
}
