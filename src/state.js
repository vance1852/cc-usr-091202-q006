// 事件重放 -> 申请状态机。所有持久状态都由事件日志归约得到，
// 进程重启后重新折叠事件即可从原状态继续。

export const STATUS = {
  INTAKE: "INTAKE", // 收件中，材料不齐
  PENDING_CORRECTION: "PENDING_CORRECTION", // 预审结论：补正
  READY: "READY", // 预审通过，待办理/可转人工
  MANUAL_REVIEW: "MANUAL_REVIEW", // 人工接管中
  FINAL_APPROVED: "FINAL_APPROVED", // 人工/预审最终核准
  FINAL_REJECTED: "FINAL_REJECTED", // 人工最终拒绝
  REGISTERED: "REGISTERED", // 登记完成（终态）
};

// 终态：任何材料变动都不得令其倒退
const TERMINAL = new Set([STATUS.REGISTERED]);
const FINAL = new Set([STATUS.FINAL_APPROVED, STATUS.FINAL_REJECTED, STATUS.REGISTERED]);

export function initialState(applicationId) {
  return {
    applicationId,
    status: STATUS.INTAKE,
    materials: {}, // materialId -> { kind, versions:[{version, fingerprint, at}], activeFp, withdrawn: [{at, reason, afterFinal}] }
    reviews: [], // 每次预审记录
    validationCache: {}, // "materialId@fingerprint" -> { version, firstValidatedAt, ruleCodes }
    manual: { takenOverBy: null, takenOverAt: null, reason: null, history: [] },
    finalDecision: null, // { outcome, by, at, reason }
    registration: null, // { registrationNo, by, at }
  };
}

function activeMaterials(state) {
  const out = {};
  for (const [id, m] of Object.entries(state.materials)) {
    if (m.activeFp) out[id] = { kind: m.kind, fingerprint: m.activeFp, version: m.versions.at(-1).version };
  }
  return out;
}

export function reduce(state, evt) {
  const { type, at, data } = evt;
  switch (type) {
    case "APPLICATION_OPENED":
      state.registryZone = data.registryZone;
      state.openedAt = at;
      return state;

    case "MATERIAL_UPLOADED": {
      const existing = state.materials[data.materialId];
      if (!existing) {
        state.materials[data.materialId] = {
          kind: data.kind,
          versions: [{ version: 1, fingerprint: data.fingerprint, at }],
          activeFp: data.fingerprint,
          withdrawn: [],
        };
        state.lastUpload = { materialId: data.materialId, reused: false, version: 1, at };
        return state;
      }
      const hit = existing.versions.find((v) => v.fingerprint === data.fingerprint);
      if (hit) {
        // 同一材料重复上传（含撤回后重新提交同一内容）：复用原版本与原校验，仅重新激活
        existing.activeFp = data.fingerprint;
        state.lastUpload = { materialId: data.materialId, reused: true, version: hit.version, at };
        return state;
      }
      // 新的补充材料形成新版本
      const version = existing.versions.length + 1;
      existing.versions.push({ version, fingerprint: data.fingerprint, at });
      existing.activeFp = data.fingerprint;
      state.lastUpload = { materialId: data.materialId, reused: false, version, at };
      return state;
    }

    case "MATERIAL_WITHDRAWN": {
      const m = state.materials[data.materialId];
      if (!m) return state;
      const afterFinal = FINAL.has(state.status);
      m.withdrawn.push({ at, reason: data.reason ?? null, afterFinal });
      if (!afterFinal) {
        // 终态前撤回：材料退出当前审查快照
        m.activeFp = null;
      }
      // 终态（已核准/已登记）后撤回只留痕，决定与登记不倒退
      return state;
    }

    case "REVIEW_RECORDED": {
      state.reviews.push({
        at,
        seq: state.reviews.length + 1,
        decision: data.decision,
        today: data.today,
        results: data.results,
        materialFps: data.materialFps,
        reused: data.reused ?? [],
        snippets: data.snippets ?? {},
      });
      for (const [key, info] of Object.entries(data.cacheUpdates ?? {})) {
        if (!state.validationCache[key]) state.validationCache[key] = info;
      }
      // 人工接管后与最终决定后，预审不再驱动状态
      if (state.status !== STATUS.MANUAL_REVIEW && !FINAL.has(state.status)) {
        state.status =
          data.decision === "APPROVED"
            ? STATUS.READY
            : data.decision === "MANUAL"
              ? STATUS.MANUAL_REVIEW
              : STATUS.PENDING_CORRECTION;
      }
      return state;
    }

    case "MANUAL_TAKEOVER":
      state.manual.takenOverBy = data.officer;
      state.manual.takenOverAt = at;
      state.manual.reason = data.reason ?? null;
      state.manual.history.push({ at, action: "takeover", officer: data.officer, reason: data.reason ?? null });
      state.status = STATUS.MANUAL_REVIEW;
      return state;

    case "MANUAL_DECISION":
      state.manual.history.push({
        at,
        action: "decision",
        officer: data.officer,
        outcome: data.outcome,
        reason: data.reason ?? null,
      });
      state.finalDecision = { outcome: data.outcome, by: data.officer, at, reason: data.reason ?? null };
      state.status = data.outcome === "approved" ? STATUS.FINAL_APPROVED : STATUS.FINAL_REJECTED;
      return state;

    case "REGISTRATION_COMPLETED":
      state.registration = { registrationNo: data.registrationNo, by: data.officer, at };
      state.status = STATUS.REGISTERED;
      return state;

    case "CASE_NOTE":
      state.manual.history.push({ at, action: "note", officer: data.officer, text: data.text });
      return state;

    default:
      return state;
  }
}

export function fold(events, applicationId) {
  const state = initialState(applicationId);
  for (const evt of events) reduce(state, evt);
  return state;
}

export { activeMaterials, TERMINAL, FINAL };
