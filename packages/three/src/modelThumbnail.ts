// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { OriginNode } from "@chili3d/core";
import {
    Box3,
    BufferGeometry,
    Color,
    type Object3D,
    OrthographicCamera,
    type PerspectiveCamera,
    type Scene,
    Sphere,
    SRGBColorSpace,
    Vector3,
    type Vector4,
    type WebGLRenderer,
    WebGLRenderTarget,
} from "three";
import { ThreeGeometry } from "./threeGeometry";
import { ThreeReferencePlane } from "./threeReferencePlane";

/** Clone and fit the preview camera; the interactive view keeps its exact position and projection. */
export function thumbnailCamera(
    source: OrthographicCamera | PerspectiveCamera,
    bounds: Box3,
    aspect: number,
) {
    const camera = source.clone();
    const sphere = bounds.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 0.001) * 1.12;
    const halfHeight = radius / Math.min(1, aspect);
    const distance = radius * 4;
    camera.position.copy(sphere.center).addScaledVector(source.getWorldDirection(new Vector3()), -distance);
    camera.lookAt(sphere.center);
    camera.near = Math.max(0.0001, distance - radius * 2);
    camera.far = distance + radius * 2;
    camera.zoom = 1;
    if (camera instanceof OrthographicCamera) {
        camera.left = -halfHeight * aspect;
        camera.right = halfHeight * aspect;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
    } else {
        camera.aspect = aspect;
        camera.fov = (2 * Math.atan(halfHeight / (distance - radius)) * 180) / Math.PI;
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return camera;
}

/** Thumbnail pixels: 3:2 like the home page's slots, at twice the largest slot so it stays sharp on HiDPI. */
export const THUMBNAIL_WIDTH = 480;
export const THUMBNAIL_HEIGHT = 320;
/** Fat lines are sized for this many target pixels per CSS pixel, as on a 2x display. */
const THUMBNAIL_LINE_SCALE = 2;

/** Default datums (reference planes, the origin) frame the thumbnail only when there is nothing else. */
function isDatum(object: Object3D) {
    return (
        object instanceof ThreeReferencePlane ||
        (object instanceof ThreeGeometry && object.geometryNode instanceof OriginNode)
    );
}

export function modelBounds(models: Object3D) {
    const bounds = new Box3();
    models.traverseVisible((object) => {
        // PMI annotations carry a PmiGeometry description, not a BufferGeometry.
        const geometry = (object as Object3D & { geometry?: unknown }).geometry;
        if (!(geometry instanceof BufferGeometry)) return;
        geometry.computeBoundingBox();
        if (geometry.boundingBox) bounds.union(geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
    });
    return bounds;
}

/**
 * Render model geometry into an offscreen, multisampled target; viewport overlays stay out. Datums are
 * left out too unless the document has nothing else, so an empty document still gets a framed preview
 * of its planes instead of a screenshot of the whole viewport.
 */
export function renderModelThumbnail(
    renderer: WebGLRenderer,
    scene: Scene,
    models: Object3D,
    source: OrthographicCamera | PerspectiveCamera,
    render: (draw: () => void) => void,
): string | undefined {
    const width = THUMBNAIL_WIDTH,
        height = THUMBNAIL_HEIGHT;
    const visibility = new Map<Object3D, boolean>();
    const hide = (object: Object3D) => {
        visibility.set(object, object.visible);
        object.visible = false;
    };
    const restoreVisibility = () => {
        for (const [object, visible] of visibility) object.visible = visible;
        visibility.clear();
    };
    const target = new WebGLRenderTarget(width, height, { samples: 4 });
    target.texture.colorSpace = SRGBColorSpace;
    const previousTarget = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new Color());
    const alpha = renderer.getClearAlpha();
    const background = scene.background;
    try {
        const hideOverlays = () => {
            for (const object of scene.children)
                if (object !== models && !(object as Object3D & { isLight?: boolean }).isLight) hide(object);
        };
        hideOverlays();
        models.traverse((object) => {
            if (isDatum(object)) hide(object);
        });
        scene.updateMatrixWorld(true);
        let bounds = modelBounds(models);
        if (bounds.isEmpty()) {
            restoreVisibility();
            hideOverlays();
            bounds = modelBounds(models);
        }
        if (bounds.isEmpty()) return undefined;
        const camera = thumbnailCamera(source, bounds, width / height);
        scene.background = null;
        renderer.setClearColor(0xffffff, 0);
        renderer.setRenderTarget(target);
        renderer.clear();
        render(() => {
            // Fat lines size themselves from the canvas viewport (`LineSegments2.onBeforeRender`), not
            // the bound target; report the thumbnail's, or edges come out a fraction of a pixel wide.
            const getViewport = renderer.getViewport;
            renderer.getViewport = (viewport: Vector4) =>
                viewport.set(0, 0, width / THUMBNAIL_LINE_SCALE, height / THUMBNAIL_LINE_SCALE);
            try {
                renderer.render(scene, camera);
            } finally {
                renderer.getViewport = getViewport;
            }
        });
        const pixels = new Uint8Array(width * height * 4);
        renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return undefined;
        const image = context.createImageData(width, height);
        const row = width * 4;
        for (let y = 0; y < height; y++)
            image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        context.putImageData(image, 0, 0);
        return canvas.toDataURL("image/png");
    } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(clear, alpha);
        scene.background = background;
        restoreVisibility();
        target.dispose();
    }
}
