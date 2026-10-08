// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, effectiveShortcuts } from "@chili3d/core";
import { HotkeyService } from "../../src/services/hotkeyService";

test("multi-modifier shortcuts dispatch in canonical order and custom changes apply immediately", () => {
    const saved = Config.instance.customShortcuts;
    const service = new HotkeyService();
    service.start();
    try {
        expect(service.getCommand({ key: "z", ctrlKey: true, shiftKey: true })).toBe("edit.redo");
        Config.instance.customShortcuts = { "sketch.line": "ctrl+alt+k" };
        expect(service.getCommand({ key: "k", ctrlKey: true, altKey: true })).toBe("sketch.line");
        Config.instance.customShortcuts = { "sketch.line": "" };
        expect(service.getCommand({ key: "k", ctrlKey: true, altKey: true })).toBeUndefined();
        expect(effectiveShortcuts("Chili3d", Config.instance.customShortcuts)["edit.undo"]).toBe("ctrl+z");
    } finally {
        Config.instance.customShortcuts = saved;
        service.stop();
    }
});
