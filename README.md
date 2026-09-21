<p align="center">
  <img src="./icon.png" alt="Douban → IMDb" width="160" />
</p>

<h1 align="center">豆瓣 → IMDb 同步 · Douban to IMDb</h1>

<p align="center">
  把豆瓣「看过 / 在看 / 想看」逐条同步到你的 IMDb：标记已看过 + 按 <code>豆瓣星 × 2 − 1</code> 打分。<br/>
  纯前端油猴脚本，复用你自己的登录态 · 零后端 · 零依赖。<br/>
  <sub>A Tampermonkey / Violentmonkey userscript that syncs your Douban movie list to your own IMDb account (mark watched + map ratings).</sub>
</p>

<p align="center">
  <a href="https://greasyfork.org/zh-CN/scripts/596763"><img src="https://img.shields.io/badge/Install%20now-orange?style=for-the-badge" alt="Install now from Greasy Fork"></a>
</p>

<p align="center">
  <a href="https://greasyfork.org/zh-CN/scripts/596763"><img src="https://img.shields.io/greasyfork/dt/596763?style=flat-square&label=Greasy%20Fork%20installs&color=yellowgreen" alt="Greasy Fork installs"></a>
  <img src="https://img.shields.io/badge/Tampermonkey-supported-green?style=flat-square" alt="Tampermonkey">
  <img src="https://img.shields.io/badge/Violentmonkey-supported-brightgreen?style=flat-square" alt="Violentmonkey">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License">
  <img src="https://img.shields.io/github/stars/Juwan-Hwang/douban2imdb?style=flat-square&logo=github" alt="GitHub stars">
</p>

> 💡 一键安装：先装好 [Tampermonkey](https://www.tampermonkey.net/)，再点上方 **Install now** 即可安装并自动获取更新。

---

## ⚠️ 免责声明 / Disclaimer（请先阅读）

- 本项目**仅供个人同步自己的账号数据**使用。
- 抓取豆瓣、自动化写入 IMDb **可能违反双方的服务条款**（IMDb 的内部 API 返回中明确声明“禁止公开 / 商业 / 非私人用途”）。使用风险自负；如豆瓣 / IMDb 要求停止，请立即停用。
- 脚本**不包含、不收集、不上传任何账号或 Cookie**，全部复用你当前浏览器的登录态。
- 依赖的是 IMDb **未公开的内部接口**（GraphQL mutation、suggest CDN）与豆瓣页面结构，**随时可能变动**；相关端点 / 选择器已集中在文件顶部便于自修。
- 开源此代码不等于授权对其滥用；请遵守当地法律与平台条款。

---

## 功能特性

- 🎯 **权威匹配优先**：直接读取豆瓣条目页内嵌的 `IMDb: ttXXXXXXX` 编号，零猜测精确关联。
- 🔎 **智能兜底**：无 IMDb 编号时，用 IMDb 搜索框背后的 `suggest` 接口，按「相关度排序 + 年份相同 + 片名归一」匹配（可正确处理罗马化外文名，如 `七武士 → Shichinin no samurai`、`Rashômon` 去变音符）。
- ✍️ **写入 IMDb**：调用 `addWatchedTitle` / `rateTitle` 两条 mutation，标记看过并按星级打分（未打星的只标看过）。
- 🧪 **试运行**：先只解析不写入，核对匹配结果再正式执行。
- ⏯️ **断点续跑**：进度存在 `localStorage`，中断 / 限流后可继续；支持停止、重置。
- 🗂️ **列表缓存**：豆瓣列表只爬一次并缓存，重复点「开始」不会从头重爬；需更新时勾「刷新列表」强制重抓。
- 📄 **CSV 导出 / 导入**：导出含 `douban_sid` 的完整映射明细，可再「导入CSV」恢复——用于备份、或换浏览器/电脑时免重复匹配。
- 📊 **进度条**：单一进度条贯穿三个阶段（抓取 / 匹配 / 写入），下方实时显示当前步骤、`已完成/总数`、已用时间与预计剩余倒计时（采用平滑估算，一开始就较准）。
- 🟢 **状态指示**：面板顶部指示灯显示 空闲 / 运行中 / 已完成 / 已停止 / 未登录（运行时脉冲闪烁）；日志按 成功绿 / 警告黄 / 错误红 着色，重要信息一目了然。
- 🛡️ **限速**：内置请求间隔，降低被反爬拦截的概率。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 直接点击<a href="https://greasyfork.org/zh-CN/scripts/596763"><img src="https://img.shields.io/badge/Install%20now-orange?style=for-the-badge" alt="Install now from Greasy Fork"></a>按钮，Tampermonkey 会提示安装。
   - 或打开 Tampermonkey 面板 → 直接把 [`douban2imdb.user.js`](./douban2imdb.user.js)  拖进浏览器窗口，Tampermonkey 会提示安装。
   - 或打开 Tampermonkey 面板 → 「添加新脚本」→ 删除模板 → 粘贴 [`douban2imdb.user.js`](./douban2imdb.user.js) 全文 → 保存（Ctrl+S）。
4. 确保浏览器**同时已登录** [豆瓣](https://www.douban.com/) 与 [IMDb](https://www.imdb.com/)。

## 使用

1. 打开豆瓣列表页，例如看过：`https://movie.douban.com/mine?status=collect`。
2. 页面右上角出现「豆瓣 → IMDb 同步」面板（标题可拖动，避开页面浮层）。
3. 选择要同步的分组（看过 / 在看 / 想看）。
4. 先勾选「试运行」，点「开始」→ 检查日志里的匹配是否靠谱（`✓ 片名 → ttXXXX (来源)`）。
5. 取消「试运行」，再次「开始」正式写入 IMDb（列表已缓存不会重爬；已同步过的自动跳过）。
6. 按钮：「停止」中断；「导出CSV」下载明细；「导入CSV」恢复之前的映射；「重置」清除该分组进度以便重跑；勾选「刷新列表」强制重抓豆瓣列表。

> 建议：首次先对少量数据试运行；大批量时分时段跑，遇到限流停止后稍等再续跑（进度会保留）。

> ⚠️ **同步期间请勿刷新或切换页面**：脚本跑在当前网页里，整页跳转会中断它。浏览器的“离开此网站”弹窗文案无法自定义（安全限制），但**请点“取消”留在本页**。若不慎切走，回到 `movie.douban.com/mine` 页会**自动从断点续跑**。

## 匹配与评分规则

| 项目 | 规则 |
| --- | --- |
| 匹配来源优先级 | ① 豆瓣条目页 `IMDb 编号` → ② `suggest(英文又名)` → ③ `suggest(中文/原名)` |
| 年份判定 | 只接受与豆瓣年份**相同**的候选；同年多条时用片名归一进一步区分，仍不唯一则取相关度第一名为候选（保守，宁可漏不错加） |
| 名称归一 | `NFKD` 分解 + 去组合变音符（`\p{M}`）+ 非字母数字转空格 |
| 评分换算 | `IMDb 分 = 豆瓣星 × 2 − 1`（5★→9、4★→7、3★→5、2★→3、1★→1）；豆瓣未打星 → 仅标记看过 |
| TV / 动漫 | 豆瓣的“第 N 季”会归并到 IMDb 的**剧集条目**（按剧名 + 年份相近） |

## 配置（文件顶部，坏了自己改）

```js
const CFG = { listBase, statuses, pageStep: 15, maxPages: 80, delayMs: 600, storePrefix };
const RATING = (stars) => (stars > 0 ? stars * 2 - 1 : 0);
const IMDB_HEADERS = { /* x-imdb-* 等，Origin/Referer 已设为 imdb */ };
const ADD_W  = 'mutation AddWatchedTitle(...)';
const RATE   = 'mutation UpdateTitleRating(...)';
```

- 豆瓣被限流：调大 `CFG.delayMs`、调小 `maxPages` 分批。
- IMDb 接口报错（`watch=fail` / `rate=ERR`）：多半是内部 mutation 变了，去 IMDb 影片页手动点一次“标记看过 / 打分”，用开发者工具 Network 抓最新请求，替换 `ADD_W` / `RATE` / `IMDB_HEADERS`。
- 想换评分策略：改 `RATING`。

## 工作原理（简述）

- 通过 `GM_xmlhttpRequest` 发起跨域请求（特权 API，绕过 CORS 并自动附带目标域名 Cookie），因此脚本在豆瓣页运行也能安全读写 IMDb。
- 读取：豆瓣 `/mine?status=…` 列表页 + 每部影片的 `/subject/<id>/` 条目页。
- 匹配：豆瓣条目页里的 IMDb 编号（权威外键）优先；否则查 IMDb `v3.sg.media-imdb.com` 的 suggest 接口。
- 写入：`api.graphql.imdb.com` 的两条 GraphQL mutation。

## 相关文件

- [`douban2imdb.user.js`](./douban2imdb.user.js) — 油猴脚本本体。

## License

[MIT](./LICENSE)
