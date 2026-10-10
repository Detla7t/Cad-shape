// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDisposable, IPropertyChanged } from "../foundation";
import type { XYZ, XYZLike } from "../math";

export type CameraType = "perspective" | "orthographic";

export interface ICameraController extends IPropertyChanged, IDisposable {
    readonly cameraPosition: XYZ;
    readonly cameraTarget: XYZ;
    readonly cameraUp: XYZ;

    cameraType: CameraType;
    fitContent(): void;
    lookAt(eye: XYZLike, target: XYZLike, up: XYZLike): void;
    /**
     * `lookAt` reached over a short tween (view cube orientations, entering a sketch). Resolves
     * when the camera is there; an interaction or another animation cuts it short at its
     * current frame. Falls back to the instant `lookAt` where motion is reduced.
     */
    animateLookAt(eye: XYZLike, target: XYZLike, up: XYZLike, duration?: number): Promise<void>;
    pan(dx: number, dy: number): void;
    startRotate(x: number, y: number): void;
    rotate(dx: number, dy: number, mode?: "trackball" | "turntable"): void;
    zoom(x: number, y: number, delta: number): void;
    updateCameraPosionTarget(): void;
}
