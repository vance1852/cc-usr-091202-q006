// 预审规则引擎：登记地、出生日期、监护关系、证件有效期四类检查。
// 每条规则独立产出 { code, status, detail, evidence }，
// status: pass | fail | needs_correction | manual
// 汇总：任一 manual -> MANUAL；任一 fail/needs_correction 且无 manual -> CORRECTION；全 pass -> APPROVED。

import { localDateInZone, calendarDaysBetween, toDateInput } from "./time.js";

export const RULE = {
  REGISTRY_ZONE: "registry_zone",
  BIRTH_DATE_NORMALIZED: "birth_date_normalized",
  BIRTH_DEADLINE: "birth_registration_deadline",
  GUARDIAN_RELATION: "guardian_relation",
  GUARDIAN_NAME_CHAIN: "guardian_name_chain",
  GUARDIAN_ID_EXPIRY: "guardian_id_expiry",
};

// 出生登记申报时限（天）。现场规则：出生后 30 日内；超期不直接拒绝，但需人工核处。
const DEADLINE_DAYS = 30;
// 证件到期宽限：提交日起 N 天内到期 -> 补正提示
const EXPIRY_SOON_DAYS = 30;

export function normalizeBirth(birthCert) {
  // birthTime 是带 UTC 偏移的医院当地绝对时刻；分别在医院地/登记地取日历日期
  const hospitalBirthDate = localDateInZone(birthCert.birthTime, birthCert.hospitalZone);
  const registryBirthDate = localDateInZone(birthCert.birthTime, birthCert.registryZone);
  return {
    ...birthCert,
    hospitalBirthDate,
    registryBirthDate,
    dateShifted: hospitalBirthDate !== registryBirthDate,
  };
}

function checkRegistryZone({ birthCert, household }) {
  const evidence = {
    registryZone: birthCert.registryZone,
    householdZone: household?.registryZone ?? null,
  };
  if (!household?.registryZone) {
    return {
      code: RULE.REGISTRY_ZONE,
      status: "fail",
      detail: "缺少登记地户口簿，无法核对登记地",
      evidence,
    };
  }
  if (birthCert.registryZone !== household.registryZone) {
    return {
      code: RULE.REGISTRY_ZONE,
      status: "fail",
      detail: `出生证明登记地 ${birthCert.registryZone} 与户口簿登记地 ${household.registryZone} 不一致`,
      evidence,
    };
  }
  return { code: RULE.REGISTRY_ZONE, status: "pass", detail: "登记地一致", evidence };
}

function checkBirthDate(birthCert, todayInput) {
  const evidence = {
    birthTime: birthCert.birthTime,
    hospitalZone: birthCert.hospitalZone,
    registryZone: birthCert.registryZone,
    hospitalBirthDate: birthCert.hospitalBirthDate,
    registryBirthDate: birthCert.registryBirthDate,
  };
  // 跨时区归一结果以登记地日期为准；跨日仅作信息留痕，本身不是失败
  const result = {
    code: RULE.BIRTH_DATE_NORMALIZED,
    status: "pass",
    detail: birthCert.dateShifted
      ? `跨时区：医院当地 ${birthCert.hospitalBirthDate} 归一为登记地日期 ${birthCert.registryBirthDate}`
      : `出生日期 ${birthCert.registryBirthDate}（医院与登记地同日）`,
    evidence,
  };
  return result;
}

function checkDeadline(birthCert, todayInput) {
  const ageDays = calendarDaysBetween(birthCert.registryBirthDate, todayInput);
  const evidence = {
    registryBirthDate: birthCert.registryBirthDate,
    today: todayInput,
    ageDays,
    deadlineDays: DEADLINE_DAYS,
  };
  if (ageDays < 0) {
    return {
      code: RULE.BIRTH_DEADLINE,
      status: "manual",
      detail: "出生日期晚于当前日期，时间信息存疑，转人工核处",
      evidence,
    };
  }
  if (ageDays > DEADLINE_DAYS) {
    return {
      code: RULE.BIRTH_DEADLINE,
      status: "manual",
      detail: `出生已 ${ageDays} 天，超过 ${DEADLINE_DAYS} 日申报时限，转人工核处`,
      evidence,
    };
  }
  return {
    code: RULE.BIRTH_DEADLINE,
    status: "pass",
    detail: `出生 ${ageDays} 天，在 ${DEADLINE_DAYS} 日申报时限内`,
    evidence,
  };
}

function checkGuardian(guardian, declaredChildName, householdEntry, todayInput) {
  const checks = [];

  // 1) 监护关系：户口簿中须能找到该监护人，且关系属于法定监护范围
  const LEGAL_RELATIONS = new Set(["father", "mother", "grandparent", "legal_guardian"]);
  if (!householdEntry) {
    checks.push({
      code: RULE.GUARDIAN_RELATION,
      status: "fail",
      detail: `监护人未出现在户口簿同户人员中，监护关系无法确认`,
      evidence: { relation: guardian.relation ?? null, inHousehold: false },
    });
  } else if (!LEGAL_RELATIONS.has(householdEntry.relation)) {
    checks.push({
      code: RULE.GUARDIAN_RELATION,
      status: "manual",
      detail: `户口簿关系 ${householdEntry.relation} 不属于直接登记范围，转人工认定监护资格`,
      evidence: { relation: householdEntry.relation, inHousehold: true },
    });
  } else if (guardian.relation && guardian.relation !== householdEntry.relation) {
    checks.push({
      code: RULE.GUARDIAN_RELATION,
      status: "fail",
      detail: `申报关系 ${guardian.relation} 与户口簿登记关系 ${householdEntry.relation} 不一致`,
      evidence: {
        declaredRelation: guardian.relation,
        householdRelation: householdEntry.relation,
        inHousehold: true,
      },
    });
  } else {
    checks.push({
      code: RULE.GUARDIAN_RELATION,
      status: "pass",
      detail: `监护关系 ${householdEntry.relation} 与户口簿一致`,
      evidence: { relation: householdEntry.relation, inHousehold: true },
    });
  }

  // 2) 姓名链：证件现用名/曾用名 必须能连通户口簿姓名
  const formerCount = (guardian.formerNames ?? []).length;
  if (!householdEntry) {
    checks.push({
      code: RULE.GUARDIAN_NAME_CHAIN,
      status: "fail",
      detail: "监护人不在同户人员中，无法核对证件姓名与户籍姓名",
      evidence: { matchedBy: null, formerNameCount: formerCount },
    });
  } else {
    const current = (guardian.name ?? "").trim();
    const former = new Set((guardian.formerNames ?? []).map((n) => n.trim()));
    const bookName = (householdEntry.name ?? "").trim();
    if (current === bookName) {
      checks.push({
        code: RULE.GUARDIAN_NAME_CHAIN,
        status: "pass",
        detail: "证件现用名与户口簿一致",
        evidence: { matchedBy: "current_name", formerNameCount: former.size },
      });
    } else if (former.has(bookName) && guardian.formerNameRegistered === true) {
      checks.push({
        code: RULE.GUARDIAN_NAME_CHAIN,
        status: "pass",
        detail: "户口簿姓名为证件登载曾用名，且曾用名佐证已登载，姓名链核实通过",
        evidence: { matchedBy: "former_name_registered", formerNameCount: former.size },
      });
    } else if (former.has(bookName)) {
      // 曾用名命中但缺佐证：不直接拒绝，要求补充曾用名佐证（户籍曾用名登记/更名记录）-> 补正
      checks.push({
        code: RULE.GUARDIAN_NAME_CHAIN,
        status: "needs_correction",
        detail: "证件为现用名、户口簿为曾用名，需补正曾用名佐证材料（户籍登载或更名记录）",
        evidence: { matchedBy: "former_name", formerNameCount: former.size, formerNameRegistered: false },
      });
    } else {
      checks.push({
        code: RULE.GUARDIAN_NAME_CHAIN,
        status: "fail",
        detail: "证件现用名与曾用名均无法对应户口簿姓名",
        evidence: { matchedBy: null, formerNameCount: former.size },
      });
    }
  }

  // 3) 证件有效期
  if (!guardian.idExpiryDate) {
    checks.push({
      code: RULE.GUARDIAN_ID_EXPIRY,
      status: "manual",
      detail: "证件未标注有效期，转人工核验证件类型",
      evidence: { idType: guardian.idType ?? null },
    });
  } else {
    const daysLeft = calendarDaysBetween(todayInput, guardian.idExpiryDate);
    const evidence = {
      idType: guardian.idType ?? null,
      expiryDate: guardian.idExpiryDate,
      daysLeft,
    };
    if (daysLeft < 0) {
      checks.push({
        code: RULE.GUARDIAN_ID_EXPIRY,
        status: "fail",
        detail: `证件已于 ${guardian.idExpiryDate} 过期`,
        evidence,
      });
    } else if (daysLeft <= EXPIRY_SOON_DAYS) {
      checks.push({
        code: RULE.GUARDIAN_ID_EXPIRY,
        status: "needs_correction",
        detail: `证件将于 ${guardian.idExpiryDate} 到期（剩 ${daysLeft} 天），请换领后补传`,
        evidence,
      });
    } else {
      checks.push({
        code: RULE.GUARDIAN_ID_EXPIRY,
        status: "pass",
        detail: `证件有效期至 ${guardian.idExpiryDate}（剩 ${daysLeft} 天）`,
        evidence,
      });
    }
  }

  return checks;
}

const STATUS_RANK = { pass: 0, needs_correction: 1, fail: 2, manual: 3 };

export function aggregate(results) {
  let worst = "pass";
  for (const r of results) {
    if (STATUS_RANK[r.status] > STATUS_RANK[worst]) worst = r.status;
  }
  if (worst === "manual") return "MANUAL";
  if (worst === "fail" || worst === "needs_correction") return "CORRECTION";
  return "APPROVED";
}

// 对一份申请的当前材料快照执行全部规则。
// snapshot: { birthCertificate, guardians:[{...guardianFields}], household:{...} }
export function evaluate(snapshot, { now = new Date() } = {}) {
  const todayInput = toDateInput(now);
  const results = [];

  if (!snapshot.birthCertificate) {
    return {
      decision: "CORRECTION",
      today: todayInput,
      results: [
        {
          code: RULE.BIRTH_DATE_NORMALIZED,
          status: "fail",
          detail: "缺少出生医学证明",
          evidence: {},
        },
      ],
    };
  }

  const bc = normalizeBirth(snapshot.birthCertificate);
  const household = snapshot.household ?? null;

  results.push(checkRegistryZone({ birthCert: bc, household }));
  results.push(checkBirthDate(bc, todayInput));
  results.push(checkDeadline(bc, todayInput));

  for (const guardian of snapshot.guardians ?? []) {
    const householdEntry = household?.guardians?.find(
      (h) =>
        h.name === guardian.name ||
        (guardian.formerNames ?? []).includes(h.name),
    );
    const guardianResults = checkGuardian(guardian, bc.child?.name, householdEntry, todayInput);
    for (const r of guardianResults) {
      results.push({ ...r, guardianIndex: guardian.guardianIndex });
    }
  }

  if (!snapshot.guardians || snapshot.guardians.length === 0) {
    results.push({
      code: RULE.GUARDIAN_RELATION,
      status: "fail",
      detail: "未申报任何监护人",
      evidence: {},
    });
  }

  return { decision: aggregate(results), today: todayInput, results };
}
