// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The End Cap Configurator lives in the CAD now (a configured Part Studio); old links to this
 * page open its public template there.
 */
export const metadata = { title: "End Cap Configurator · Chili3D" };

export default function EndCapPage() {
    return (
        <>
            <meta httpEquiv="refresh" content="0; url=../?template=end-cap-configurator" />
            <p>
                The End Cap Configurator is in the CAD:{" "}
                <a href="../?template=end-cap-configurator">open it</a>.
            </p>
        </>
    );
}
