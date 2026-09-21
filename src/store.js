// 仅追加事件日志（JSONL）+ fsync，崩溃后重放恢复全部状态。
// 每个事件一行 JSON：{ seq, type, at, applicationId, data, eventId }
// 进程中断后只允许从日志重放继续，禁止用"重新提交申请"绕过丢失的审查过程。

import {
  mkdir,
  open,
  readFile,
  rename,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = 0;

export class EventStore {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, "events.log");
    this.tmpPath = path.join(dir, "events.log.tmp");
    this.events = [];
    this.#chains = new Map(); // applicationId -> Promise（串行化同一申请的写入）
  }

  #chains;

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      await access(this.logPath, constants.F_OK);
    } catch {
      // 首次运行：写一个文件头，不占事件序号
      const fh = await open(this.logPath, "a");
      try {
        await fh.writeFile(
          JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "header", at: new Date().toISOString() }) +
            "\n",
        );
        await fh.sync();
      } finally {
        await fh.close();
      }
    }
    this.events = await this.#replay();
  }

  async #replay() {
    const raw = await readFile(this.logPath, "utf8");
    const lines = raw.split("\n");
    const events = [];
    let goodBytes = 0;
    let torn = 0;
    for (const line of lines) {
      if (line === "") continue;
      try {
        const evt = JSON.parse(line);
        if (evt.kind === "header") {
          goodBytes += Buffer.byteLength(line, "utf8") + 1;
          continue;
        }
        events.push(evt);
        goodBytes += Buffer.byteLength(line, "utf8") + 1;
      } catch {
        // 崩溃可能导致最后一行半写：截断到最后一个完整事件
        torn += 1;
      }
    }
    if (torn > 0) {
      // 将完整前缀落盘，丢弃半写尾部
      const fh = await open(this.logPath, "r");
      try {
        const buf = Buffer.alloc(goodBytes);
        await fh.read(buf, 0, goodBytes, 0);
        const out = await open(this.tmpPath, "w");
        try {
          await out.writeFile(buf);
          await out.sync();
        } finally {
          await out.close();
        }
      } finally {
        await fh.close();
      }
      await rename(this.tmpPath, this.logPath);
    }
    return events;
  }

  eventsOf(applicationId) {
    return this.events.filter((e) => e.applicationId === applicationId);
  }

  allEvents() {
    return [...this.events];
  }

  // 串行化同一申请的追加，返回重放后的该申请事件列表
  async append(applicationId, type, data) {
    const prev = this.#chains.get(applicationId) ?? Promise.resolve();
    const next = prev.then(() => this.#appendSync(applicationId, type, data));
    // 队列失败不阻塞后续操作：记录一个已处理的拒绝
    this.#chains.set(
      applicationId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  async #appendSync(applicationId, type, data) {
    const seq = this.events.length + 1;
    const event = {
      eventId: randomUUID(),
      seq,
      type,
      at: new Date().toISOString(),
      applicationId,
      data,
    };
    const line = JSON.stringify(event) + "\n";
    // 先追加并 fsync，成功后才进入内存视图 —— 崩溃时以磁盘为准
    const fh = await open(this.logPath, "a");
    try {
      await fh.writeFile(line);
      await fh.sync();
    } finally {
      await fh.close();
    }
    this.events.push(event);
    return event;
  }
}
