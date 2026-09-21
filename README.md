# 出生登记材料预审服务（Node.js）

面向户政窗口的出生登记**材料预审**服务。针对投诉中的痛点设计：

- 医院出生证明是**医院当地时间**，本服务把带偏移的出生绝对时刻按**登记地时区**重新取日历日期，再核对申报时限；
- 监护人证件有**曾用名**时，不再只回一个"不一致"，而是逐条给出通过 / 补正 / 转人工及原因；
- 窗口人员可对任一申请**重放全过程**，逐条看到登记地、出生日期、监护关系、证件有效期如何影响结论；
- 未成年人资料在日志中**只出现必要片段**（姓名/证件号掩码，原始载荷不进事件日志）。

仅使用 Node.js 内置能力（`node:fs`、`Intl` 全 ICU、`node:test`），无第三方依赖。

## 快速开始

```bash
npm test          # 20 项测试：时区、规则、复用/版本、撤回、终态锁定、崩溃恢复、日志脱敏
npm start         # 查看入口说明
```

CLI 演示（数据写入 `--data` 指定目录，默认 `./data`）：

```bash
node src/cli.js open B-401 --zone Asia/Shanghai --data ./data
node src/cli.js upload B-401 bc birth_certificate --file ./payloads/bc.json --data ./data
node src/cli.js upload B-401 hh household_relation  --file ./payloads/hh.json --data ./data
node src/cli.js upload B-401 g1 guardian_identity   --file ./payloads/g1-v1.json --data ./data
node src/cli.js review B-401 --now 2026-10-05 --data ./data   # 逐条规则结论
node src/cli.js upload B-401 g1 guardian_identity --file ./payloads/g1-v2.json --data ./data  # 补充 -> 新版本
node src/cli.js review B-401 --now 2026-10-05 --data ./data
node src/cli.js trace  B-401 --data ./data                    # 全轨迹
node src/cli.js replay B-401 --data ./data                    # 仅从日志重建
```

`--now YYYY-MM-DD` 用于固定"申报当天"以复现历史审查（时限、证件有效期按当天计算）。

## 规则与结论（src/rules.js）

每个案件对当前有效材料快照执行六类规则，每条独立给出 `pass / needs_correction / fail / manual`：

| 规则 | 通过 | 补正 | 失败 | 转人工 |
|---|---|---|---|---|
| 登记地核对 | 出生证登记地与户口簿一致 | — | 不一致/缺户口簿 | — |
| 出生日期跨时区归一 | 医院时刻归一到登记地日历日期（跨日仅留痕） | — | 时间无法解析 | — |
| 出生登记申报时限 | 归一后出生 ≤ 30 日 | — | — | 超 30 日 / 日期在未来 |
| 监护关系 | 同户且关系属法定监护范围 | — | 不在同户 / 申报关系与户口簿不符 | 关系类型需认定 |
| 证件姓名/曾用名链 | 现用名一致；或户口簿为登载曾用名**且佐证已登载** | 现用名→曾用名命中但缺佐证 | 现用名与曾用名都对不上 | — |
| 证件有效期 | 30 天以上 | 30 天内到期 | 已过期 | 未标有效期 |

汇总优先级：**任一 manual → MANUAL；否则任一 fail/补正 → CORRECTION；全部通过 → APPROVED**。

跨时区例：`2026-09-30T23:30:00+06:00`（乌鲁木齐）在登记地 `Asia/Shanghai` 是 `2026-10-01`，系统以 **10-01** 为出生日期。

## 材料生命周期

- **内容指纹**：对材料 JSON 规范序列化（键排序）后取 SHA-256。
- **重复上传复用原校验**：同一 `materialId` 提交相同内容（即使键顺序不同）不产生新版本，内容内禀规则（登记地、归一日期、关系、姓名链）标注"复用首次校验"。
- **新补充材料形成版本**：同一 `materialId` 提交不同内容追加 v2、v3……，旧版本与历史审查全部保留；撤回后重新提交相同内容则重新激活原版本与原校验。
- **时限/有效期不复用**：依赖申报当天，每次重审重算。
- **跨材料规则的复用键覆盖全部输入指纹**：例如户口簿更新后，监护关系/姓名链不会错误复用旧结论。
- **撤回**：终态前撤回使材料退出当前快照（历史保留）；最终决定或登记完成后撤回**仅留痕，决定与登记不倒退**，登记完成后也不再接收材料变动。

## 持久化与崩溃恢复（src/store.js, src/state.js, src/blobs.js）

- 所有状态改变都是**仅追加事件**（JSONL），每次写入 `fsync` 后才更新内存。
- 状态（收件/补正/就绪/人工接管/最终核准/拒绝/已登记）完全由事件**归约（fold）**得到；`new PreReviewService({dataDir})` 重新指向同一目录即完成续跑。
- 进程崩溃若最后一行半写，重启时自动截断到最后一个完整事件。
- **不允许重新提交申请**覆盖既有案件：同一申请号再次 `open` 被拒绝，保证审查过程不会被"重新交一遍"掩盖。
- 人工接管状态、材料版本关系、最终决定、登记结果均持久化；人工接管后预审不再下结论，最终决定后不可重审。

事件日志只保存**指纹 + 掩码片段**（如证件号 `31**************34`、姓名 `张*`）；材料完整载荷以指纹为名存于 `materials/`，重放时按指纹取回。

## 目录

```
src/
  time.js     跨时区日期归一（Intl）、日历日差
  hash.js     规范 JSON / SHA-256 内容指纹
  redact.js   未成年人资料最小化（掩码片段）
  rules.js    六类规则引擎与结论汇总
  store.js    仅追加事件日志（fsync、半写截断恢复）
  blobs.js    材料内容寻址存储
  state.js    事件 -> 状态机归约
  service.js  应用服务（立案/上传/撤回/预审/人工/登记/重放）
  cli.js      窗口命令行
fixtures/
  field-dictionary.json   字段字典
  hospital-sample.json    医院交换报文样例
  boundary-cases.json     边界案例（脱敏）
  context.json            现场记录索引
test/           node:test 测试（20 项）
```
