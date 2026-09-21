// 未成年人资料最小化：日志只允许出现判定所必需的片段，
// 证件号/全名等敏感字段一律掩码，原始载荷不进日志。

const ID_RE = /^(\w+)([0-9Xx]{6,})$/;

export function maskIdNumber(id) {
  if (typeof id !== "string" || id.length < 6) return "***";
  const head = id.slice(0, 2);
  const tail = id.slice(-2);
  return `${head}${"*".repeat(Math.max(4, id.length - 4))}${tail}`;
}

export function maskName(name) {
  if (typeof name !== "string" || name.length === 0) return "***";
  if (name.length === 1) return "*";
  return name[0] + "*".repeat(name.length - 1);
}

// 出生证明片段：仅保留判定所需字段
export function birthCertificateSnippet(bc) {
  if (!bc) return null;
  return {
    certificateNo: maskIdNumber(bc.certificateNo ?? ""),
    registryBirthDate: bc.registryBirthDate ?? null,
    hospitalBirthDate: bc.hospitalBirthDate ?? null,
    dateShifted: Boolean(bc.dateShifted),
    childName: maskName(bc.child?.name ?? bc.childName),
  };
}

// 监护人片段：姓名掩码、关系保留、证件号掩码、仅暴露有效期状态
export function guardianSnippet(g, expiryStatus) {
  if (!g) return null;
  return {
    name: maskName(g.name),
    relation: g.relation ?? null,
    idType: g.idType ?? null,
    idNumber: maskIdNumber(g.idNumber ?? ""),
    formerNames: Array.isArray(g.formerNames) ? g.formerNames.map(maskName) : [],
    expiryStatus: expiryStatus ?? null,
  };
}

export function householdSnippet(h, matchResult) {
  if (!h) return null;
  return {
    bookNo: maskIdNumber(h.bookNo ?? ""),
    registryZone: h.registryZone ?? null,
    childName: maskName(h.child?.name),
    guardians: Array.isArray(h.guardians)
      ? h.guardians.map((g) => ({ name: maskName(g.name), relation: g.relation ?? null }))
      : [],
    relationMatch: matchResult ?? null,
  };
}
