import { createHash } from "node:crypto";

// 规范 JSON：键排序后序列化，保证 {a:1,b:2} 与 {b:2,a:1} 视为同一材料
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function fingerprint(value) {
  return sha256Text(canonicalJson(value));
}

export function shortHash(hash) {
  return hash.slice(0, 10);
}
