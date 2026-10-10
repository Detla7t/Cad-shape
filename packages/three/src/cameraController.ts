// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CameraType,
    Config,
    type ICameraController,
    MathUtils,
    Observable,
    type ViewMode,
    type XYZLike,
} from "@chili3d/core";
import {
    Box3,
    Camera,
    Object3D,
    OrthographicCamera,
    PerspectiveCamera,
    Quaternion,
    Raycaster,
    Sphere,
    Vector3,
} from "three";
import { Constants } from "./constants";
import type { ThreeGeometry } from "./threeGeometry";
import { ThreeHelper } from "./threeHelper";
import type { ThreeView } from "./threeView";
import type { ThreeVisualContext } from "./threeVisualContext";
import { ThreeVisualObject } from "./threeVisualObject";

const DEG_TO_RAD = Math.PI / 180.0;
const ZOOM_SPEED_FACTOR = 0.1;
const ROTATE_SPEED_FACTOR = 0.5;
const PAN_SPEED_FACTOR = 0.002;

const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1e6;
const MIN_CARME_TO_TARGET = 50;
const SHAPE_EMPTY_SIZE = 800;
/** View cube orientations and sketch entry tween over this long (Onshape's view transitions). */
export const CAMERA_TWEEN_MS = 320;

/** Whether the user asked the platform for less motion; a tween then lands at once. */
export function reducedMotion(): boolean {
    return (
        typeof globalThis.matchMedia === "function" &&
        globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

Camera.DEFAULT_UP = new Vector3(0, 0, 1);

export class CameraController extends Observable implements ICameraController {
    private _width: number = 100;
    private _height: number = 100;
    private _target: Vector3 = new Vector3();
    private _position: Vector3 = new Vector3(1500, 1500, 1500);
    private _rotateCenter: Vector3 | undefined;
    private _camera: PerspectiveCamera | OrthographicCamera;
    private previous?: { eye: Vector3; target: Vector3; up: Vector3; type: CameraType };
    /** The tween in flight, if any — `cancelAnimation` ends it where it stands. */
    private animation?: { frame: number; finish: () => void };

    rememberView() {
        this.previous = {
            eye: this._position.clone(),
            target: this._target.clone(),
            up: this.camera.up.clone(),
            type: this.cameraType,
        };
    }

    get hasPreviousView() {
        return this.previous !== undefined;
    }

    restorePreviousView() {
        const previous = this.previous;
        if (!previous) return;
        this.rememberView();
        this.cameraType = previous.type;
        this.lookAt(previous.eye, previous.target, previous.up);
    }

    zoomWindow(x1: number, y1: number, x2: number, y2: number) {
        const ratio = Math.max(Math.abs(x2 - x1) / this._width, Math.abs(y2 - y1) / this._height);
        if (ratio < 0.01) return;
        this.rememberView();
        const direction = this._target.clone().sub(this._position);
        let center = this.mouseToWorld((x1 + x2) / 2, (y1 + y2) / 2);
        if (this.camera instanceof PerspectiveCamera)
            center = this.caculePerspectiveCameraMouse(direction, center);
        this.lookAt(center.clone().sub(direction.multiplyScalar(ratio)), center, this.camera.up);
    }

    get cameraType(): CameraType {
        return this.getPrivateValue("cameraType", "orthographic");
    }
    set cameraType(value: CameraType) {
        if (this.setProperty("cameraType", value)) {
            this._camera = this.createCamera(this._camera.near, this._camera.far);
            if (this.camera instanceof OrthographicCamera) {
                this.updateOrthographicCamera(this.camera);
            }
            // each projection has its own clipping rule
            this.updateCameraNearFar();
            this.updateCameraPosionTarget();
        }
    }

    get target() {
        return this._target;
    }

    set target(value: Vector3) {
        this._target.copy(value);
    }

    get cameraPosition() {
        return ThreeHelper.toXYZ(this._position);
    }

    get cameraTarget() {
        return ThreeHelper.toXYZ(this._target);
    }

    get cameraUp() {
        return ThreeHelper.toXYZ(this._camera.up);
    }

    get camera(): PerspectiveCamera | OrthographicCamera {
        return this._camera;
    }

    constructor(readonly view: ThreeView) {
        super();
        this._camera = this.createCamera(CAMERA_NEAR, CAMERA_FAR);
    }

    private createCamera(near: number, far: number) {
        let camera: PerspectiveCamera | OrthographicCamera;
        if (this.cameraType === "perspective") {
            camera = new PerspectiveCamera(
                Config.instance.graphics.fieldOfView,
                this._width / this._height,
                near,
                far,
            );
        } else {
            camera = new OrthographicCamera(
                -this._width / 2,
                this._width / 2,
                this._height / 2,
                -this._height / 2,
                near,
                far,
            );
        }
        this.setCameraLayer(camera, this.view.mode);
        return camera;
    }

    setCameraLayer(camera: Camera, mode: ViewMode) {
        if (mode === "wireframe") {
            camera.layers.enable(Constants.Layers.Wireframe);
            camera.layers.disable(Constants.Layers.Solid);
        } else if (mode === "solid") {
            camera.layers.enable(Constants.Layers.Solid);
            camera.layers.disable(Constants.Layers.Wireframe);
        } else {
            camera.layers.enableAll();
        }
    }

    /**
     * `lookAt` reached over `duration` ms: the eye swings around the target (direction
     * slerped, distance eased) while the target and up vector ease along, so an orientation
     * from the view cube reads as a turn rather than a cut. A pan, rotate or zoom from the
     * user — or another tween — ends it at its current frame. With reduced motion, or no
     * animation frames (tests), the camera lands at once.
     */
    animateLookAt(eye: XYZLike, target: XYZLike, up: XYZLike, duration = CAMERA_TWEEN_MS): Promise<void> {
        this.cancelAnimation();
        const raf = globalThis.requestAnimationFrame;
        if (duration <= 0 || reducedMotion() || typeof raf !== "function") {
            this.lookAt(eye, target, up);
            return Promise.resolve();
        }
        const fromTarget = this._target.clone();
        const toTarget = new Vector3(target.x, target.y, target.z);
        const fromOffset = this._position.clone().sub(fromTarget);
        const toOffset = new Vector3(eye.x, eye.y, eye.z).sub(toTarget);
        const fromDistance = fromOffset.length();
        const toDistance = toOffset.length();
        const fromDirection =
            fromDistance > 0 ? fromOffset.clone().divideScalar(fromDistance) : new Vector3(0, 0, 1);
        const toDirection =
            toDistance > 0 ? toOffset.clone().divideScalar(toDistance) : fromDirection.clone();
        const fromUp = this.camera.up.clone().normalize();
        const toUp = new Vector3(up.x, up.y, up.z).normalize();
        const turn = new Quaternion().setFromUnitVectors(fromDirection, toDirection);
        const upTurn = new Quaternion().setFromUnitVectors(fromUp, toUp);
        const start = performance.now();
        return new Promise<void>((resolve) => {
            const finish = () => {
                this.animation = undefined;
                resolve();
            };
            const step = (now: number) => {
                const t = Math.min(1, (now - start) / duration);
                const k = easeInOutCubic(t);
                if (t >= 1) {
                    this.animation = undefined;
                    this.lookAt(eye, target, up);
                    resolve();
                    return;
                }
                const direction = fromDirection
                    .clone()
                    .applyQuaternion(new Quaternion().slerpQuaternions(new Quaternion(), turn, k));
                const distance = fromDistance + (toDistance - fromDistance) * k;
                const centre = fromTarget.clone().lerp(toTarget, k);
                const frameUp = fromUp
                    .clone()
                    .applyQuaternion(new Quaternion().slerpQuaternions(new Quaternion(), upTurn, k));
                this.lookAt(centre.clone().add(direction.multiplyScalar(distance)), centre, frameUp);
                this.animation = { frame: raf(step), finish };
            };
            this.animation = { frame: raf(step), finish };
        });
    }

    /** Ends a tween where it stands (the user took the camera). */
    private cancelAnimation(): void {
        const animation = this.animation;
        if (animation === undefined) return;
        this.animation = undefined;
        globalThis.cancelAnimationFrame?.(animation.frame);
        animation.finish();
    }

    pan(dx: number, dy: number): void {
        this.cancelAnimation();
        const ratio = PAN_SPEED_FACTOR * this._target.distanceTo(this._position);
        const direction = this._target.clone().sub(this._position).normalize();
        const hor = direction.clone().cross(this.camera.up).normalize();
        const ver = hor.clone().cross(direction).normalize();
        const vector = hor.multiplyScalar(-dx).add(ver.multiplyScalar(dy)).multiplyScalar(ratio);
        this._target.add(vector);
        this._position.add(vector);

        this.updateCameraPosionTarget();
    }

    updateCameraPosionTarget() {
        if (this._camera instanceof PerspectiveCamera)
            this._camera.fov = Config.instance.graphics.fieldOfView;
        const oldValue = this.cameraPosition;
        this._camera.position.copy(this._position);
        this._camera.lookAt(this._target);
        this._camera.updateProjectionMatrix();
        this.emitPropertyChanged("cameraPosition", oldValue);
    }

    setSize(width: number, height: number): void {
        this._width = width;
        this._height = height;
        if (this.camera instanceof PerspectiveCamera) {
            this.camera.aspect = width / height;
        } else if (this.camera instanceof OrthographicCamera) {
            this.updateOrthographicCamera(this.camera);
        }
        this.camera.updateProjectionMatrix();
    }

    private updateOrthographicCamera(camera: OrthographicCamera) {
        const aspect = this._width / this._height;
        const length = this._position.distanceTo(this._target);
        const frustumHalfHeight = length * Math.tan((Config.instance.graphics.fieldOfView * DEG_TO_RAD) / 2);
        camera.left = -frustumHalfHeight * aspect;
        camera.right = frustumHalfHeight * aspect;
        camera.top = frustumHalfHeight;
        camera.bottom = -frustumHalfHeight;
    }

    startRotate(x: number, y: number): void {
        this.cancelAnimation();
        this.rememberView();
        this._rotateCenter = this.selectedNodesCenter();
        if (this._rotateCenter) {
            return;
        }

        const shape = this.view.detectVisual(x, y).at(0);
        if (shape instanceof ThreeVisualObject) {
            const box = new Box3();
            box.setFromObject(shape);
            this._rotateCenter = box.getCenter(new Vector3());
        }
    }

    private selectedNodesCenter() {
        const box = new Box3();
        const nodes = this.view.document.selection.getSelectedNodes();
        if (nodes.length > 0) {
            for (const node of nodes) {
                const shape = this.view.document.visual.context.getVisual(node);
                if (shape instanceof Object3D) {
                    box.expandByObject(shape);
                }
            }
            return box.getCenter(new Vector3());
        }
        return undefined;
    }

    setRotateCenterToSelected() {
        this._rotateCenter = this.selectedNodesCenter();
    }

    rotate(dx: number, dy: number, mode: "trackball" | "turntable" = "turntable"): void {
        const newRotation =
            mode === "trackball"
                ? this.trackballRotation(dx, dy)
                : this.getRotation(dx * ROTATE_SPEED_FACTOR, dy * ROTATE_SPEED_FACTOR);

        this._camera.up.copy(new Vector3(0, 1, 0).applyQuaternion(newRotation));

        const distance = this._position.distanceTo(this._target);
        const eyeToCenter = new Vector3(0, 0, distance).applyQuaternion(newRotation);
        let currentPosition = this._target.clone().add(eyeToCenter);

        if (this._rotateCenter) {
            const diffPosition = currentPosition.clone().sub(this._position);
            const diffRotation = newRotation.clone().multiply(this._camera.quaternion.clone().invert());
            const targetAfterTrans = this._rotateCenter
                .clone()
                .sub(this._position)
                .applyQuaternion(diffRotation)
                .add(diffPosition)
                .add(this._position)
                .sub(this._rotateCenter);

            const currentCenter = this._target.clone().sub(targetAfterTrans);
            currentPosition = currentCenter.clone().add(eyeToCenter);

            this._target.copy(currentCenter);
        }

        this._position.copy(currentPosition);
        this.updateCameraPosionTarget();
    }

    /** Free orbit in screen axes: a top/bottom view tilts instead of spinning around world Z. */
    private trackballRotation(dx: number, dy: number): Quaternion {
        const axis = new Vector3(-dy, -dx, 0);
        const angle = MathUtils.degToRad(axis.length() * ROTATE_SPEED_FACTOR);
        return this._camera.quaternion
            .clone()
            .multiply(new Quaternion().setFromAxisAngle(axis.normalize(), angle));
    }

    private getRotation(dx: number, dy: number) {
        const rotationDy = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), MathUtils.degToRad(-dy));
        const tmpRotation = this._camera.quaternion.clone().multiply(rotationDy);
        const tmpRotationInv = tmpRotation.clone().invert();
        const rotationDx = new Quaternion().setFromAxisAngle(
            new Vector3(0, 0, 1).applyQuaternion(tmpRotationInv),
            MathUtils.degToRad(-dx),
        );
        return tmpRotation.clone().multiply(rotationDx);
    }

    fitContent(): void {
        const context = this.view.document.visual.context as ThreeVisualContext;
        const sphere = this.getBoundingSphere(context);
        let fieldOfView = Config.instance.graphics.fieldOfView / 2.0;
        if (this._width < this._height) {
            fieldOfView = (fieldOfView * this._width) / this._height;
        }

        const distance = Math.abs(sphere.radius / Math.sin(fieldOfView * DEG_TO_RAD));
        const direction = this._target.clone().sub(this._position).normalize();
        this._target.copy(sphere.center);
        this._position.copy(this._target.clone().sub(direction.clone().multiplyScalar(distance)));

        if (this._camera instanceof OrthographicCamera) {
            this.updateOrthographicCamera(this._camera);
        }

        this.updateCameraNearFar();
        this.updateCameraPosionTarget();
    }

    private getBoundingSphere(context: ThreeVisualContext) {
        const shapes = this.view.document.selection.getSelectedVisualNodes();

        const box = new Box3();
        if (shapes.length === 0) {
            box.setFromObject(context.visualShapes);
        } else {
            for (const shape of shapes) {
                const threeGeometry = context.getVisual(shape) as ThreeGeometry;
                const boundingBox = new Box3().setFromObject(threeGeometry);
                if (boundingBox) {
                    box.union(boundingBox);
                }
            }
        }

        const sphere = new Sphere();
        box.getBoundingSphere(sphere);
        if (sphere.radius < 0) {
            sphere.radius = SHAPE_EMPTY_SIZE;
        }
        return sphere;
    }

    zoom(x: number, y: number, delta: number): void {
        this.cancelAnimation();
        const vector = this._target.clone().sub(this._position);

        const zoomFactor = this.caclueZoomFactor(x, y, vector);
        const scale = delta > 0 ? zoomFactor : -zoomFactor;
        let mouse = this.mouseToWorld(x, y);
        if (this._camera instanceof PerspectiveCamera) {
            mouse = this.caculePerspectiveCameraMouse(vector, mouse);
        }
        const targetMoveVector = this._target.clone().sub(mouse).multiplyScalar(scale);
        this._target.add(targetMoveVector);
        this._position.copy(this._target.clone().sub(vector.clone().multiplyScalar(1 + scale)));
        if (vector.length() < MIN_CARME_TO_TARGET) {
            this._target = this._position
                .clone()
                .add(vector.clone().normalize().multiplyScalar(MIN_CARME_TO_TARGET));
        }

        if (this._camera instanceof OrthographicCamera) {
            this.updateOrthographicCamera(this._camera);
        }
        this.updateCameraNearFar();
        this.updateCameraPosionTarget();
    }

    private caclueZoomFactor(x: number, y: number, direction: Vector3) {
        const raycaster = new Raycaster();
        raycaster.setFromCamera(this.view.screenToCameraRect(x, y), this.camera);
        const intersect = raycaster.intersectObjects(this.view.content.visualShapes.children).at(0)?.point;
        let zoomFactor = ZOOM_SPEED_FACTOR;
        if (intersect) {
            zoomFactor = (ZOOM_SPEED_FACTOR * this._position.distanceTo(intersect)) / direction.length();
        }
        return zoomFactor;
    }

    /**
     * The clipping planes for the camera's distance. A perspective view clips at a thousandth
     * of the distance: anything nearer is on the lens. An orthographic view has no lens, and
     * its camera plane routinely sits inside the model — a wide field of view fits the model
     * close to it, a zoom moves it into the geometry — so its near plane is pushed as far
     * behind the camera as the far plane is in front: nothing in front of the far plane is
     * cut (the picking ray starts at that near plane too, see `ThreeView`).
     */
    private updateCameraNearFar() {
        const distance = this._position.distanceTo(this._target);
        const farPlane = Math.max(1000, distance * 100);
        const nearPlane =
            this.camera instanceof OrthographicCamera
                ? -farPlane
                : Math.max(0.01, Math.min(distance / 1000, distance / 10));
        this.camera.near = nearPlane;
        this.camera.far = farPlane;
    }

    private caculePerspectiveCameraMouse(direction: Vector3, mouse: Vector3) {
        const directionNormal = direction.clone().normalize();
        const dot = mouse.clone().sub(this._position).dot(directionNormal);
        const project = this._position.clone().add(directionNormal.clone().multiplyScalar(dot));
        const length = (project.distanceTo(mouse) * direction.length()) / project.distanceTo(this._position);
        const v = mouse.clone().sub(project).normalize().multiplyScalar(length);
        mouse = this._target.clone().add(v);
        return mouse;
    }

    lookAt(eye: XYZLike, target: XYZLike, up: XYZLike): void {
        this._position.set(eye.x, eye.y, eye.z);
        this._target.set(target.x, target.y, target.z);
        this.camera.up.set(up.x, up.y, up.z);
        if (this._camera instanceof OrthographicCamera) this.updateOrthographicCamera(this._camera);
        this.updateCameraPosionTarget();
    }

    private mouseToWorld(mx: number, my: number) {
        const x = (2.0 * mx) / this._width - 1;
        const y = (-2.0 * my) / this._height + 1;
        const dist = this._position.distanceTo(this._target);
        const z = (this._camera.far + this._camera.near - 2 * dist) / (this._camera.near - this._camera.far);

        return new Vector3(x, y, z).unproject(this._camera);
    }
}
