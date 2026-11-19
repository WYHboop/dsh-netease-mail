# dsh-netease-mail

网易企业邮箱（`qiye.163.com`）的 DSH 插件。自写 IMAP/SMTP，**零第三方依赖**
（只用到 Node 的 `node:tls` / `node:net` / `node:crypto`），要求 Node ≥ 20。

装上之后有两半：

- **对话工具**（八个，`mail_*`）：列信、读信、搜信、发信、存附件、改标记，一句话就能办，
  不需要界面开着。
- **侧栏面板「邮箱」**：三栏（文件夹 / 列表 / 正文），能读信、搜信、写邮件、存附件、改标记。
  看信的时候不占对话。

两条通道互相独立：**工具**与**面板路由**（`/mail/api2/*`，界面和脚本都能打）——
任何一条都能单独把事办完。

速度：连接是复用的（不用每次重新登录），大信只取正文部件、不下载附件，读过的信与搜过的词
各有短缓存——点一下列表 0.1 秒出头、开一封 23 MB 的信 1 秒左右（原来是 37 秒）。
代价与上限写在 [docs/DETAIL.md](docs/DETAIL.md) 的「速度优化」一节。

## 安装

```powershell
git clone <仓库地址> dsh-netease-mail
dsh plugin --profile desktop add link:C:/path/to/dsh-netease-mail
```

装完在 DSH 的插件管理器里确认 `dsh-netease-mail` 已启用。

## 配置（第一次用之前必须做）

1. 把 `local-settings.example.json` 复制成同目录的 `local-settings.json`；
2. 填 `account`（你的企业邮箱地址）与 `authCodeFile`（存授权码的文本文件路径），
   或者改用环境变量 `NETEASE_AUTH_CODE`。

`local-settings.json` 已被 `.gitignore` 忽略，**不会进仓库**；随包发布的
`cordis.patch.yml` 里只有服务器名与端口这类公开参数，不含任何个人账号。
授权码本身既不进配置文件、也不会被回显——`mail_check` 只告诉你它来自哪一处。

## 工具

- `mail_check` —— 连通性自检（登录、文件夹、计数、授权码来源）
- `mail_folders` / `mail_list` / `mail_read` / `mail_search` —— 看信
- `mail_send` —— 发信（对外动作，先问再发；支持 `dryRun` 演练）
- `mail_attachment` —— 存附件
- `mail_flag` —— 已读/未读/星标/移动/删除

## 结构

```
lib/imap.js      IMAP4rev1 客户端（TLS、字面量、modified UTF-7）
lib/smtp.js      SMTP 客户端（EHLO / AUTH LOGIN / MAIL / RCPT / DATA）
lib/mime.js      RFC 2047 / 2231、multipart、QP/base64、HTML→文本、发信拼装
lib/settings.js  配置归一化（local-settings.json ← 插件 config）+ 授权码三处回退
lib/mailbox.js   高层操作（复用连接池 + 读信/搜索缓存 + 按部件取正文与附件）
lib/index.js     工具注册与报告排版 + 九条 /mail/api2/* 路由（薄委托，改代码重载即生效）
lib/client.js    侧栏面板（三栏 UI，@deepseek-ai/dsh-client-* 客户端半边）
lib/pick-files.ps1  挑附件用的 OpenFileDialog（ASCII-only，UTF-8 JSON 回传）
```

## 已知限制

`EXISTS` 计数会飘（一律以 `UID SEARCH ALL` 为准）、中文关键词只能本地过滤、
没有 IDLE 推送、正文默认截断 6000 字、不做 HTML 渲染、大附件受服务器带宽限制（约 1 MB/s）。
逐条原因与实测数据见 [docs/DETAIL.md](docs/DETAIL.md) 的「已知道的坑与限制」。

MIT License.