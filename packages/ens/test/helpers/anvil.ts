import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAddress, type Address } from "viem";

export const CONTRACTS_DIR = resolve(import.meta.dirname, "../../../contracts");

/** Anvil's documented default dev account #0 (public test key, local chain only). */
export const ANVIL_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function foundryBin(name: string): string {
  const fromHome = join(homedir(), ".foundry/bin", name);
  try {
    return (
      execFileSync("which", [name], { encoding: "utf8" }).trim() || fromHome
    );
  } catch {
    if (existsSync(fromHome)) return fromHome;
    throw new Error(
      `${name} not found; install Foundry via foundryup (https://getfoundry.sh)`,
    );
  }
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.unref();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? ok(address.port)
          : fail(new Error("no port")),
      );
    });
  });
}

export interface LocalDeployment {
  rpcUrl: string;
  registrar: Address;
  universalResolver: Address;
  ethRegistry: Address;
  humanosRegistry: Address;
  stop: () => void;
}

export async function startLocalEnsv2(
  parentExpiry: bigint,
): Promise<LocalDeployment> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn(
    foundryBin("anvil"),
    ["--port", String(port), "--silent"],
    { stdio: "ignore" },
  );
  const stop = () => anvil.kill("SIGTERM");
  try {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: [],
          }),
        });
        if (res.ok) break;
      } catch {
        if (i > 100) throw new Error("anvil did not start");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    mkdirSync(join(CONTRACTS_DIR, "deployments/.local"), { recursive: true });
    const out = join("deployments/.local", `${port}.json`);
    execFileSync(
      join(CONTRACTS_DIR, "script/forge.sh"),
      [
        "script",
        "script/DeployLocal.s.sol:DeployLocal",
        "--rpc-url",
        rpcUrl,
        "--broadcast",
        "--silent",
      ],
      {
        cwd: CONTRACTS_DIR,
        stdio: "pipe",
        env: {
          ...process.env,
          PATH: `${join(homedir(), ".foundry/bin")}:${process.env.PATH ?? ""}`,
          LOCAL_DEPLOYER_PRIVATE_KEY: ANVIL_KEY_0,
          LOCAL_DEPLOYMENT_OUT: out,
          LOCAL_PARENT_EXPIRY: parentExpiry.toString(),
        },
      },
    );
    const json = JSON.parse(readFileSync(join(CONTRACTS_DIR, out), "utf8"));
    return {
      rpcUrl,
      registrar: getAddress(json.registrar),
      universalResolver: getAddress(json.universalResolver),
      ethRegistry: getAddress(json.ethRegistry),
      humanosRegistry: getAddress(json.humanosRegistry),
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
