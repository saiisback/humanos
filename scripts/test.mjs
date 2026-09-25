import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
if (existsSync(".env")) process.loadEnvFile(".env");
const result = spawnSync("pnpm", ["-r", "--if-present", "test"], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
