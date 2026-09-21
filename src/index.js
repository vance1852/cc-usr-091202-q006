import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const context = JSON.parse(await readFile(path.join(root, "fixtures", "context.json"), "utf8"));

console.log(`${context.domain} —— 预审服务已就绪`);
console.log("");
console.log("窗口操作入口（数据默认写入 ./data，事件日志 fsync 落盘，可随时中断重放）：");
console.log("  node src/cli.js open <申请号> --zone Asia/Shanghai");
console.log("  node src/cli.js upload <申请号> <材料ID> birth_certificate|guardian_identity|household_relation --file <材料.json>");
console.log("  node src/cli.js review <申请号>            # 逐条规则：通过/补正/转人工");
console.log("  node src/cli.js trace <申请号>             # 材料版本、复用缓存、全部审查与人工轨迹");
console.log("  node src/cli.js replay <申请号>            # 仅从事件日志重建状态");
console.log("  node src/cli.js take|note|decide|register  # 人工接管与最终决定");
console.log("");
console.log("规则：登记地核对 / 跨时区出生日期归一 / 30 日申报时限 / 监护关系 / 曾用名链 / 证件有效期");
console.log("测试：npm test");
