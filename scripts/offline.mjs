// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawnSync } from "node:child_process";

// A private network namespace gives the entire process tree (including workers and
// native libraries) only loopback. The host and the user's other work stay connected.
const command = process.argv.slice(2);
if (!command.length) throw new Error("Usage: node scripts/offline.mjs <command> [arguments...]");
if (process.platform !== "linux")
    throw new Error("Strict offline checks require Linux with unshare and ip (or a Linux VM/WSL).");
const result = spawnSync(
    "unshare",
    [
        "--user",
        "--map-root-user",
        "--net",
        "--",
        "sh",
        "-eu",
        "-c",
        'ip link set lo up; exec "$@"',
        "chili-offline",
        ...command,
    ],
    {
        stdio: "inherit",
        env: {
            ...process.env,
            npm_config_offline: "true",
            npm_config_audit: "false",
            npm_config_fund: "false",
            CARGO_NET_OFFLINE: "true",
        },
    },
);
if (result.error) throw result.error;
if (result.status !== 0) console.error("Offline command failed. No online fallback was attempted.");
process.exitCode = result.status ?? 1;
