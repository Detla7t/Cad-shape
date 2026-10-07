// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Shows or hides an element of the element area. Inline rather than a class: the views and
 * the Part Studio carry layout classes of their own (`display: flex`) that a utility class
 * of equal specificity would lose to, and hiding must win without `!important`.
 */
export function setShown(element: HTMLElement, shown: boolean): void {
    element.style.display = shown ? "" : "none";
}
