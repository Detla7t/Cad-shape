// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Application, CommandService, HotkeyService, ShowPropertyEventHandler } from "@chili3d/app";
import {
    Config,
    Constants,
    I18n,
    type IApplication,
    type IDataExchange,
    type IService,
    type IShapeProvider,
    type IStorage,
    type IVisualFactory,
    type IWindow,
    type Locale,
    Logger,
    registerProjectEntryProvider,
    VERSION_HISTORY_ENTRY_PROVIDER,
} from "@chili3d/core";
import { DefaultDataExchange } from "./defaultDataExchange";
import {
    AssemblyRibbonProfiles,
    CamRibbonProfiles,
    DataRibbonProfiles,
    DefaultRibbon,
    mergeRibbonProfiles,
    ParametricRibbonProfiles,
    type RibbonProfileExtra,
    SheetMetalRibbonProfiles,
} from "./ribbon";

export class AppBuilder {
    protected readonly _inits: (() => Promise<void>)[] = [];
    protected readonly _ribbonExtras: RibbonProfileExtra[] = [];
    /** Run once the application exists (modules that need it — storage, documents — start here). */
    protected readonly _onBuilt: ((app: IApplication) => void | Promise<void>)[] = [];
    protected _storage?: IStorage;
    protected _visualFactory?: IVisualFactory;
    protected _shapeProvider?: IShapeProvider;
    protected _window?: IWindow;

    constructor() {
        this.initI18n();
        this.initConfig();
        this.ensureAPI();
    }

    protected ensureAPI() {
        this._inits.push(async () => {
            Logger.info("initializing api");

            (globalThis as any).Chili3dCore = await import("@chili3d/core");
            (globalThis as any).Chili3dElement = await import("@chili3d/element");
        });
    }

    protected initConfig() {
        Config.instance.init("config");
        return this;
    }

    protected initI18n() {
        this._inits.push(async () => {
            Logger.info("initializing i18n");

            const i18n = await import("@chili3d/i18n");
            for (const key of Object.keys(i18n)) {
                I18n.addLanguage((i18n as { [key: string]: Locale })[key]);
            }
        });
    }

    useIndexedDB() {
        this._inits.push(async () => {
            Logger.info("initializing IndexedDBStorage");

            const db = await import("@chili3d/storage");
            this._storage = new db.IndexedDBStorage();
            await this._storage.createDBIfNeeded(Constants.DBName, [
                Constants.DocumentTable,
                Constants.RecentTable,
                Constants.HistoryTable,
                Constants.LinkCacheTable,
            ]);
        });
        return this;
    }

    useWasmOcc() {
        this._inits.push(async () => {
            Logger.info("initializing wasm occ");

            const wasm = await import("@chili3d/wasm");
            await wasm.initWasm();
            this._shapeProvider = new wasm.OccShapeProvider();
        });
        return this;
    }

    useParametric(): this {
        // Onshape's FeatureScript std library (~1 MB): start fetching now, alongside the rest of startup.
        const onshapeStd = import("@chili3d/onshape-std").then((std) => std.loadOnshapeStd());
        onshapeStd.catch(() => {}); // handled where it is awaited
        this._inits.push(async () => {
            Logger.info("initializing parametric");

            // registers sketch/feature commands, the SketchNode/ParametricBodyNode
            // serializers, and exposes the sketch ribbon contributions
            const parametric = await import("@chili3d/parametric");
            await parametric.initGarlic();
            try {
                parametric.provideOnshapeStd(parametric.onshapeStdFromBundle(await onshapeStd));
                // Parse and instantiate the std once the app is idle, not on the first studio compile.
                whenIdle(() => parametric.warmUpStd());
            } catch (error) {
                parametric.markOnshapeStdUnavailable(error);
                Logger.warn("Onshape's std library is unavailable; Feature Studios cannot evaluate", error);
            }
            this._ribbonExtras.push(
                ...parametric.SketchRibbonProfiles,
                ...ParametricRibbonProfiles,
                ...SheetMetalRibbonProfiles,
            );
        });
        return this;
    }

    /**
     * The CAM module: CAM Studio elements (setups, tools, operations, toolpath preview and
     * posts), the machine library, the post-processors and the operation types. Builds on
     * the parametric module (sketches and sheet metal flat patterns feed 2D operations), so
     * it comes after `useParametric`.
     */
    useCam(): this {
        this._inits.push(async () => {
            Logger.info("initializing cam");

            // CAM kernels call the Rust module synchronously
            const rs = await import("@chili3d/rs");
            await rs.initRust();

            // registers the CAM Studio element and commands, the machine library and the posts;
            // plugins reach the registries (operations, posts, machines) through the global
            const cam = await import("@chili3d/cam");
            (globalThis as any).Chili3dCam = cam;
            this._ribbonExtras.push(...CamRibbonProfiles);
        });
        return this;
    }

    /**
     * Data Sources (`@chili3d/data`): CSV / Excel / ODS / JSON files, SQLite databases, web APIs,
     * databases over HTTP and online sheets as document tables, the `data()` / `lookup()` /
     * `count()` / `sum()` expression functions, and FeatureScript's `getDataTable`. Remote
     * sources set to refresh on open or on an interval are kept fresh while their document is shown.
     */
    useData(): this {
        this._inits.push(async () => {
            Logger.info("initializing data sources");

            const data = await import("@chili3d/data");
            data.startDataRefresh();
            this._ribbonExtras.push(...DataRibbonProfiles);
        });
        return this;
    }

    /**
     * Assemblies and cross-document links (`@chili3d/assembly`): the Assembly element, linked
     * parts, the link service following saved source documents, and the `.chili3d` `links/`
     * folder that carries linked geometry.
     */
    useAssembly(): this {
        this._inits.push(async () => {
            Logger.info("initializing assembly");

            const assembly = await import("@chili3d/assembly");
            // Scriptable like the core API (plugins, the console): insert, mate, solve, link.
            (globalThis as Record<string, unknown>)["Chili3dAssembly"] = assembly;
            this._ribbonExtras.push(...AssemblyRibbonProfiles);
            this._onBuilt.push((app) => {
                assembly.installAssembly(app);
            });
        });
        return this;
    }

    /**
     * Drawings and office files: DXF/DWG import (a sketch plus a drawing element), the
     * multiview drawing export, OBJ/glTF/3MF meshes, and document elements (Markdown,
     * Word, OpenDocument, spreadsheets, PDF, images, text) with their viewers. Heavy
     * libraries (LibreDWG, ExcelJS, pdf.js, mammoth, docx, CodeMirror) load on first use.
     */
    useDocuments(): this {
        this._inits.push(async () => {
            Logger.info("initializing documents");

            const documents = await import("@chili3d/documents");
            documents.registerDocumentsModule();
            this._ribbonExtras.push(...documents.DocumentsRibbonProfiles);
        });
        return this;
    }

    useThree(): this {
        this._inits.push(async () => {
            Logger.info("initializing three");

            const three = await import("@chili3d/three");
            this._visualFactory = new three.ThreeVisulFactory((d) => new ShowPropertyEventHandler(d));
        });
        return this;
    }

    useUI(): this {
        this._inits.push(async () => {
            Logger.info("initializing MainWindow");

            const ui = await import("@chili3d/ui");
            const app = document.getElementById("app") as HTMLElement;
            this._window = new ui.MainWindow(await this.getRibbonTabs(), "iconfont.js", app);
        });
        return this;
    }

    async getRibbonTabs() {
        return mergeRibbonProfiles(DefaultRibbon, this._ribbonExtras);
    }

    async build(): Promise<IApplication> {
        // A document's version history travels inside its .chili3d file, under history/.
        registerProjectEntryProvider(VERSION_HISTORY_ENTRY_PROVIDER);
        for (const init of this._inits) {
            await init();
        }
        this.ensureNecessary();

        const app = this.createApp();
        for (const onBuilt of this._onBuilt) {
            await onBuilt(app);
        }
        await this._window?.init(app);
        await this.loadDefaultPlugins(app);

        Logger.info("Application build completed");

        return app;
    }

    protected async loadDefaultPlugins(app: IApplication) {
        const urlObj = new URL(window.location.href);
        const pathParts = urlObj.pathname
            .split("/")
            .map((x) => x.trim())
            .filter((x) => x.length > 0);
        if (pathParts.at(-1)?.endsWith(".html")) pathParts.pop();
        urlObj.pathname = `${pathParts.join("/")}/`;
        const folderUrl = `${urlObj.href}plugins/`;
        try {
            const response = await fetch(`${folderUrl}plugins.json`);
            if (!response.ok) {
                return;
            }
            const config = await response.json();
            const plugins = config.plugins as string[];
            for (const plugin of plugins ?? []) {
                await app.pluginManager.loadFromUrl(folderUrl + plugin);
            }
        } catch {
            Logger.warn(`Failed to load plugins from folder: ${folderUrl}`);
        }
    }

    createApp() {
        return new Application({
            storage: this._storage!,
            shapeProvider: this._shapeProvider!,
            visualFactory: this._visualFactory!,
            services: this.getServices(),
            mainWindow: this._window,
            dataExchange: this.initDataExchange(),
        });
    }

    initDataExchange(): IDataExchange {
        return new DefaultDataExchange();
    }

    private ensureNecessary() {
        if (this._shapeProvider === undefined) {
            throw new Error("ShapeProvider not set");
        }
        if (this._visualFactory === undefined) {
            throw new Error("VisualFactory not set");
        }
        if (this._storage === undefined) {
            throw new Error("storage has not been initialized");
        }
    }

    protected getServices(): IService[] {
        return [new CommandService(), new HotkeyService()];
    }
}

function whenIdle(task: () => void): void {
    const run = () => {
        try {
            task();
        } catch (error) {
            Logger.warn("FeatureScript std warm-up failed", error);
        }
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 });
    else setTimeout(run, 1000);
}
