import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
const children = [];
for (const [name, port] of [
  ["api", 3001],
  ["agent", 3002],
  ["demo-service", 3003],
  ["web", 5173],
]) {
  if (name === "demo-service" && !process.env.DEMO_SERVICE_SECRET) {
    console.log("Protected service unavailable: DEMO_SERVICE_SECRET missing");
    continue;
  }
  const child = spawn("pnpm", ["--filter", `@humanos/${name}`, "dev"], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(port) },
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code) console.error(`${name} exited with ${code}`);
  });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(0);
  });
