// 材料内容寻址存储：事件日志里只留指纹，完整载荷以指纹为名单独存放，
// 使"日志只出现必要片段"与"重放可重建审查快照"两者兼得。

import { mkdir, readFile, writeFile, access, rename } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fingerprint } from "./hash.js";

export class BlobStore {
  constructor(dir) {
    this.dir = dir;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  #path(fp) {
    if (!/^[0-9a-f]{64}$/.test(fp)) throw new Error("非法材料指纹");
    return path.join(this.dir, fp + ".json");
  }

  async put(payload) {
    const fp = fingerprint(payload);
    const p = this.#path(fp);
    try {
      await access(p, constants.F_OK);
    } catch {
      // 先写临时文件再 rename，避免崩溃留下半截材料
      const tmp = p + ".tmp";
      await writeFile(tmp, JSON.stringify(payload), "utf8");
      await rename(tmp, p);
    }
    return fp;
  }

  async get(fp) {
    return JSON.parse(await readFile(this.#path(fp), "utf8"));
  }
}
