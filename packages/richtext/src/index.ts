// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * `@chili3d/richtext`: word-processing documents, without UI.
 *
 * - `blocks.ts`: the editable subset of a document (paragraphs, runs, lists, tables, images)
 *   reduced from the rich-text editor's HTML (`htmlToBlocks`, needs a DOM) and its plain text.
 * - `sanitize.ts`: the allowlist HTML sanitizer for untrusted HTML (converted files, pastes,
 *   Markdown previews).
 * - `docx.ts`: DOCX read (mammoth) and write (`docx`); both libraries load on first use.
 * - `odt.ts`: ODT read and write over the shared ODF package of `@chili3d/office-io`.
 *
 * Every module is also reachable as `@chili3d/richtext/<module>`.
 */

export * from "./blocks";
export * from "./docx";
export * from "./odt";
export * from "./sanitize";
