// 预审应用服务：把规则引擎、事件存储、材料存储和状态机接在一起。
// 所有改变状态的动作都先落事件日志（fsync）再更新内存，
// 重新 new 一个 PreReviewService 指向同一目录即完成"崩溃后续跑"。

import path from "node:path";
import { EventStore } from "./store.js";
import { BlobStore } from "./blobs.js";
import { evaluate, RULE } from "./rules.js";
import { fold, activeMaterials, STATUS, FINAL } from "./state.js";
import {
  birthCertificateSnippet,
  guardianSnippet,
  householdSnippet,
} from "./redact.js";
import { shortHash, sha256Text } from "./hash.js";

export class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

// 内容内禀、不随申报日期变化的检查可复用；时限与证件有效期依赖当天日期，每次重算。
// 跨材料规则的复用键必须覆盖其全部输入材料指纹。
const CONTENT_RULES = new Set([
  RULE.REGISTRY_ZONE,
  RULE.BIRTH_DATE_NORMALIZED,
  RULE.GUARDIAN_RELATION,
  RULE.GUARDIAN_NAME_CHAIN,
]);

export class PreReviewService {
  constructor({ dataDir, now } = {}) {
    this.clock = now ?? (() => new Date());
    const dir = dataDir ?? path.join(process.cwd(), "data");
    this.events = new EventStore(path.join(dir, "eventlog"));
    this.blobs = new BlobStore(path.join(dir, "materials"));
  }

  async init() {
    await this.events.init();
    await this.blobs.init();
    return this;
  }

  // ---------- 查询 ----------

  getState(applicationId) {
    return fold(this.events.eventsOf(applicationId), applicationId);
  }

  listApplications() {
    const ids = new Set(this.events.allEvents().map((e) => e.applicationId));
    return [...ids].map((id) => {
      const s = this.getState(id);
      return {
        applicationId: id,
        status: s.status,
        registryZone: s.registryZone ?? null,
        materialCount: Object.keys(s.materials).length,
        reviewCount: s.reviews.length,
        finalDecision: s.finalDecision,
      };
    });
  }

  // 逐条可复核的审查轨迹（重放得到，不依赖进程内存）
  getTrace(applicationId) {
    const s = this.getState(applicationId);
    return {
      applicationId,
      registryZone: s.registryZone ?? null,
      status: s.status,
      materials: Object.fromEntries(
        Object.entries(s.materials).map(([id, m]) => [
          id,
          {
            kind: m.kind,
            activeVersion: m.activeFp
              ? m.versions.find((v) => v.fingerprint === m.activeFp)?.version ?? null
              : null,
            activeFingerprint: m.activeFp ? shortHash(m.activeFp) : null,
            withdrawn: m.activeFp === null,
            versionCount: m.versions.length,
            versions: m.versions.map((v) => ({
              version: v.version,
              fingerprint: shortHash(v.fingerprint),
              at: v.at,
            })),
            withdrawalTrail: m.withdrawn,
          },
        ]),
      ),
      validationCache: Object.entries(s.validationCache).map(([key, v]) => {
        const [rule, signature] = key.split(":");
        return { rule, inputs: v.inputs, signature: shortHash(signature), firstValidatedAt: v.firstValidatedAt, status: v.status };
      }),
      reviews: s.reviews,
      manual: s.manual,
      finalDecision: s.finalDecision,
      registration: s.registration,
    };
  }

  // ---------- 写操作 ----------

  async openApplication({ applicationId, registryZone }) {
    if (this.events.eventsOf(applicationId).length > 0) {
      throw new ServiceError(
        "APPLICATION_EXISTS",
        `申请 ${applicationId} 已存在且保留完整审查记录，禁止重新提交覆盖`,
      );
    }
    if (!registryZone) throw new ServiceError("BAD_INPUT", "缺少登记地时区 registryZone");
    await this.events.append(applicationId, "APPLICATION_OPENED", { registryZone });
    return this.getState(applicationId);
  }

  async submitMaterial(applicationId, materialId, kind, payload) {
    const s = this.getState(applicationId);
    if (!s.registryZone) throw new ServiceError("NOT_FOUND", `申请 ${applicationId} 不存在`);
    if (s.status === STATUS.REGISTERED) {
      throw new ServiceError(
        "REGISTERED_LOCKED",
        "登记已完成，不接收材料变动（如需更正请走登记后更正流程）",
      );
    }
    if (!payload || typeof payload !== "object") {
      throw new ServiceError("BAD_INPUT", "材料内容必须是 JSON 对象");
    }
    const fp = await this.blobs.put(payload);
    const evt = await this.events.append(applicationId, "MATERIAL_UPLOADED", {
      materialId,
      kind,
      fingerprint: fp,
    });
    const after = this.getState(applicationId);
    return {
      materialId,
      kind,
      reused: evt.data.fingerprint === fp && after.lastUpload?.reused,
      version: after.lastUpload.version,
      fingerprint: shortHash(fp),
    };
  }

  async withdrawMaterial(applicationId, materialId, reason) {
    const s = this.getState(applicationId);
    if (!s.registryZone) throw new ServiceError("NOT_FOUND", `申请 ${applicationId} 不存在`);
    const m = s.materials[materialId];
    if (!m) throw new ServiceError("MATERIAL_NOT_FOUND", `材料 ${materialId} 不存在`);
    // 登记完成后允许登记撤回动作，但仅留痕：决定与登记绝不倒退
    const afterFinal = FINAL.has(s.status);
    await this.events.append(applicationId, "MATERIAL_WITHDRAWN", {
      materialId,
      kind: m.kind,
      reason: reason ?? null,
      afterFinal,
    });
    return {
      materialId,
      afterFinal,
      effective: !afterFinal, // 终态后撤回仅留痕，不影响决定
    };
  }

  // 组装当前有效材料快照（材料正文从内容存储按指纹取回）
  async #buildSnapshot(state) {
    const active = activeMaterials(state);
    const byKind = {};
    const fpByMaterial = {};
    for (const [materialId, info] of Object.entries(active)) {
      (byKind[info.kind] ??= []).push({ materialId, ...info });
      fpByMaterial[materialId] = info.fingerprint;
    }
    const snapshot = { guardians: [] };
    const materialOfGuardian = [];

    const bcEntry = byKind["birth_certificate"]?.[0];
    if (bcEntry) {
      const bc = await this.blobs.get(fpByMaterial[bcEntry.materialId]);
      snapshot.birthCertificate = {
        ...bc,
        registryZone: state.registryZone, // 登记地以受理窗口为准
      };
    }
    const hhEntry = byKind["household_relation"]?.[0];
    if (hhEntry) {
      snapshot.household = await this.blobs.get(fpByMaterial[hhEntry.materialId]);
    }
    for (const gEntry of byKind["guardian_identity"] ?? []) {
      const g = await this.blobs.get(fpByMaterial[gEntry.materialId]);
      const guardianIndex = snapshot.guardians.length;
      snapshot.guardians.push({ ...g, guardianIndex });
      materialOfGuardian[guardianIndex] = { materialId: gEntry.materialId, version: gEntry.version };
    }
    return { snapshot, materialOfGuardian, active };
  }

  async runReview(applicationId) {
    const state = this.getState(applicationId);
    if (!state.registryZone) throw new ServiceError("NOT_FOUND", `申请 ${applicationId} 不存在`);
    if (state.status === STATUS.MANUAL_REVIEW) {
      throw new ServiceError("MANUAL_OWNERSHIP", "案件已由人工接管，预审不再下结论");
    }
    if (FINAL.has(state.status)) {
      throw new ServiceError("FINAL_LOCKED", `案件已作最终决定（${state.status}），不可重新预审`);
    }

    const { snapshot, materialOfGuardian, active } = await this.#buildSnapshot(state);
    const evaluated = evaluate(snapshot, { now: this.clock() });

    const pickByKind = (kind) => {
      const found = Object.entries(active).find(([, i]) => i.kind === kind);
      return found ? { materialId: found[0], ...found[1] } : null;
    };
    const bcMaterial = pickByKind("birth_certificate");
    const hhMaterial = pickByKind("household_relation");
    const cacheUpdates = {};
    const reused = [];
    const reusedSet = new Set();

    // 计算每条规则的输入材料集合，复用键覆盖全部输入指纹
    const inputsOf = new Map(); // result 对象 -> [{materialId, kind, fp, version}]
    for (const r of evaluated.results) {
      const inputs = [];
      if (r.guardianIndex !== undefined) {
        const gm = materialOfGuardian[r.guardianIndex];
        if (gm) inputs.push({ materialId: gm.materialId, kind: "guardian_identity", version: gm.version, fp: active[gm.materialId].fingerprint });
        if ((r.code === RULE.GUARDIAN_RELATION || r.code === RULE.GUARDIAN_NAME_CHAIN) && hhMaterial) {
          inputs.push({ materialId: hhMaterial.materialId, kind: "household_relation", version: hhMaterial.version, fp: hhMaterial.fingerprint });
        }
      } else if (
        r.code === RULE.BIRTH_DATE_NORMALIZED ||
        r.code === RULE.BIRTH_DEADLINE ||
        r.code === RULE.REGISTRY_ZONE
      ) {
        if (bcMaterial) {
          inputs.push({ materialId: bcMaterial.materialId, kind: "birth_certificate", version: bcMaterial.version, fp: bcMaterial.fingerprint });
        }
        if (r.code === RULE.REGISTRY_ZONE && hhMaterial) {
          inputs.push({ materialId: hhMaterial.materialId, kind: "household_relation", version: hhMaterial.version, fp: hhMaterial.fingerprint });
        }
      }
      inputsOf.set(r, inputs);
      r.materialId = inputs[0]?.materialId ?? null;
    }

    for (const r of evaluated.results) {
      if (!CONTENT_RULES.has(r.code)) continue; // 时限/有效期依赖当天日期，每次重算
      const inputs = inputsOf.get(r);
      if (inputs.length === 0) continue;
      const signature = sha256Text(
        inputs
          .map((i) => `${i.kind}:${i.fp}`)
          .sort()
          .join("|"),
      );
      const cacheKey = `${r.code}:${signature}`;
      const cached = state.validationCache[cacheKey];
      if (cached) {
        // 同一输入组合曾校验过：复用原结论（通过仍是通过，缺曾用名佐证仍需补正）
        r.status = cached.status;
        r.detail = cached.detail;
        r.evidence = cached.evidence;
        r.reusedValidatedAt = cached.firstValidatedAt;
        for (const i of inputs) reusedSet.add(i.materialId);
      } else {
        cacheUpdates[cacheKey] = {
          firstValidatedAt: new Date().toISOString(),
          inputs: inputs.map((i) => ({ kind: i.kind, fingerprint: shortHash(i.fp) })),
          status: r.status,
          detail: r.detail,
          evidence: r.evidence,
        };
      }
    }
    for (const materialId of reusedSet) {
      const info = active[materialId];
      reused.push({ materialId, kind: info.kind, version: info.version });
    }

    // 日志片段：未成年人/监护人信息仅保留掩码后的必要字段
    const normEvidence = evaluated.results.find(
      (r) => r.code === RULE.BIRTH_DATE_NORMALIZED,
    )?.evidence;
    const snippets = {
      birthCertificate: birthCertificateSnippet({
        ...snapshot.birthCertificate,
        registryBirthDate: normEvidence?.registryBirthDate ?? null,
        hospitalBirthDate: normEvidence?.hospitalBirthDate ?? null,
        dateShifted: normEvidence
          ? normEvidence.hospitalBirthDate !== normEvidence.registryBirthDate
          : false,
      }),
      household: householdSnippet(
        snapshot.household,
        evaluated.results.find((r) => r.code === RULE.GUARDIAN_RELATION)?.status ?? null,
      ),
      guardians: snapshot.guardians.map((g) => {
        const expiry = evaluated.results.find(
          (r) => r.guardianIndex === g.guardianIndex && r.code === RULE.GUARDIAN_ID_EXPIRY,
        );
        return guardianSnippet(g, expiry?.status ?? null);
      }),
    };

    const materialFps = Object.fromEntries(
      Object.entries(active).map(([id, i]) => [id, shortHash(i.fingerprint)]),
    );

    await this.events.append(applicationId, "REVIEW_RECORDED", {
      decision: evaluated.decision,
      today: evaluated.today,
      results: evaluated.results,
      materialFps,
      reused,
      cacheUpdates,
      snippets,
    });

    return {
      decision: evaluated.decision,
      today: evaluated.today,
      results: evaluated.results,
      reused,
      snippets,
      state: this.getState(applicationId).status,
    };
  }

  async takeManual(applicationId, { officer, reason } = {}) {
    const s = this.getState(applicationId);
    if (!s.registryZone) throw new ServiceError("NOT_FOUND", `申请 ${applicationId} 不存在`);
    if (s.status === STATUS.REGISTERED) throw new ServiceError("REGISTERED_LOCKED", "登记已完成");
    if (FINAL.has(s.status)) throw new ServiceError("FINAL_LOCKED", "案件已作最终决定");
    if (!officer) throw new ServiceError("BAD_INPUT", "缺少接管人员 officer");
    await this.events.append(applicationId, "MANUAL_TAKEOVER", { officer, reason: reason ?? null });
    return this.getState(applicationId).manual;
  }

  async manualDecide(applicationId, { officer, outcome, reason } = {}) {
    const s = this.getState(applicationId);
    if (s.status !== STATUS.MANUAL_REVIEW) {
      throw new ServiceError("NOT_MANUAL", "仅人工接管中的案件可作出人工决定");
    }
    if (!officer) throw new ServiceError("BAD_INPUT", "缺少经办人 officer");
    if (outcome !== "approved" && outcome !== "rejected") {
      throw new ServiceError("BAD_INPUT", "outcome 必须是 approved 或 rejected");
    }
    await this.events.append(applicationId, "MANUAL_DECISION", {
      officer,
      outcome,
      reason: reason ?? null,
    });
    return this.getState(applicationId).finalDecision;
  }

  async addNote(applicationId, { officer, text } = {}) {
    const s = this.getState(applicationId);
    if (s.status !== STATUS.MANUAL_REVIEW) {
      throw new ServiceError("NOT_MANUAL", "仅人工接管中的案件可作办案记录");
    }
    if (!officer || !text) throw new ServiceError("BAD_INPUT", "缺少 officer 或 text");
    await this.events.append(applicationId, "CASE_NOTE", { officer, text });
    return this.getState(applicationId).manual.history;
  }

  async completeRegistration(applicationId, { officer, registrationNo } = {}) {
    const s = this.getState(applicationId);
    if (![STATUS.READY, STATUS.FINAL_APPROVED].includes(s.status)) {
      throw new ServiceError(
        "NOT_APPROVED",
        `当前状态 ${s.status} 不允许完成登记（需 READY 或 FINAL_APPROVED）`,
      );
    }
    if (!officer || !registrationNo) throw new ServiceError("BAD_INPUT", "缺少 officer 或 registrationNo");
    await this.events.append(applicationId, "REGISTRATION_COMPLETED", { officer, registrationNo });
    return this.getState(applicationId).registration;
  }
}

export { RULE };
