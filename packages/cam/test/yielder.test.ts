// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Yielder } from "../src/mesh/yielder";

test("a cancelled computation stops before another chunk", () => {
    const controller = new AbortController();
    const yielder = new Yielder(1000, controller.signal);
    controller.abort(new Error("superseded"));
    expect(() => yielder.tick()).toThrow("superseded");
    expect(yielder.yields).toBe(0);
});

test("cancellation during a yield rejects before work resumes", async () => {
    const controller = new AbortController();
    const yielder = new Yielder(0, controller.signal);
    const tick = yielder.tick();
    expect(tick).toBeInstanceOf(Promise);
    controller.abort(new Error("document closed"));
    await expect(tick).rejects.toThrow("document closed");
    expect(yielder.yields).toBe(1);
});
