import { expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSiweMessage } from "viem/siwe";
import { createSepoliaSiweVerifier } from "../src/services/siwe.js";

const message = createSiweMessage({
  address: "0x1111111111111111111111111111111111111111",
  chainId: 11155111,
  domain: "localhost:5173",
  uri: "http://localhost:5173",
  version: "1",
  nonce: "0123456789abcdef0123456789abcdef",
  issuedAt: new Date(),
  expirationTime: new Date(Date.now() + 300000),
});
const signature = `0x${"00".repeat(65)}`;

it("classifies an unreachable Sepolia RPC as unavailable for a contract account", async () => {
  const verifier = createSepoliaSiweVerifier("http://127.0.0.1:1");
  await expect(verifier.verify({ message, signature })).rejects.toMatchObject({
    reason: "unavailable",
  });
}, 15000);

async function withRpc(
  chainId: string,
  run: (url: string) => Promise<void>,
  options: { callStatus?: number } = {},
) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      id: number;
      method: string;
    };
    if (body.method === "eth_call" && options.callStatus) {
      response.writeHead(options.callStatus);
      response.end("temporary RPC outage");
      return;
    }
    const result = body.method === "eth_chainId" ? chainId : "0x0";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("refuses a reachable RPC on a chain other than Sepolia", async () => {
  await withRpc("0x1", async (url) => {
    await expect(
      createSepoliaSiweVerifier(url).verify({ message, signature }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
});

it("retains an eth_call transport failure when chain ID remains available", async () => {
  await withRpc(
    "0xaa36a7",
    async (url) => {
      await expect(
        createSepoliaSiweVerifier(url).verify({ message, signature }),
      ).rejects.toMatchObject({ reason: "unavailable" });
    },
    { callStatus: 503 },
  );
}, 15000);

it("keeps a reachable Sepolia invalid signature distinct from an outage", async () => {
  await withRpc("0xaa36a7", async (url) => {
    await expect(
      createSepoliaSiweVerifier(url).verify({ message, signature }),
    ).rejects.toMatchObject({ reason: "invalid_signature" });
  });
});
