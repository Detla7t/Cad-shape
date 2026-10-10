// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Act,
    documentConfiguration,
    documentSchemaHeader,
    History,
    type IApplication,
    type IDocument,
    Id,
    type IEventHandler,
    type IHighlighter,
    type IMeshExporter,
    type IPicker,
    type ISelection,
    type IVariableTable,
    type IView,
    type IVisual,
    type IVisualContext,
    ModelManager,
    Observable,
    ObservableCollection,
    prepareDocumentForLoad,
    Result,
    restoreConfiguration,
    type Serialized,
    Signal,
    VariableTable,
} from "@chili3d/core";

/**
 * A document with no views, no scene and no place in the application: what a link loads a
 * source document's snapshot into to rebuild one of its parts. It has the real model tree,
 * variable table and history (so parametric bodies replay their features exactly as when the
 * source is open), a visual that displays nothing, and it never saves.
 */
export class DetachedDocument extends Observable implements IDocument {
    readonly detached = true as const;
    readonly visual: IVisual;
    readonly history = new History();
    readonly selection: ISelection = createNullSelection();
    readonly picker: IPicker = createNullPicker();
    readonly acts = new ObservableCollection<Act>();
    readonly modelManager: ModelManager;
    readonly variables: IVariableTable;
    userData: Record<string, unknown> = {};

    get name(): string {
        return this.getPrivateValue("name");
    }
    set name(value: string) {
        this.setProperty("name", value);
    }

    /**
     * `createVisual` gives the document a real visual (the assembly view's own scene); by
     * default it has one that displays nothing.
     */
    constructor(
        readonly application: IApplication,
        name: string,
        readonly id: string = Id.generate(),
        createVisual?: (document: IDocument) => IVisual,
    ) {
        super();
        this.setPrivateValue("name", name);
        this.modelManager = new ModelManager(this);
        this.variables = new VariableTable(this);
        this.visual = createVisual?.(this) ?? createNullVisual(this);
    }

    serialize(): Serialized {
        return {
            __cla$$__: "Document",
            ...documentSchemaHeader(__APP_VERSION__),
            id: this.id,
            name: this.name,
            models: this.modelManager.serialize(),
            variables: this.variables.items,
            configuration: documentConfiguration(this.variables),
            acts: [],
            userData: this.userData,
        };
    }

    async save(): Promise<void> {}

    async close(): Promise<void> {
        this.dispose();
    }

    override disposeInternal(): void {
        super.disposeInternal();
        this.visual.dispose();
        this.modelManager.dispose();
        this.history.dispose();
        this.variables.dispose();
        this.selection.dispose();
    }

    /** Loads a serialized document (what `Document.serialize` writes) without views. */
    static async load(application: IApplication, serialized: Serialized): Promise<DetachedDocument> {
        const prepared = prepareDocumentForLoad(serialized);
        if (!prepared.isOk) throw new Error(prepared.error.message);
        const data = prepared.value.document;
        const document = new DetachedDocument(application, data["name"] ?? "", data["id"]);
        document.history.disabled = true;
        try {
            restoreConfiguration(document.variables, data["configuration"]);
            document.variables.setItems(data["variables"] ?? []);
            if (data["userData"]) document.userData = data["userData"];
            await document.modelManager.deserialize(data["models"]);
            return document;
        } catch (error) {
            document.dispose();
            throw error;
        }
    }
}

export function isDetachedDocument(document: IDocument | undefined): boolean {
    return (document as { detached?: boolean } | undefined)?.detached === true;
}

function createNullContext(): IVisualContext {
    return {
        shapeCount: 0,
        addVisualObject: () => {},
        boundingBoxIntersectFilter: () => [],
        removeVisualObject: () => {},
        addNode: () => {},
        removeNode: () => {},
        getVisual: () => undefined,
        getNode: () => undefined,
        redrawNode: () => {},
        setVisible: () => {},
        setNodeOnTop: () => {},
        visuals: () => [],
        displayMesh: () => 0,
        setMeshColor: () => {},
        removeMesh: () => {},
        displayInstancedMesh: () => 0,
        displayLineSegments: () => 0,
        setPosition: () => {},
        setInstanceMatrix: () => {},
        dispose: () => {},
    };
}

const nullHandler = (): IEventHandler => ({
    isEnabled: false,
    pointerMove: () => {},
    pointerDown: () => {},
    pointerUp: () => {},
    keyDown: () => {},
    dispose: () => {},
});

function createNullVisual(document: IDocument): IVisual {
    const highlighter: IHighlighter = {
        getState: () => undefined,
        clear: () => {},
        resetState: () => {},
        addState: () => {},
        removeState: () => {},
        highlightMesh: () => 0,
        removeHighlightMesh: () => {},
    };
    const unsupported = async () => Result.err("A detached document has no visual exporter");
    const meshExporter = {
        exportToStl: unsupported,
        exportToPly: unsupported,
        exportToObj: unsupported,
        exportToGltf: unsupported,
    } as unknown as IMeshExporter;
    const handler = nullHandler();
    return {
        document,
        context: createNullContext(),
        highlighter,
        meshExporter,
        update: () => {},
        viewHandler: handler,
        defaultEventHandler: handler,
        eventHandler: handler,
        createView: (): IView => {
            throw new Error("A detached document has no views");
        },
        dispose: () => {},
    };
}

function createNullSelection(): ISelection {
    return {
        onNodeChanged: new Signal(),
        onShapeChanged: new Signal(),
        setSelectedNodes: () => 0,
        setSelectedShapes: () => 0,
        getSelectedNodes: () => [],
        getSelectedNodeLength: () => 0,
        getSelectedShapes: () => [],
        getSelectedVisualNodes: () => [],
        clearSelection: () => {},
        dispose: () => {},
    };
}

function createNullPicker(): IPicker {
    const nothing = async () => [];
    return {
        pickShape: nothing,
        pickNode: nothing,
        pickAsync: async () => {},
    };
}
