import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Hex } from "./domain.js";
/** HumanOS canonical JSON v1: UTF-16 sorted object keys, JSON primitive encoding. */
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Non-finite number");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") throw new TypeError("Unsupported JSON value");
    if (ancestors.has(item)) throw new TypeError("Cyclic JSON value");
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null)
      throw new TypeError("Expected plain object");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Reflect.ownKeys(item).length !== item.length + 1)
          throw new TypeError("Sparse or decorated array");
        const values: string[] = [];
        for (let i = 0; i < item.length; i++) {
          const d = Object.getOwnPropertyDescriptor(item, String(i));
          if (!d || !("value" in d) || !d.enumerable)
            throw new TypeError("Sparse or accessor array");
          values.push(encode(d.value));
        }
        return "[" + values.join(",") + "]";
      }
      const keys = Reflect.ownKeys(item);
      if (keys.some((k) => typeof k !== "string"))
        throw new TypeError("Symbol keys are unsupported");
      return (
        "{" +
        (keys as string[])
          .sort()
          .map((key) => {
            const d = Object.getOwnPropertyDescriptor(item, key);
            if (!d || !("value" in d) || !d.enumerable)
              throw new TypeError("Non-data property");
            return JSON.stringify(key) + ":" + encode(d.value);
          })
          .join(",") +
        "}"
      );
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}
/** SHA-256 is the only action payload/approval/audit digest algorithm. */
export function hashCanonical(value: unknown): Hex {
  return `0x${bytesToHex(sha256(utf8ToBytes(canonicalize(value))))}`;
}
/** Keccak-256 is reserved for explicitly specified EVM commitments; never approval hashes. */
export function keccakCanonical(value: unknown): Hex {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(canonicalize(value))))}`;
}
