// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys } from "./command/commandKeys";
import { ObjectStorage, Observable } from "./foundation";
import { DEFAULT_GRAPHICS, type GraphicsPreferences } from "./graphicsPreferences";
import { I18n } from "./i18n";
import type { Navigation3DType } from "./navigation";
import { type SerializedData, Serializer, serialize } from "./serialize";
import { type ObjectSnapType, ObjectSnapTypes, ObjectSnapTypeUtils } from "./snapType";
import type { RibbonPreferences } from "./ui/ribbonPreferences";

export const DefaultLightEdgeColor = 0x333333;
export const DefaultDarkEdgeColor = 0xeeeeee;

export class VisualItemConfig extends Observable {
    defaultFaceColor = 0xdedede;
    highlightEdgeColor = 0xffd56a;
    highlightFaceColor = 0x99ff00;
    selectedEdgeColor = 0xffc247;
    selectedFaceColor = 0xffc247;
    editVertexSize = 7;
    editVertexColor = 0xffc247;
    hintVertexSize = 5;
    hintVertexColor = 0x33ff33;
    trackingVertexSize = 7;
    trackingVertexColor = 0x33ff33;
    temporaryVertexSize = 5;
    temporaryVertexColor = 0x33ff33;
    temporaryEdgeColor = 0x33ff33;

    get defaultEdgeColor() {
        return this.getPrivateValue("defaultEdgeColor", DefaultLightEdgeColor);
    }
    set defaultEdgeColor(value: number) {
        this.setProperty("defaultEdgeColor", value);
    }

    applyTheme(theme: "light" | "dark") {
        this.defaultEdgeColor = theme === "light" ? DefaultLightEdgeColor : DefaultDarkEdgeColor;
    }
}

export const VisualConfig = new VisualItemConfig();

export class Config extends Observable {
    static readonly #instance = new Config();

    static get instance() {
        return Config.#instance;
    }

    readonly SnapDistance: number = 10;

    get graphics(): GraphicsPreferences {
        return { ...DEFAULT_GRAPHICS, ...this.getPrivateValue("graphics", { ...DEFAULT_GRAPHICS }) };
    }
    set graphics(value: GraphicsPreferences) {
        this.setProperty("graphics", { ...value });
    }

    @serialize()
    get orientNormalOnSketchEdit(): boolean {
        return this.getPrivateValue("orientNormalOnSketchEdit", true);
    }
    set orientNormalOnSketchEdit(value: boolean) {
        this.setProperty("orientNormalOnSketchEdit", value);
    }

    get snapType() {
        return this.getPrivateValue(
            "snapType",
            ObjectSnapTypeUtils.combine(
                ObjectSnapTypes.midPoint,
                ObjectSnapTypes.endPoint,
                ObjectSnapTypes.center,
                ObjectSnapTypes.perpendicular,
                ObjectSnapTypes.intersection,
                ObjectSnapTypes.onCurve,
                ObjectSnapTypes.onSurface,
                ObjectSnapTypes.vertex,
                ObjectSnapTypes.tangent,
            ),
        );
    }
    set snapType(snapType: ObjectSnapType) {
        this.setProperty("snapType", snapType);
    }

    get enableSnapTracking() {
        return this.getPrivateValue("enableSnapTracking", true);
    }
    set enableSnapTracking(value: boolean) {
        this.setProperty("enableSnapTracking", value);
    }

    get enableSnap() {
        return this.getPrivateValue("enableSnap", true);
    }
    set enableSnap(value: boolean) {
        this.setProperty("enableSnap", value);
    }

    get dynamicWorkplane() {
        return this.getPrivateValue("dynamicWorkplane", true);
    }
    set dynamicWorkplane(value: boolean) {
        this.setProperty("dynamicWorkplane", value);
    }

    @serialize()
    get language() {
        return this.getPrivateValue("language", I18n.defaultLanguage());
    }
    set language(value: string) {
        this.setProperty("language", value);
    }

    @serialize()
    get navigation3D() {
        return this.getPrivateValue("navigation3D", "Chili3d");
    }
    set navigation3D(value: Navigation3DType) {
        this.setProperty("navigation3D", value);
    }

    get customShortcuts(): Partial<Record<CommandKeys, string>> {
        return this.getPrivateValue("customShortcuts", {});
    }
    set customShortcuts(value: Partial<Record<CommandKeys, string>>) {
        this.setProperty("customShortcuts", value);
    }

    get ribbonPreferences(): RibbonPreferences {
        return this.getPrivateValue("ribbonPreferences", {});
    }
    set ribbonPreferences(value: RibbonPreferences) {
        this.setProperty("ribbonPreferences", value);
    }

    @serialize()
    get themeMode() {
        return this.getPrivateValue("themeMode", "system");
    }
    set themeMode(value: "light" | "dark" | "system") {
        this.setProperty("themeMode", value, () => this.applyTheme(value));
    }

    @serialize()
    get trustedDomains() {
        return this.getPrivateValue("trustedDomains", []);
    }
    set trustedDomains(value: string[]) {
        this.setProperty("trustedDomains", value);
    }

    #storageKey: string = "config";
    get storageKey() {
        return this.#storageKey;
    }

    private constructor() {
        super();
    }

    init(storageKey: string) {
        this.#storageKey = storageKey;
        this.readFromStorage();
        this.applyTheme(this.themeMode);
    }

    private readonly applyTheme = (value: "light" | "dark" | "system") => {
        if (value === "system") {
            VisualConfig.applyTheme(
                window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
            );
        } else {
            VisualConfig.applyTheme(value);
        }
    };

    readFromStorage() {
        const data = ObjectStorage.default.value<SerializedData>(this.storageKey);
        for (const key in data) {
            const thisKey = key as keyof Config;
            this.setPrivateValue(thisKey, (data as any)[key]);
        }
    }

    saveToStorage() {
        const json = Serializer.serializeProperties(this);
        ObjectStorage.default.setValue(this.storageKey, {
            ...json,
            graphics: this.graphics,
            customShortcuts: this.customShortcuts,
            ribbonPreferences: this.ribbonPreferences,
        });
    }
}
