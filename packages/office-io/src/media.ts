// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Picture parts of office packages (`xl/media/…`, `Pictures/…`): media types by file extension. */

export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    webp: "image/webp",
    tif: "image/tiff",
    tiff: "image/tiff",
    emf: "image/x-emf",
    wmf: "image/x-wmf",
};

/** The extension a picture of a media type is written with. */
export const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/webp": "webp",
    "image/tiff": "tiff",
    "image/x-emf": "emf",
    "image/x-wmf": "wmf",
};

/** The lower-case extension of a package path ("xl/media/Image1.PNG" → "png"); "" without one. */
export function extensionOf(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The media type of a picture part by its extension; undefined when it is not a known picture. */
export function imageMimeOf(path: string): string | undefined {
    return IMAGE_MIME_BY_EXTENSION[extensionOf(path)];
}
