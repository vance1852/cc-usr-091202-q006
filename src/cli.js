#!/usr/bin/env node
// 户政窗口预审命令行：可对任一申请重放全过程，逐条查看规则如何导向通过/补正/转人工。
// 所有状态来自仅追加事件日志，进程重启后命令仍指向同一数据目录即从原状态继续。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PreReviewService, ServiceError } from "./service.js";

const RULE_LABEL = {
  registry_zone: "登记地核对",
  birth_date_normalized: "出生日期跨时区归一",
  birth_registration_deadline: "出生登记申报时限",
  guardian_relation: "监护关系核对",
  guardian_name_chain: "证件姓名/曾用名链",
  guardian_id_expiry: "监护人证件有效期",
};

const STATUS_MARK = {
  pass: "✓ 通过",
  fail: "✗ 不符",
  needs_correction: "△ 补正",
  manual: "⚑ 转人工",
};

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dataDir = path.resolve(args.flags.data ?? path.join(process.cwd(), "data"));
  const now = args.flags.now ? new Date(`${args.flags.now}T12:00:00Z`) : undefined;
  const svc = await new PreReviewService({ dataDir, now: now ? () => now : undefined }).init();

  const out = (x) => console.log(x);

  switch (cmd) {
    case "open": {
      const [id] = args._;
      await svc.openApplication({ applicationId: id, registryZone: args.flags.zone });
      out(`已立案 ${id}，登记地时区 ${args.flags.zone}`);
      break;
    }

    case "upload": {
      const [id, materialId, kind] = args._;
      const payload = JSON.parse(await readFile(path.resolve(args.flags.file), "utf8"));
      const r = await svc.submitMaterial(id, materialId, kind, payload);
      out(
        r.reused
          ? `材料 ${r.materialId} 与已存版本内容一致：复用第 ${r.version} 版及原校验记录（指纹 ${r.fingerprint}）`
          : `材料 ${r.materialId} 已收录为第 ${r.version} 版（指纹 ${r.fingerprint}）`,
      );
      break;
    }

    case "withdraw": {
      const [id, materialId] = args._;
      const r = await svc.withdrawMaterial(id, materialId, args.flags.reason ?? null);
      out(
        r.effective
          ? `材料 ${materialId} 已撤回，退出当前审查快照（历史版本与审查轨迹保留）`
          : `材料 ${materialId} 的撤回仅作留痕：最终决定/登记已完成，不予倒退`,
      );
      break;
    }

    case "review": {
      const [id] = args._;
      const r = await svc.runReview(id);
      out(`\n申请 ${id} 预审结论：${r.decision}（按登记地日期 ${r.today} 计算）`);
      out("─".repeat(72));
      for (const x of r.results) {
        const tag = x.guardianIndex !== undefined ? `[监护人${x.guardianIndex + 1}] ` : "";
        const reuse = x.reusedValidatedAt ? `  ←复用 ${x.reusedValidatedAt} 的原校验` : "";
        out(`${STATUS_MARK[x.status]}  ${tag}${RULE_LABEL[x.code] ?? x.code}`);
        out(`    ${x.detail}${reuse}`);
      }
      if (r.reused.length > 0) {
        out("─".repeat(72));
        out("重复材料复用：" + r.reused.map((m) => `${m.materialId}(v${m.version})`).join("、"));
      }
      out("─".repeat(72));
      out("日志留痕片段（已最小化）：" + JSON.stringify(r.snippets, null, 2));
      out(`案件状态：${r.state}`);
      break;
    }

    case "trace": {
      const [id] = args._;
      const t = svc.getTrace(id);
      out(`\n申请 ${t.applicationId}　状态：${t.status}　登记地：${t.registryZone}`);
      out("\n材料关系：");
      for (const [mid, m] of Object.entries(t.materials)) {
        out(
          `  ${mid} (${m.kind}) 当前 v${m.activeVersion ?? "—"} 共 ${m.versionCount} 版` +
            (m.withdrawn ? " [已撤回]" : ""),
        );
        for (const v of m.versions) out(`      v${v.version} 指纹 ${v.fingerprint} ${v.at}`);
        for (const w of m.withdrawalTrail) {
          out(`      撤回于 ${w.at}${w.afterFinal ? "（终态后，仅留痕）" : ""} 原因：${w.reason ?? "—"}`);
        }
      }
      out("\n内容校验复用缓存：");
      for (const c of t.validationCache) {
        out(`  ${RULE_LABEL[c.rule] ?? c.rule} <- ${c.inputs.map((i) => `${i.kind}:${i.fingerprint}`).join(" + ")}  首次校验 ${c.firstValidatedAt}`);
      }
      out("\n审查轨迹：");
      for (const rv of t.reviews) {
        out(`  #${rv.seq} ${rv.at} 结论 ${rv.decision}（复用 ${rv.reused.length} 项）`);
        for (const x of rv.results) {
          out(`      ${STATUS_MARK[x.status]} ${RULE_LABEL[x.code] ?? x.code}${x.guardianIndex !== undefined ? ` [监护人${x.guardianIndex + 1}]` : ""}`);
        }
      }
      if (t.manual.history.length) {
        out("\n人工接管：");
        for (const h of t.manual.history) out(`  ${h.at} ${h.action} ${h.officer ?? ""} ${h.outcome ?? h.text ?? ""} ${h.reason ?? ""}`);
      }
      if (t.finalDecision) out(`\n最终决定：${t.finalDecision.outcome} by ${t.finalDecision.by} at ${t.finalDecision.at}`);
      if (t.registration) out(`登记完成：${t.registration.registrationNo} by ${t.registration.by} at ${t.registration.at}`);
      break;
    }

    case "list": {
      for (const a of svc.listApplications()) {
        out(`${a.applicationId}  ${a.status}  材料${a.materialCount} 审查${a.reviewCount}  登记地${a.registryZone}`);
      }
      break;
    }

    case "take": {
      const [id] = args._;
      const m = await svc.takeManual(id, { officer: args.flags.officer, reason: args.flags.reason });
      out(`案件 ${id} 已由 ${m.takenOverBy} 于 ${m.takenOverAt} 人工接管`);
      break;
    }

    case "decide": {
      const [id, outcome] = args._;
      const d = await svc.manualDecide(id, { officer: args.flags.officer, outcome, reason: args.flags.reason });
      out(`人工最终决定：${d.outcome}（${d.by}）`);
      break;
    }

    case "note": {
      const [id] = args._;
      await svc.addNote(id, { officer: args.flags.officer, text: args.flags.text });
      out("办案记录已留存");
      break;
    }

    case "register": {
      const [id] = args._;
      const r = await svc.completeRegistration(id, { officer: args.flags.officer, registrationNo: args.flags.regno });
      out(`登记完成：${r.registrationNo}`);
      break;
    }

    case "replay": {
      // 显式重放：仅从事件日志重建并展示，不写任何数据
      const [id] = args._;
      const t = svc.getTrace(id);
      out(`已从事件日志重放 ${id}：状态 ${t.status}，审查 ${t.reviews.length} 轮，材料 ${Object.keys(t.materials).length} 份`);
      break;
    }

    default:
      out(
        [
          "用法：node src/cli.js <命令> [参数] [--data data目录] [--now YYYY-MM-DD]",
          "  open <id> --zone <IANA时区>            立案",
          "  upload <id> <材料ID> <类型> --file <json>  提交/补充材料（重复内容自动复用）",
          "  withdraw <id> <材料ID> [--reason]       撤回材料（终态后仅留痕）",
          "  review <id>                             执行预审，逐条列规则",
          "  replay <id>                             仅从日志重放状态",
          "  trace <id>                              材料版本/复用/审查/人工全轨迹",
          "  list                                    列出全部申请",
          "  take <id> --officer <人> [--reason]     人工接管",
          "  note <id> --officer <人> --text <内容>  人工办案记录",
          "  decide <id> approved|rejected --officer <人> [--reason]  人工最终决定",
          "  register <id> --officer <人> --regno <号>  完成登记",
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  if (err instanceof ServiceError) {
    console.error(`[${err.code}] ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
