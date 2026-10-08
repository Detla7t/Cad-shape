// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Box3,
    type BufferGeometry,
    Color,
    type Object3D,
    OrthographicCamera,
    type PerspectiveCamera,
    type Scene,
    Sphere,
    SRGBColorSpace,
    Vector3,
    type WebGLRenderer,
    WebGLRenderTarget,
} from "three";
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

/** Render model geometry into a small offscreen target; reference planes and viewport overlays stay out. */
export function renderModelThumbnail(
    renderer: WebGLRenderer,
    scene: Scene,
    models: Object3D,
    source: OrthographicCamera | PerspectiveCamera,
    render: (draw: () => void) => void,
): string | undefined {
    const visibility = new Map<Object3D, boolean>();
    const hide = (object: Object3D) => {
        visibility.set(object, object.visible);
        object.visible = false;
    };
    const target = new WebGLRenderTarget(320, 200);
    target.texture.colorSpace = SRGBColorSpace;
    const previousTarget = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new Color());
    const alpha = renderer.getClearAlpha();
    const background = scene.background;
    try {
        for (const object of scene.children)
            if (object !== models && !(object as Object3D & { isLight?: boolean }).isLight) hide(object);
        models.traverse((object) => {
            if (object instanceof ThreeReferencePlane) hide(object);
        });
        scene.updateMatrixWorld(true);
        const bounds = new Box3();
        models.traverseVisible((object) => {
            const geometry = (object as Object3D & { geometry?: BufferGeometry }).geometry;
            if (!geometry) return;
            geometry.computeBoundingBox();
            if (geometry.boundingBox)
                bounds.union(geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
        });
        if (bounds.isEmpty()) return undefined;
        const camera = thumbnailCamera(source, bounds, 320 / 200);
        scene.background = null;
        renderer.setClearColor(0xffffff, 0);
        renderer.setRenderTarget(target);
        renderer.clear();
        render(() => renderer.render(scene, camera));
        const pixels = new Uint8Array(320 * 200 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 320, 200, pixels);
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 200;
        const context = canvas.getContext("2d");
        if (!context) return undefined;
        const image = context.createImageData(320, 200);
        for (let y = 0; y < 200; y++)
            image.data.set(pixels.subarray((199 - y) * 1280, (200 - y) * 1280), y * 1280);
        context.putImageData(image, 0, 0);
        return canvas.toDataURL("image/png");
    } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(clear, alpha);
        scene.background = background;
        for (const [object, visible] of visibility) object.visible = visible;
        target.dispose();
    }
}
