import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PreReviewService, ServiceError } from "../src/service.js";

let dir;

const bcPayload = {
  certificateNo: "X20260930001",
  hospitalName: "乌鲁木齐市某妇幼保健院",
  hospitalZone: "Asia/Urumqi",
  birthTime: "2026-09-30T23:30:00+06:00",
  child: { name: "张小娃", sex: "M" },
};
const hhPayload = {
  bookNo: "H310101202609",
  registryZone: "Asia/Shanghai",
  child: { name: "张小娃" },
  guardians: [{ name: "张建国", relation: "father" }],
};
const guardianV1 = {
  name: "张晋",
  formerNames: ["张建国"],
  formerNameRegistered: false,
  idType: "resident_id",
  idNumber: "310101199001011234",
  idExpiryDate: "2030-01-01",
  relation: "father",
};

const NOW = new Date("2026-10-05T00:00:00Z");

async function newService(d = dir) {
  return new PreReviewService({ dataDir: d, now: () => NOW }).init();
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "prereview-"));
});

async function seedCase(svc, id = "B-401", guardian = guardianV1) {
  await svc.openApplication({ applicationId: id, registryZone: "Asia/Shanghai" });
  await svc.submitMaterial(id, "bc", "birth_certificate", bcPayload);
  await svc.submitMaterial(id, "hh", "household_relation", hhPayload);
  await svc.submitMaterial(id, "g1", "guardian_identity", guardian);
}

test("投诉原型：跨时区归一 + 曾用名首次补正，补充佐证新版本后通过", async () => {
  const svc = await newService();
  await seedCase(svc);

  const r1 = await svc.runReview("B-401");
  assert.equal(r1.decision, "CORRECTION");
  const norm = r1.results.find((x) => x.code === "birth_date_normalized");
  assert.equal(norm.evidence.registryBirthDate, "2026-10-01"); // 不是医院当地 09-30
  assert.equal(svc.getState("B-401").status, "PENDING_CORRECTION");

  // 补充曾用名佐证 -> 同材料的新版本
  await svc.submitMaterial("B-401", "g1", "guardian_identity", {
    ...guardianV1,
    formerNameRegistered: true,
  });
  const m = svc.getState("B-401").materials.g1;
  assert.equal(m.versions.length, 2);
  assert.equal(m.versions[1].version, 2);

  const r2 = await svc.runReview("B-401");
  assert.equal(r2.decision, "APPROVED");
  assert.equal(svc.getState("B-401").status, "READY");
});

test("同一材料重复上传：复用原版本与原校验，不产生新版本", async () => {
  const svc = await newService();
  await seedCase(svc);
  await svc.runReview("B-401");

  // 内容完全相同（键顺序不同也视为相同）
  const re = await svc.submitMaterial("B-401", "bc", "birth_certificate", {
    ...bcPayload,
  });
  assert.equal(re.reused, true);
  assert.equal(re.version, 1);
  assert.equal(svc.getState("B-401").materials.bc.versions.length, 1);

  const r = await svc.runReview("B-401");
  const reusedRule = r.results.find((x) => x.code === "birth_date_normalized");
  assert.ok(reusedRule.reusedValidatedAt, "应标注复用自首次校验");
});

test("撤回材料在终态前生效，但版本与历史审查保留", async () => {
  const svc = await newService();
  await seedCase(svc);
  await svc.runReview("B-401");
  await svc.withdrawMaterial("B-401", "g1", "家属要求更换证件材料");
  const s = svc.getState("B-401");
  assert.equal(s.materials.g1.activeFp, null);
  assert.equal(s.materials.g1.versions.length, 1); // 历史版本保留
  assert.equal(s.reviews.length, 1); // 已完成审查保留
});

test("登记完成后撤回材料不得令登记倒退，且拒绝材料变动", async () => {
  const svc = await newService();
  await seedCase(svc, "B-401", { ...guardianV1, formerNameRegistered: true });
  await svc.runReview("B-401");
  await svc.completeRegistration("B-401", { officer: "窗口刘警官", registrationNo: "R-0001" });
  assert.equal(svc.getState("B-401").status, "REGISTERED");

  const w = await svc.withdrawMaterial("B-401", "g1", "事后撤证测试");
  assert.equal(w.effective, false);
  assert.equal(svc.getState("B-401").status, "REGISTERED");

  await assert.rejects(
    () => svc.submitMaterial("B-401", "g1", "guardian_identity", guardianV1),
    (e) => e instanceof ServiceError && e.code === "REGISTERED_LOCKED",
  );
});

test("禁止用重新提交申请掩盖已有审查过程", async () => {
  const svc = await newService();
  await seedCase(svc);
  await svc.runReview("B-401");
  await assert.rejects(
    () => svc.openApplication({ applicationId: "B-401", registryZone: "Asia/Shanghai" }),
    (e) => e.code === "APPLICATION_EXISTS",
  );
});

test("进程重启（新建服务指向同一目录）后从原状态继续，审查轨迹不丢", async () => {
  const svc = await newService();
  await seedCase(svc);
  await svc.runReview("B-401");

  // 另一起超期案件：应转人工并持久化人工状态
  await svc.openApplication({ applicationId: "B-499", registryZone: "Asia/Shanghai" });
  await svc.submitMaterial("B-499", "bc", "birth_certificate", {
    ...bcPayload,
    hospitalZone: "Asia/Shanghai",
    birthTime: "2026-07-01T09:00:00+08:00",
  });
  await svc.submitMaterial("B-499", "hh", "household_relation", hhPayload);
  await svc.submitMaterial("B-499", "g1", "guardian_identity", {
    ...guardianV1,
    formerNameRegistered: true,
  });
  await svc.runReview("B-499");
  assert.equal(svc.getState("B-499").status, "MANUAL_REVIEW");
  await svc.takeManual("B-499", { officer: "王警官", reason: "超期核处" });
  await svc.addNote("B-499", { officer: "王警官", text: "已电话联系医院核实" });

  // 模拟进程重启
  const svc2 = await newService();
  const s = svc2.getState("B-499");
  assert.equal(s.status, "MANUAL_REVIEW");
  assert.equal(s.manual.takenOverBy, "王警官");
  assert.equal(s.manual.history.length, 2);
  assert.equal(s.reviews.length, 1);
  assert.equal(s.reviews[0].decision, "MANUAL");
  // 接管后不允许预审再下结论
  await assert.rejects(() => svc2.runReview("B-499"), (e) => e.code === "MANUAL_OWNERSHIP");
  // 人工最终决定同样持久
  await svc2.manualDecide("B-499", { officer: "王警官", outcome: "approved", reason: "情况属实" });
  const svc3 = await newService();
  assert.equal(svc3.getState("B-499").status, "FINAL_APPROVED");
});

test("事件日志只含掩码片段与指纹，不含证件号/全名等未成年人敏感原文", async () => {
  const svc = await newService();
  await seedCase(svc);
  await svc.runReview("B-401");
  const raw = await readFile(path.join(dir, "eventlog", "events.log"), "utf8");
  assert.ok(!raw.includes("310101199001011234"), "日志不得出现完整证件号");
  assert.ok(!raw.includes("张小娃"), "日志不得出现未成年人全名");
  assert.ok(!raw.includes("张建国"), "日志不得出现监护人未掩码姓名");
  assert.ok(raw.includes("31**"), "应出现掩码证件号");
  assert.ok(raw.includes("张*"), "应出现掩码姓名");
});

test("内容校验缓存按全部输入材料指纹签名：户口簿更新后不复用旧结论", async () => {
  const svc = await newService();
  await seedCase(svc, "B-401", { ...guardianV1, formerNameRegistered: true });
  const r1 = await svc.runReview("B-401");
  assert.equal(r1.decision, "APPROVED");

  // 户口簿换成不含该监护人的版本（同材料新版本）
  await svc.submitMaterial("B-401", "hh", "household_relation", {
    ...hhPayload,
    guardians: [{ name: "刘某", relation: "mother" }],
  });
  const r2 = await svc.runReview("B-401");
  const rel = r2.results.find((x) => x.code === "guardian_relation");
  assert.equal(rel.status, "fail");
  assert.equal(rel.reusedValidatedAt, undefined, "输入已变，不得复用旧关系结论");
  assert.equal(r2.decision, "CORRECTION");
});

test("预审通过（READY）后可直接完成登记", async () => {
  const svc = await newService();
  await svc.openApplication({ applicationId: "B-500", registryZone: "Asia/Shanghai" });
  await svc.submitMaterial("B-500", "bc", "birth_certificate", bcPayload);
  await svc.submitMaterial("B-500", "hh", "household_relation", hhPayload);
  await svc.submitMaterial("B-500", "g1", "guardian_identity", {
    ...guardianV1,
    formerNameRegistered: true,
  });
  await svc.runReview("B-500");
  assert.equal(svc.getState("B-500").status, "READY");
  await svc.completeRegistration("B-500", { officer: "刘警官", registrationNo: "R-500" });
  assert.equal(svc.getState("B-500").status, "REGISTERED");
  assert.equal(svc.getState("B-500").registration.registrationNo, "R-500");
});
