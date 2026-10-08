// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Paste this file into the app's browser console (or evaluate it through preview_evaluate), then run:
// await benchmarkViewport(Chili3dCore.getCurrentApplication().activeView)
// Uses the currently open model and camera; it never edits or saves the document.
// Compare the same viewport dimensions, pixel-density setting, hardware and browser backend.
globalThis.benchmarkViewport = async function benchmarkViewport(view, samples = 60) {
    const renderer = view.renderer;
    const gl = renderer.getContext();
    const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const pixel = new Uint8Array(4);
    const cpu = [];
    const completed = [];
    let disjoint = 0;
    // Let pending model, resize and camera changes settle before sampling.
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let i = 0; i < samples + 5; i++) {
        await new Promise(requestAnimationFrame);
        const query = timer ? gl.createQuery() : undefined;
        try {
            if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
            const start = performance.now();
            view.renderFrame();
            const submission = performance.now() - start;
            let duration;
            if (query) {
                gl.endQuery(timer.TIME_ELAPSED_EXT);
                const deadline = performance.now() + 5000;
                while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
                    if (gl.isContextLost() || performance.now() > deadline) {
                        throw new Error("GPU timing query did not complete");
                    }
                    await new Promise((resolve) => setTimeout(resolve, 2));
                }
                if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
                    disjoint++;
                    continue;
                }
                duration = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
            } else {
                // SwiftShader and some browsers do not expose GPU timers. A synchronous pixel
                // readback measures completion including CPU/IPC overhead, NOT GPU time alone.
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                duration = performance.now() - start;
            }
            if (i >= 5) {
                cpu.push(submission);
                completed.push(duration);
            }
        } finally {
            if (query) gl.deleteQuery(query);
        }
    }
    function stats(values) {
        values.sort((a, b) => a - b);
        return {
            samples: values.length,
            median: values[Math.floor(values.length * 0.5)] ?? null,
            p95: values[Math.floor(values.length * 0.95)] ?? null,
        };
    }
    return {
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        timing: timer ? "GPU timer query" : "synchronous frame completion including CPU and pixel readback",
        viewport: [view.width, view.height],
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        pixelRatio: renderer.getPixelRatio(),
        frameMs: stats(completed),
        cpuSubmissionMs: stats(cpu),
        disjoint,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        aoBuffer: view.effects.ao ? [view.effects.ao.width, view.effects.ao.height] : null,
    };
};
