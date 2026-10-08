// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    defaultUserPreferences,
    documentQuantityUnits,
    documentUnits,
    initializeDocumentPreferences,
    Ribbon,
    RibbonTab,
} from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { PreferencesDialog } from "../src/preferences/preferencesDialog";

function click(root: ParentNode, text: string) {
    const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === text,
    );
    expect(button).not.toBeUndefined();
    button!.click();
}
function select(root: ParentNode, label: string, value: string) {
    const input = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    expect(input).not.toBeNull();
    input!.value = value;
    input!.dispatchEvent(new Event("change", { bubbles: true }));
}

test("preferences save document units as one undo step, keep defaults separate, and discard unsaved drafts", () => {
    const saved = Config.instance.preferences;
    const storage = rs.spyOn(Config.instance, "saveToStorage").mockImplementation(() => {});
    Config.instance.preferences = defaultUserPreferences();
    const model = new TestDocument();
    const ribbon = new Ribbon([], [new RibbonTab("ribbon.tab.model")]);
    let preferences = new PreferencesDialog(ribbon, () => {}, model).show();
    try {
        select(preferences.dialog, "Current document length unit", "in");
        select(preferences.dialog, "Current document mass unit", "lb");
        expect(documentUnits(model).length).toBe("mm");
        click(preferences.dialog, "Save document units");
        expect(documentUnits(model).length).toBe("in");
        expect(documentQuantityUnits(model).mass.unit).toBe("lb");
        expect(Config.instance.preferences.defaultUnits.length).toBe("mm");
        model.history.undo();
        expect(documentUnits(model).length).toBe("mm");
        expect(documentQuantityUnits(model).mass.unit).toBe("kg");
        model.history.redo();
        select(preferences.dialog, "Units length unit", "ft");
        click(preferences.dialog, "Save default units");
        expect(documentUnits(model).length).toBe("in");
        const next = new TestDocument();
        initializeDocumentPreferences(next);
        expect(documentUnits(next).length).toBe("ft");
        next.dispose();
        select(preferences.dialog, "Units length unit", "cm");
        preferences.dispose();
        preferences = new PreferencesDialog(ribbon, () => {}, model).show();
        expect(
            preferences.dialog.querySelector<HTMLSelectElement>('select[aria-label="Units length unit"]')!
                .value,
        ).toBe("ft");
        expect(storage).toHaveBeenCalled();
    } finally {
        preferences.dispose();
        model.dispose();
        storage.mockRestore();
        Config.instance.preferences = saved;
    }
});
