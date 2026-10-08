// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, DEFAULT_GRAPHICS } from "@chili3d/core";
import { GraphicsPanel } from "../src/graphicsPanel";
import type { ThreeView } from "../src/threeView";

test("graphics preview, tab switching and Cancel restore all prior preferences", () => {
    const before = Config.instance.graphics;
    Config.instance.graphics = { ...DEFAULT_GRAPHICS };
    const host = document.createElement("div");
    document.body.append(host);
    const panel = new GraphicsPanel({ dom: host } as unknown as ThreeView);
    try {
        const fov = host.querySelector<HTMLInputElement>('[aria-label="Viewport Field of view"]')!;
        expect(fov).not.toBeNull();
        fov.value = "60";
        fov.dispatchEvent(new Event("input"));
        expect(Config.instance.graphics.fieldOfView).toBe(60);
        (host.querySelector('[role="tab"][aria-label="Sketch"]') as HTMLButtonElement).click();
        const dash = host.querySelector<HTMLInputElement>('[aria-label="Construction lines First dash"]')!;
        expect(dash).not.toBeNull();
        dash.value = "9";
        dash.dispatchEvent(new Event("input"));
        expect(Config.instance.graphics.firstDash).toBe(9);
        (host.querySelector('[aria-label="Cancel graphics preferences"]') as HTMLButtonElement).click();
        expect(Config.instance.graphics).toEqual(DEFAULT_GRAPHICS);
        expect(host.children.length).toBe(0);
    } finally {
        panel.dispose();
        host.remove();
        Config.instance.graphics = before;
    }
});

test("Apply persists graphics preferences as ordinary settings", () => {
    const before = Config.instance.graphics;
    const host = document.createElement("div");
    document.body.append(host);
    const panel = new GraphicsPanel({ dom: host } as unknown as ThreeView);
    try {
        const input = host.querySelector<HTMLInputElement>('[aria-label="Viewport Field of view"]')!;
        expect(input).not.toBeNull();
        input.value = "65";
        input.dispatchEvent(new Event("input"));
        (host.querySelector('[aria-label="Apply graphics preferences"]') as HTMLButtonElement).click();
        expect(host.children.length).toBe(0);
        Config.instance.graphics = before;
        Config.instance.readFromStorage();
        expect(Config.instance.graphics.fieldOfView).toBe(65);
    } finally {
        panel.dispose();
        host.remove();
        Config.instance.graphics = before;
        Config.instance.saveToStorage();
    }
});
