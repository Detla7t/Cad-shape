// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The UI's motion, in one place: panels slide and fade in and out, tabs cross-fade, the
 * camera tweens. Everything here honours the platform's reduced-motion setting (then every
 * transition lands at once) and degrades to an instant change where the DOM cannot animate
 * (a detached element, a test).
 */

/** Longest a leave animation may take before its element is removed anyway. */
const LEAVE_TIMEOUT_MS = 260;

/** Whether the user asked the platform for less motion. */
export function motionEnabled(): boolean {
    return !(
        typeof globalThis.matchMedia === "function" &&
        globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
}

/**
 * Plays an element's leave animation — `className` (or `data-leaving` when none is given)
 * starts it — and calls `done` when it ends, or at once where nothing animates. `done` is
 * called exactly once; a second `leave` on the same element before the first ends is ignored.
 */
export function leave(element: HTMLElement, done: () => void, className?: string): void {
    if (element.dataset["leaving"] === "true") return;
    if (!motionEnabled() || !element.isConnected || typeof element.animate !== "function") {
        done();
        return;
    }
    element.dataset["leaving"] = "true";
    if (className !== undefined) element.classList.add(className);
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        element.removeEventListener("animationend", finish);
        element.removeEventListener("transitionend", finish);
        delete element.dataset["leaving"];
        if (className !== undefined) element.classList.remove(className);
        done();
    };
    element.addEventListener("animationend", finish);
    element.addEventListener("transitionend", finish);
    setTimeout(finish, LEAVE_TIMEOUT_MS);
}
