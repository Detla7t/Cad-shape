// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export class Constants {
    static readonly DBName = "chili3d-db";
    static readonly DocumentTable = "documents";
    static readonly RecentTable = "recents";
    /** Dashboard organization, independent of saved document geometry and history. */
    static readonly LibraryTable = "documentLibrary";
    /** Version history per document: a manifest under the document id plus object packs. */
    static readonly HistoryTable = "history";
    /** Geometry of linked parts (other documents' parts at a version), by source, commit and node. */
    static readonly LinkCacheTable = "linkCache";
}
