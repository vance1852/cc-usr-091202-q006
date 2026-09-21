import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/rules.js";

const base = {
  registryZone: "Asia/Shanghai",
};

function bc(over = {}) {
  return {
    certificateNo: "X1",
    hospitalZone: "Asia/Urumqi",
    registryZone: "Asia/Shanghai",
    birthTime: "2026-09-30T23:30:00+06:00",
    child: { name: "张小娃" },
    ...over,
  };
}
function hh(over = {}) {
  return {
    bookNo: "H1",
    registryZone: "Asia/Shanghai",
    child: { name: "张小娃" },
    guardians: [{ name: "张建国", relation: "father" }],
    ...over,
  };
}
function g(over = {}) {
  return {
    guardianIndex: 0,
    name: "张晋",
    formerNames: ["张建国"],
    formerNameRegistered: true,
    idType: "resident_id",
    idNumber: "310101199001011234",
    idExpiryDate: "2030-01-01",
    relation: "father",
    ...over,
  };
}

const NOW = new Date("2026-10-05T00:00:00Z");

test("跨时区归一：证据中医院日 09-30、登记地日 10-01，规则通过", () => {
  const r = evaluate(
    { birthCertificate: bc(), household: hh(), guardians: [g()] },
    { now: NOW },
  );
  const norm = r.results.find((x) => x.code === "birth_date_normalized");
  assert.equal(norm.status, "pass");
  assert.equal(norm.evidence.hospitalBirthDate, "2026-09-30");
  assert.equal(norm.evidence.registryBirthDate, "2026-10-01");
  assert.equal(r.decision, "APPROVED");
});

test("曾用名缺佐证 -> 补正；补登佐证后 -> 通过", () => {
  const before = evaluate(
    { birthCertificate: bc(), household: hh(), guardians: [g({ formerNameRegistered: false })] },
    { now: NOW },
  );
  assert.equal(before.decision, "CORRECTION");
  const chain = before.results.find((x) => x.code === "guardian_name_chain");
  assert.equal(chain.status, "needs_correction");

  const after = evaluate(
    { birthCertificate: bc(), household: hh(), guardians: [g({ formerNameRegistered: true })] },
    { now: NOW },
  );
  assert.equal(after.decision, "APPROVED");
});

test("现用名与曾用名都对不上户口簿 -> 失败", () => {
  const r = evaluate(
    {
      birthCertificate: bc(),
      household: hh(),
      guardians: [g({ name: "钱芳", formerNames: [] })],
    },
    { now: NOW },
  );
  assert.equal(r.results.find((x) => x.code === "guardian_name_chain").status, "fail");
  assert.equal(r.results.find((x) => x.code === "guardian_relation").status, "fail");
  assert.equal(r.decision, "CORRECTION");
});

test("证件已过期 -> 失败；30 日内到期 -> 补正", () => {
  const expired = evaluate(
    { birthCertificate: bc(), household: hh(), guardians: [g({ idExpiryDate: "2026-01-01" })] },
    { now: NOW },
  );
  assert.equal(expired.results.find((x) => x.code === "guardian_id_expiry").status, "fail");

  const soon = evaluate(
    { birthCertificate: bc(), household: hh(), guardians: [g({ idExpiryDate: "2026-10-20" })] },
    { now: NOW },
  );
  assert.equal(soon.results.find((x) => x.code === "guardian_id_expiry").status, "needs_correction");
});

test("出生超 30 日时限 -> 转人工，且优先于补正项", () => {
  const r = evaluate(
    {
      birthCertificate: bc({ birthTime: "2026-07-01T09:00:00+08:00", hospitalZone: "Asia/Shanghai" }),
      household: hh(),
      guardians: [g({ idExpiryDate: "2026-01-01" })],
    },
    { now: NOW },
  );
  assert.equal(r.results.find((x) => x.code === "birth_registration_deadline").status, "manual");
  assert.equal(r.decision, "MANUAL");
});

test("登记地不一致 -> 失败", () => {
  const r = evaluate(
    { birthCertificate: bc(), household: hh({ registryZone: "Asia/Urumqi" }), guardians: [g()] },
    { now: NOW },
  );
  assert.equal(r.results.find((x) => x.code === "registry_zone").status, "fail");
  assert.equal(r.decision, "CORRECTION");
});

test("缺出生证明直接补正", () => {
  const r = evaluate({ guardians: [] }, { now: NOW });
  assert.equal(r.decision, "CORRECTION");
});
