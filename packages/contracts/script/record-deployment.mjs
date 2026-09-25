// Records a real Sepolia deployment from forge's broadcast receipts after checking each
// transaction succeeded on-chain. Refuses to write anything without a broadcast and an RPC URL.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const broadcast = join(root, "broadcast/Deploy.s.sol/11155111/run-latest.json");
const rpcUrl = process.env.SEPOLIA_RPC_URL;
if (!rpcUrl) throw new Error("SEPOLIA_RPC_URL is required to verify receipts");
if (!existsSync(broadcast))
  throw new Error(`no broadcast found at ${broadcast}; nothing was deployed`);

async function rpc(method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

if ((await rpc("eth_chainId", [])) !== "0xaa36a7")
  throw new Error("RPC is not Sepolia");
const run = JSON.parse(readFileSync(broadcast, "utf8"));
const transactions = [];
for (const tx of run.transactions) {
  const receipt = await rpc("eth_getTransactionReceipt", [tx.hash]);
  if (!receipt || receipt.status !== "0x1")
    throw new Error(`transaction ${tx.hash} not successful on Sepolia`);
  transactions.push({
    hash: tx.hash,
    type: tx.transactionType,
    contractName: tx.contractName ?? null,
    contractAddress: tx.contractAddress ?? null,
    function: tx.function ?? null,
    blockNumber: Number.parseInt(receipt.blockNumber, 16),
  });
}
const created = transactions.find(
  (t) => t.contractName === "HumanOSRegistrar" && t.type === "CREATE",
);
if (!created) throw new Error("broadcast has no HumanOSRegistrar creation");
if ((await rpc("eth_getCode", [created.contractAddress, "latest"])) === "0x") {
  throw new Error("HumanOSRegistrar has no code on Sepolia");
}
// HUMANOS_REGISTRY() selector 0x8f1f8aeb
const registryWord = await rpc("eth_call", [
  { to: created.contractAddress, data: "0x8f1f8aeb" },
  "latest",
]);
const humanosRegistry = "0x" + registryWord.slice(-40);
const out = {
  network: "sepolia",
  chainId: 11155111,
  recordedAt: new Date().toISOString(),
  officialEnsv2: "deployments/ensv2-sepolia.json",
  registrar: created.contractAddress,
  humanosRegistry,
  transactions,
};
writeFileSync(
  join(root, "deployments/humanos-sepolia.json"),
  JSON.stringify(out, null, 2) + "\n",
);
console.log("recorded deployments/humanos-sepolia.json");
