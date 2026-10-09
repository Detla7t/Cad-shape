// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EndCapConfigurator } from "../../src/endcap/endCapConfigurator";

export const metadata = {
    title: "End Cap Configurator · Chili3D",
    description:
        "Round duct end caps and reducing end caps as flat patterns: preview, DXF export, open in the CAD.",
};

export default function EndCapPage() {
    return <EndCapConfigurator />;
}
