# dsh-netease-mail

**仓库：<https://github.com/WYHboop/dsh-netease-mail>** ｜ MIT

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

三种拿法，任选其一（A/B 不需要 GitHub、不需要 npm 账号；C 只要公开仓库的读权限）：

```powershell
# A. 拿到的是 .tgz（推荐给同事：一个文件，装完就是独立副本，源码目录挪走也不影响）
dsh plugin --profile desktop add C:\path\to\dsh-netease-mail-0.1.0.tgz

# B. 拿到的是源码文件夹（自己开发时用）
dsh plugin --profile desktop add link:C:/path/to/dsh-netease-mail

# C. 从 GitHub 拿（公开仓库）
git clone https://github.com/WYHboop/dsh-netease-mail.git
dsh plugin --profile desktop add link:.\dsh-netease-mail
```

装完在 DSH 的插件管理器里确认 `dsh-netease-mail` 已启用。
想自己出这个 tgz：在源码目录执行 `npm pack`。

## 配置（第一次用之前必须做）

三处任选其一，都能被读到（后者盖前者）：

| 放哪儿 | 适合谁 |
|---|---|
| 环境变量 `DSH_NETEASE_MAIL_SETTINGS` 指向的 JSON 文件 | 想把它放在任意位置 / 多份配置切换 |
| 用户目录 `~/.dsh/dsh-netease-mail.json` | **装成 tgz 的人最方便**（改这里不会被重装覆盖） |
| 插件目录里的 `local-settings.json` | 源码开发时（照 `local-settings.example.json` 复制） |

内容就两行：

```json
{ "account": "you@yourcompany.com", "authCodeFile": "D:\\secret\\authcode.txt" }
```

授权码也可以不给文件，改成设环境变量 `NETEASE_AUTH_CODE`。
**授权码本身既不进 `cordis.patch.yml`、也不会被回显**——`mail_check` 只告诉你它来自哪一处。

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