# 网易企业邮箱连接器（dsh-netease-mail）

把**网易企业邮**（`imap.qiye.163.com` / `smtp.qiye.163.com`）接进 DSH 对话：
**列信、读信、搜信、发信、存附件、改标记**，全都在聊天里一句话完成；
侧栏还挂一个三栏的「邮箱」面板，想看的时候直接看。

官方连接器只有 QQ 邮箱，插件市场里的邮件插件也多是 QQ 邮箱或只读看板
（`dsh-email` / `dsh-qq-email` / `dsh-email-board` / `dsh-pm-workbench` 的「QQ 邮箱只读收件箱」），
**还没见到一个明确写「网易企业邮」的**。所以这个插件是自己写的：
IMAP4rev1 与 SMTP 都直接跑在 Node 的 `node:tls` 上，**零第三方依赖**
（机器上没有 nodemailer / imapflow / mailparser，也不想为了一件事去装一整套打包链）。

## 安装

```powershell
# 1) 拿到这份代码（clone 到本机任意目录）
git clone <仓库地址> dsh-netease-mail

# 2) 装进某个 profile（桌面版用 desktop）
dsh plugin --profile desktop add link:C:/path/to/dsh-netease-mail
```

装完在 DSH 的插件管理器里确认 `dsh-netease-mail` 已启用；桌面版唤醒一次即可
（工具与面板两部分都是「装进 profile 就生效」，不需要重启宿主）。

**第一次用之前必须做的一件事**：把 `local-settings.example.json` 复制成同目录的
`local-settings.json`，填上邮箱账号与授权码来源（见下「配置」）。不填的话所有工具都会
明确告诉你「还没配邮箱账号」。

## 面板（侧栏「邮箱」）

> 面板截图没有随仓库发布：本机那张截图里是真实业务邮件（同事姓名、项目主题），
> 存在包外的 `_netease-mail-local\panel.png`。想自己看效果，装好之后点侧栏的「邮箱」即可。

插件带一套**客户端半边**（`lib/client.js`），在 DSH 侧栏挂一个「邮箱」图标，
点开是标准邮件客户端的三栏布局：

| 区域 | 内容 |
|---|---|
| 左 | 文件夹 + 各箱信数（`INBOX / 草稿箱 / 已发送 / 已删除 / 垃圾邮件`） |
| 中 | 邮件列表：未读点、📎 附件标记、★、时间、大小；顶部「只看未读」+ 搜索框；底部「加载更多」按 uid 向前翻页 |
| 右 | 正文（纯文本、`white-space: pre-wrap`）+ 操作条：回复 / 已读·未读 / 星标 / 存到已发送 / 删除；附件逐条「保存」 |

「写邮件」是浮层抽屉：收件人 / 抄送 / 主题 / 正文 / 附件（附件用 Windows 的 `OpenFileDialog`
挑，`lib/pick-files.ps1` 走 PowerShell 回来带 UTF-8 JSON，避免 GBK 控制台把中文路弄坏）。
**发送前有一次 `window.confirm`**，确认后才 POST `/mail/api2/send`——对外动作不能一键误触。

数据面是九条宿主路由（都在 `/mail/api2/*`，`kind: "exact"`）：
`bootstrap` / `list` / `message` / `search` / `pick-files` / `clientlog`，以及四个 POST：
`flags`（已读、星标、移动、删除）、`send`、`attachment`。
面板不缓存授权码，也不在客户端做任何解码——所有 MIME 解码都在宿主侧完成，客户端只拿 JSON。

★ 路径为什么是 `/mail/api2` 而不是 `/mail/api`：见坑 2 —— 旧路径已经被早期那版处理器钉死了。

## 两条调用通道（人家不需要点界面，也不需要伙伴代点）

面板只是"看得见"的那一半；同一批能力有**两条**独立通道，任何一条都能单独把事办完：

| 通道 | 谁在用 | 依赖 | 合适场景 |
|---|---|---|---|
| **工具**（`mail_*`，八个） | 人家在对话里 | 只要插件加载，**不需要 GUI 窗口开着** | 读信、搜索、发信、存附件、改标记——日常主力 |
| **面板路由**（`/mail/api2/*`，九条） | 面板界面 / 任意脚本 | 需要宿主在跑（端口随宿主；桌面版这次是 53226） | 面板交互；脚本批量操作；出证据 |

`_probe_api.mjs` 就是"免点击自检"：它自己找宿主端口，把九条路由**逐条打一遍**
（列信 / 读正文 / 搜索 / 已读↔未读往返 / 星标往返 / 存附件到临时目录 / 发信 `dryRun` / 上报通道），
输出逐行 ✅ 与耗时。脚本里**故意不调 `pick-files`**——那条会弹一个等人点的文件对话框，
脚本调用会一直挂着（坑 4）。

```
node _probe_api.mjs          # 自己找端口
node _probe_api.mjs 53226    # 指定端口
```

★ 界面右上角有一枚**构建戳**（`mail-ui-2026-11-19-a`）：它变了说明浏览器确实拿到了新的
`client.js`（客户端件不走构建，宿主直接读 `exports "./client"` 指向的文件，改完重载插件 + 刷新页面即生效）。

## 工具清单

| 工具 | 干什么 | 安全性 |
|---|---|---|
| `mail_check` | 登录自检：列文件夹 + 各箱邮件数/未读数 + 授权码来源（不回显授权码） | 只读 |
| `mail_folders` | 文件夹清单与计数 | 只读 |
| `mail_list` | 按时间倒序列信（uid / 主题 / 发件人 / 时间 / 大小 / 未读 / 星标 / 有无附件） | 只读 |
| `mail_read` | 按 uid 读正文（HTML→纯文本）+ 附件清单；可 `markRead=false` 不动状态 | 默认会标记已读 |
| `mail_search` | 关键词 / 发件人 / 主题 / 时间范围 / 未读 / 星标 | 只读 |
| `mail_send` | 发信（纯文本或 HTML、抄送密送、本机文件作附件、`dryRun` 演练） | ★ 对外动作，先问伙伴 |
| `mail_attachment` | 把附件存到本机（默认 `~/Downloads/mail-attachments`） | 只写本机文件 |
| `mail_flag` | 已读/未读、星标、移动、删除 | ★ 移动与删除先问伙伴 |

## 配置

配置有两层，优先级从低到高：

1. **`local-settings.json`**（本机私有，已被 `.gitignore` 忽略，不会进仓库）
   —— 你的账号、授权码文件路径、下载目录都写在这里。
   照 `local-settings.example.json` 复制一份改名即可。
2. **`cordis.patch.yml` 的 `config`**（随包发布的公开默认值）
   —— 只放服务器名、端口、页大小这类不含个人信息的参数；写了同名字段会盖掉上一层。

**授权码不进任何配置文件**（也请不要提交它），按顺序从三处找：

1. `config.authCode`（临时调试用，不建议长期留着）
2. 环境变量（默认名 `NETEASE_AUTH_CODE`，可用 `authCodeEnv` 改）
3. 授权码文件 `authCodeFile` 指向的文本文件（第一行、去掉首尾引号与 BOM）

`mail_check` 会明确告诉你这次用的是哪一处，但永远不回显授权码本身。

## 实测记录（2026-11-19，真实服务器）

| 项目 | 结果 |
|---|---|
| IMAP 登录 `imap.qiye.163.com:993` | ✅ 574 ms 内完成登录 + 5 个文件夹计数 |
| 文件夹（首次连上时） | INBOX 一百多封 / 草稿箱几十 / 已发送一千多 / 已删除 1 / 垃圾邮件 0（未读均为 0） |
| 文件夹（同日 15:16 复核） | INBOX 一百多 / 草稿箱 1 / 已发送 几十——**同一账号同一下午，同名文件夹的计数会变，见坑 1** |
| 服务器能力 | `IMAP4rev1 XLIST STARTTLS IDLE ID XAPPLEPUSHSERVICE UIDPLUS COMPRESS=DEFLATE` |
| 读一封 24 MB 的信（4 个中文名附件） | ✅ 正文正确解码，附件清单四个全对 |
| SMTP `smtp.qiye.163.com:465` | ✅ AUTH LOGIN 通过，收件人被接受（dryRun 未投递）526 ms |
| **真实发信（DATA 段落）** | ✅ 发给本账号，服务器回 `250 2.0.0 Ok: queued as …`，2.6 KB |
| **收回来再读** | ✅ 主题/正文/中文附件名全部正确，附件落地 257 B 与原件一字不差 |
| 8 个工具的端到端实测 | ✅ `mail_check` 596 ms、`mail_list`、`mail_read`、`mail_search`（中文关键词命中 33 封）、`mail_attachment`、`mail_flag`（加星→取消，净零） |
| MIME 往返自测（中文主题 / 双变体 / 中文附件名 / Latin-1 符号） | ✅ 四项全过（`_selftest_mime.mjs`） |

## 面板实测（2026-11-19 15:07–15:16）

| 项目 | 结果 |
|---|---|
| 槽位注册 | ✅ `sidebar.panellist` 与 `main` 都拿到 `{ id/key: "mail", order: 12, active: true }`（`cordis_inspect_query` 的 `Slots/listSubTree`） |
| 九条路由 HTTP | ✅ `bootstrap` / `list` / `message` / `search` 全部 200，返回的是真邮件（含一封 23.22 MB 的大信） |
| 面板渲染 | ✅ 三栏出数据、构建戳 `mail-ui-2026-11-19-a`、文件夹与列表都是真实的 |
| 面板里的点击交互 | ✅ 伙伴点的（15:22 回话：「这个我点通了」）。人家自己没点通——当时他用着电脑，windows MCP 报 `USER_CONTROL`，注入的点击被当成拖拽（文字被选蓝）。**所以人家改走"调用"这条路，见下一行** |
| 免点击九条路由（`_probe_api.mjs`） | ✅ 9/9 通过，**总用时 7.7 秒**：list 663 ms / message 461 ms / search 2759 ms（扫一百多封、命中 32）/ 已读↔未读往返 1312 ms / 星标往返 850 ms / 存附件 408 ms / 发信 dryRun 522 ms / 上报通道 4 ms / pick-files 故意跳过 |
| 同上（15:56 优化后再测） | ✅ 9/9 通过，**总用时 4.6 秒**：list 155 ms / message 153 ms / search 2170 ms / 已读↔未读 246 ms / 星标 175 ms / 存附件 373 ms / 发信 dryRun 547 ms / 上报 4 ms |

## 速度优化（2026-11-19 15:40–15:56）——「点击挺卡的」这一轮的账

伙伴的话：**「反正现在点击各内容还是挺卡的。能优化到更好么？」** 卡的根因有四层，逐层拆掉：

| 层 | 原来 | 现在 | 怎么做的 |
|---|---|---|---|
| ① 每次请求都重新登录 | 每次调用开一条 IMAP 连接、登录一次，**500–650 ms 固定开销** | 复用一条连接（空闲 120 秒后自己关），list 433 → **107 ms**，重复读信 103 → 95 ms | `withSession` 改成连接池 + 串行队列（IMAP 单连接不能并发）；连不上会识别「连接类错误」并自动重试一次 |
| ② 读一封大信要整封下载 | 读 23.22 MB 的信 **37.5 秒**，其实只要正文那几百字 | **1.1 秒** | 先取 `BODYSTRUCTURE`，按部件路径只 `BODY.PEEK[<path>]` 取正文；附件不进内存，大小按 base64 长度估算并标「约」 |
| ③ 读缓冲 O(n²) | `WireReader` 每收到一块就 `Buffer.concat` 整个缓冲，一封信收齐 **142 秒** | **21 秒**（同一封） | 改成分块数组 + 只在真有读取需求时拼一次 |
| ④ 重复动作重复打服务器 | 同一封信再开一次还得再取；同一句搜索按两遍再扫一遍 | 读信缓存 120 秒（重复开 **0 ms**）、搜索缓存 20 秒（第 2 次 **0 ms**） | `readMessage` 内部存 `fullText` 再按 `bodyChars` 成形；`searchMessages` 外挂 `SEARCH_CACHE_TTL_MS = 20000` |

- **存大附件**也改成按部件取：一封 1.58 MB 的信里 489 KB 的附件 **502 ms**（整封要 2.5 秒）。
- ★ **大附件还有一道天生的墙：网易服务器下载速率约 1 MB/s**。同一封的 13.19 MB `.dwg`
  在线 17.58 MB，**下载 16 970 ms → 解码只要 86 ms**。这层不是本插件的代码问题，
  代码再怎么改也绕不过去；`1.04 MB/s` 这条数据是 `_probe_partspeed.mjs` 拆段量出来的。
- 面板端的**乐观更新**本来就有（点星标/点已读立刻改本地状态，不重取列表），所以这一轮只动服务端。
- 「按部件取」的正确性是对账过的（`_probe_struct.mjs`）：同一封信「整封解析」与「按部件取」
  的正文前 200 字一致、附件清单（文件名/类型/顺序）一致。

## 已知道的坑与限制

- **`EXISTS` 会撒谎**：首次连接时网易曾对 INBOX 报 `* 2552 EXISTS`，重连后稳定为 `146`；
  后来又见过 `草稿箱 49 → 1`、`已发送 1304 → 47` 这种整数量级的变化（同一账号、同一下午）。
  所以**面板与工具一律以 `UID SEARCH ALL` 的条数为准**（`listFolders({ exactCounts: true })`
  会替每个文件夹多跑一次检索，代价约 0.9 秒），`exists` 只当参考。
- **中文关键词不能直接交给服务端**：IMAP `SEARCH` 的非 ASCII 参数要 `CHARSET UTF-8` + 字面量，
  网易对此支持不稳定。所以中文一律**拉回本地过滤**（先按主题/发件人，必要时再翻正文），
  `scanLimit` 控制扫描上限（默认 300 封），`bodyScan` 控制最多翻多少封正文（默认 10）。
  正文回捞另有**两道闸**（2026-11-19 加）：单封超过 3 MB（`bodyScanMaxBytes`）直接跳过，
  整段最多给 8 秒（`bodyBudgetMs`）——原因见坑 3。
- **★ 面板网页路由一旦注册，就跟着当时那份模块活着**（重载插件不会换，已改法）：
  实测证据很干脆——改完 `searchMessages` 的闸门、`disable→enable` 重载插件之后，
  再打 `/mail/api/search` 还是一条 `bodyScanned` 字段都没有的旧响应，且耗时 47 秒（旧逻辑在拉 20 MB/51 MB 的大信）。
  诊断钥匙：新代码多出来的字段（`bodyScanned` / `elapsedMs`）在响应里**不存在**，就说明跑的是旧处理器。
  改法：`defineRoutes` 只向宿主注册一层**薄委托**，真正处理器放进 `globalThis.__dshNeteaseMailRoutes__` 那张表，
  每次 `apply` 覆盖它；路径同时升到 **`/mail/api2`**，绕开已经被钉死的 `/mail/api`。
  这样「改代码 → 重载插件」立即生效，**不必重启宿主**（重启桌面版会掐掉正在进行的对话）。
  同类症状还包括：`flags` 从 0.9 秒变慢到 24 秒、`pick-files` 拿着旧逻辑挂着不走。
- **`pick-files` 会弹一个等人点的文件对话框**：脚本调用它就会一直挂着（探测脚本曾因此把两个
  PowerShell 对话框留在伙伴桌面上）。所以 `_probe_api.mjs` 故意跳过它。
- **没有 IDLE 推送**：连接是复用的（空闲 120 秒自己关），但**不收服务器推送**，
  所以「有没有新邮件」只能靠主动查。要做「来信通知」得另起常驻任务，不在本插件范围内。
- **正文截断**：默认显示 6000 字（`bodyChars`），截断时会明确告知全文长度。
- **附件不随列表展示大小明细**：列表只有「有无附件」的启发式判断（解析 `BODYSTRUCTURE`），
  精确清单在 `mail_read` 里。
- **不做 HTML 渲染**：正文统一转纯文本（保留段落与列表符号），避免把跟踪像素和内联脚本带进来。
- **客户端崩溃上报还没验通**：`/mail/api2/clientlog` 路由本身是通的（用 PowerShell POST 能落盘到
  包根目录的 `client-errors.log`），但客户端 `apply()` 里那一发 `report("apply")` **没落盘也没报错**，
  原因未查。界面目前的兜底是 `Boundary` 错误边界，会渲染一段红字而不是白屏。
- **★ 主题里带 `·`、`♪`、`é` 这类 Latin-1 区字符时曾整串烂掉**（已修，留档）：
  症状是收件箱里显示成 `ÒöêK · dsh-netease-mail , á j`，而线上的
  `Subject: =?UTF-8?B?…?=` 完全正确。根因是 `decodeHeaderValue` 在 `decodeWords`
  之后**又跑了一次** `fixRawBytes`——它拿 `/[\u0080-\u00ff]/` 判「有裸 8 位字节」，
  而解出来的中文里夹着 U+00B7「·」，于是把整串当裸字节再解一遍。
  教训：**编码字解码之后不能再按字节猜码**；回归用例已加进 `_selftest_mime.mjs` 第 4 项。
  纯中文主题（不含 Latin-1 区字符）不会触发，所以一开始几封中文业务信看着都正常。
- **`BODYSTRUCTURE` 里的文件名也是 RFC2047 编码字**：不解码就会把
  `=?UTF-8?B?6aKE55Sf5rCU5Y+R5Zmo…?=` 当文件名原样吐出来。已在 `buildStructureNode` 里
  统一过一遍 `decodeHeaderValue`。
- **大附件慢在服务器带宽，不在代码**：实测约 `1.04 MB/s`（`_probe_partspeed.mjs`）。
  一个 13 MB 的 `.dwg` 就得等 17 秒，这段没办法靠优化代码消掉，只能说清楚原因。

## 自检脚本（排障用，**不在发布包里**）

开发时留在本机的那批 `_probe*.mjs` / `_selftest_mime.mjs` 是**只读**探针，
它们（连同 `local-settings.json`、`client-errors.log`、`_market.json`、`docs/panel.png`）
都写进了 `.gitignore`，不进仓库、也不进 `package.json` 的 `files`；
下面是它们的用途，方便日后重跑时知道该拿哪一个：

- `node _probe.mjs 5` — 自检 + 列收件箱 5 封 + 读一封（不标记已读）
- `node _probe_raw.mjs` — 转储 `LIST / EXAMINE / SEARCH / FETCH` 的原始应答
- `node _selftest_mime.mjs` — 离线跑 MIME 拼装与解析的往返
- `node _probe_smtp.mjs` — SMTP 演练（认证 + 收件人校验，不投递）
- `node _probe_subject.mjs` — 转储某封信的原始 `Subject` 头，逐段 base64 手动解码对比
- `node _probe_filename.mjs` — 转储原始 `Content-Disposition`，核对中文附件名
- `node _probe_counts.mjs` — 复核五个文件夹的计数（`SELECT EXISTS` 与 `UID SEARCH ALL` 对照）
- `node _probe_api.mjs [port]` — **免点击自检**：自动找宿主端口，把 `/mail/api2/*` 九条路由逐条打一遍
  （跳过会弹对话框的 `pick-files`），出一张 ✅ 与耗时表；缺省按 `53226 → 3080 → …` 试
- `node _probe_searchtime.mjs` — 把搜索拆成 SELECT / SEARCH / FETCH 头 / FETCH 原始正文 四段计时，
  用来判断慢在哪一段（实测：头 148 封 918 ms，一封 20 MB 的信取原始 3529 ms）
- `node _probe_search2.mjs` — 直接调 `searchMessages` 两次，看库内计时与「正文翻了几封」的计数
- `node _probe_searchcache.mjs` — 同一句搜索连打三次，验证 20 秒缓存（第 2、3 次应为 0 ms、`fromCache: true`）
- `node _probe_struct.mjs` — 同一封信「整封解析」与「按 BODYSTRUCTURE 只取正文部件」对账（正文 + 附件清单）
- `node _probe_partspeed.mjs` — 把一个 13 MB 附件部件拆成「下载」与「解码」两段计时（证明慢在带宽）
- `node _probe_pool.mjs` / `node _probe_readtime.mjs` / `node _probe_bigread.mjs` / `node _probe_bigsave.mjs`
  — 各自量连接复用、读信、读大信、存大附件的耗时（优化前的基线就是它们量的）

它们不在 `package.json` 的 `files` 里，装进 profile 时不会被带上。