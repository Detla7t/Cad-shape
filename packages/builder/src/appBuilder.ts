// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Application,
    AutosaveService,
    CommandService,
    HotkeyService,
    installDiagnostics,
    ShowPropertyEventHandler,
} from "@chili3d/app";
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
    PubSub,
    registerProjectEntryProvider,
    VERSION_HISTORY_ENTRY_PROVIDER,
} from "@chili3d/core";
import { DefaultDataExchange } from "./defaultDataExchange";
import {
    AssemblyRibbonProfiles,
    CamRibbonProfiles,
    DataRibbonProfiles,
    DefaultRibbon,
    FabricationRibbonProfiles,
    mergeRibbonProfiles,
    ParametricRibbonProfiles,
    type RibbonProfileExtra,
    SheetMetalRibbonProfiles,
} from "./ribbon";

export class AppBuilder {
    protected readonly _inits: (() => Promise<void>)[] = [];
    /** The module each init belongs to, for the failure report. */
    private readonly _initNames = new WeakMap<() => Promise<void>, string>();
    /** Modules that failed to load or initialize; the rest of the suite runs without them. */
    readonly moduleFailures: ModuleFailure[] = [];

    /** Registers a module's init under its name. */
    protected init(name: string, run: () => Promise<void>): void {
        this._inits.push(run);
        this._initNames.set(run, name);
    }
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
        this.init("api", async () => {
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
        this.init("i18n", async () => {
            Logger.info("initializing i18n");

            const i18n = await import("@chili3d/i18n");
            for (const key of Object.keys(i18n)) {
                I18n.addLanguage((i18n as { [key: string]: Locale })[key]);
            }
        });
    }

    useIndexedDB() {
        this.init("IndexedDBStorage", async () => {
            Logger.info("initializing IndexedDBStorage");

            const db = await import("@chili3d/storage");
            this._storage = new db.IndexedDBStorage();
            await this._storage.createDBIfNeeded(Constants.DBName, [
                Constants.DocumentTable,
                Constants.RecentTable,
                Constants.LibraryTable,
                Constants.HistoryTable,
                Constants.LinkCacheTable,
            ]);
        });
        return this;
    }

    useWasmOcc() {
        // The OCCT kernel (~5 MB of WebAssembly) downloads and compiles while the other modules load.
        const loading = preload(async () => {
            const wasm = await import("@chili3d/wasm");
            await wasm.initWasm();
            return wasm;
        });
        this.init("wasm occ", async () => {
            Logger.info("initializing wasm occ");

            const wasm = await loading;
            this._shapeProvider = new wasm.OccShapeProvider();
        });
        return this;
    }

    useParametric(): this {
        // Onshape's FeatureScript std library (~1 MB): start fetching now, alongside the rest of startup.
        const onshapeStd = import("@chili3d/onshape-std").then((std) => std.loadOnshapeStd());
        onshapeStd.catch(() => {}); // handled where it is awaited
        // registers sketch/feature commands, the SketchNode/ParametricBodyNode serializers, and
        // exposes the sketch ribbon contributions; the garlic solver compiles meanwhile
        const loading = preload(async () => {
            const parametric = await import("@chili3d/parametric");
            await parametric.initGarlic();
            return parametric;
        });
        this.init("parametric", async () => {
            Logger.info("initializing parametric");

            const parametric = await loading;
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
        const loading = preload(async () => {
            // CAM kernels call the Rust module synchronously
            const rs = await import("@chili3d/rs");
            await rs.initRust();
            // registers the CAM Studio element and commands, the machine library and the posts
            return import("@chili3d/cam");
        });
        this.init("cam", async () => {
            Logger.info("initializing cam");

            // plugins reach the registries (operations, posts, machines) through the global
            const cam = await loading;
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
        const loading = preload(() => import("@chili3d/data"));
        this.init("data sources", async () => {
            Logger.info("initializing data sources");

            const data = await loading;
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
        const loading = preload(() => import("@chili3d/assembly"));
        this.init("assembly", async () => {
            Logger.info("initializing assembly");

            const assembly = await loading;
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
        const loading = preload(() => import("@chili3d/documents"));
        this.init("documents", async () => {
            Logger.info("initializing documents");

            const documents = await loading;
            documents.registerDocumentsModule();
            this._ribbonExtras.push(...documents.DocumentsRibbonProfiles);
        });
        return this;
    }

    /**
     * Fabrication templates (`@chili3d/fabrication`): the End Cap Configurator — round duct end
     * caps and reducers as flat-pattern sketches, set up in a React dialog. Its ribbon entry
     * joins the sheet metal tab, so it comes after `useParametric`.
     */
    useFabrication(): this {
        const loading = preload(() => import("@chili3d/fabrication/app"));
        this.init("fabrication", async () => {
            Logger.info("initializing fabrication");

            const fabrication = await loading;
            (globalThis as Record<string, unknown>)["Chili3dFabrication"] = fabrication;
            this._ribbonExtras.push(...FabricationRibbonProfiles);
        });
        return this;
    }

    useThree(): this {
        const loading = preload(() => import("@chili3d/three"));
        this.init("three", async () => {
            Logger.info("initializing three");

            const three = await loading;
            this._visualFactory = new three.ThreeVisulFactory((d) => new ShowPropertyEventHandler(d));
        });
        return this;
    }

    /**
     * The main window, rendered into `container` — the host element of a page (the Next.js
     * workbench passes its own); `#app` or the body when absent.
     */
    useUI(container?: HTMLElement): this {
        const loading = preload(() => import("@chili3d/ui"));
        this.init("MainWindow", async () => {
            Logger.info("initializing MainWindow");

            const ui = await loading;
            const app = container ?? (document.getElementById("app") as HTMLElement);
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
        // Each module loads and initializes on its own: one that is broken, or still being
        // worked on, is reported and left out instead of taking the whole suite down with it.
        for (const init of this._inits) {
            try {
                await init();
            } catch (error) {
                const name = this._initNames.get(init) ?? "startup";
                const message = error instanceof Error ? error.message : String(error);
                Logger.error(`module "${name}" failed to load; continuing without it`, error);
                this.moduleFailures.push({ module: name, message });
            }
        }
        this.ensureNecessary();

        const app = this.createApp();
        installDiagnostics(app);
        for (const onBuilt of this._onBuilt) {
            await onBuilt(app);
        }
        await this._window?.init(app);
        await this.loadDefaultPlugins(app);
        for (const failure of this.moduleFailures)
            PubSub.default.pub("showToast", "error.default:{0}", `${failure.module}: ${failure.message}`);

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
        // Startup parameters (`?url=`, `?endcap=`) belong to the page, not the plugin folder.
        urlObj.search = "";
        urlObj.hash = "";
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
        return [new CommandService(), new HotkeyService(), new AutosaveService()];
    }
}

/**
 * Starts loading a module now — when its `use*()` is called — so every module's download,
 * evaluation and WebAssembly compile overlap; the init that awaits it still runs in order, so
 * ribbon contributions and registrations stay deterministic. A failure surfaces in that init.
 */
/** A module the builder could not bring up. */
export interface ModuleFailure {
    readonly module: string;
    readonly message: string;
}

function preload<T>(load: () => Promise<T>): Promise<T> {
    const loading = load();
    loading.catch(() => {});
    return loading;
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
