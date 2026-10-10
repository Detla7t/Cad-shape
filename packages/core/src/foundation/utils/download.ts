// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** A file the application hands out: an export, a saved document, a program. */
export interface DownloadedFile {
    readonly blob: Blob;
    readonly name: string;
}

/**
 * Decides where a `download()` goes. Return true when the file was taken care of (sent to the
 * desktop bridge, …) and false for the browser download; a rejected promise also falls back to the
 * browser download.
 */
export type DownloadDelivery = (file: DownloadedFile) => boolean | Promise<boolean>;

let delivery: DownloadDelivery | undefined;

/** Routes every `download()` through `handler` (the UI installs the desktop bridge delivery). */
export function setDownloadDelivery(handler: DownloadDelivery | undefined) {
    delivery = handler;
}

/** Hands `data` to the user as a file named `name`: through the installed delivery, else as a browser download. */
export function download(data: BlobPart[], name: string) {
    const blob = new Blob(data);
    if (!delivery) {
        browserDownload(blob, name);
        return;
    }
    let handled: boolean | Promise<boolean>;
    try {
        handled = delivery({ blob, name });
    } catch {
        handled = false;
    }
    if (typeof handled === "boolean") {
        if (!handled) browserDownload(blob, name);
        return;
    }
    void handled.then(
        (taken) => {
            if (!taken) browserDownload(blob, name);
        },
        () => browserDownload(blob, name),
    );
}

/** The plain browser download (a click on a hidden link). */
export function browserDownload(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement("a");
        a.style.visibility = "hidden";
        a.href = url;
        a.download = name;
        a.click();
    } finally {
        URL.revokeObjectURL(url);
    }
}
