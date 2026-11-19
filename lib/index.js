/**
 * dsh-netease-mail — 网易企业邮箱（qiye.163.com）连接器。
 *
 * 只做一件事：把网易企业邮（qiye.163.com）变成对话里能直接调的工具 ——
 * 看文件夹、列信、读信、搜信、发信、存附件、改标记；另有一条 /mail/api2/* 数据面给侧栏面板用。
 * 协议层是自己写的 IMAP / SMTP（lib/imap.js、lib/smtp.js），没有任何第三方依赖。
 *
 * 安全边界：读操作（check/folders/list/read/search/attachment）可以直接用；
 * `mail_send` 与 `mail_flag`（移动/删除）是对外或不可逆动作，必须先拿到伙伴的明确同意。
 */

import { normaliseSettings, describeCredential } from "./settings.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkConnection,
  closePool,
  listFolders,
  listMessages,
  readMessage,
  searchMessages,
  sendMail,
  saveAttachments,
  updateMessages,
} from "./mailbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// 日志写在包根目录（不在 lib 里），它已在 .gitignore 中，不会被打进发布包。
const LOG_FILE = join(HERE, "..", "client-errors.log");
const PICK_SCRIPT = join(HERE, "pick-files.ps1");

/* ------------------------------------------------------------- 报告排版 */

function bytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function clip(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function reportCheck(result) {
  const lines = [];
  lines.push(`邮箱自检 ✅ ${result.account}`);
  lines.push(`IMAP ${result.imap} · SMTP ${result.smtp} · 授权码来自${result.credentialSource}`);
  lines.push(`登录 → 列文件夹 → 读计数全部通过，用时 ${result.elapsedMs} ms。`);
  lines.push("");
  lines.push(`服务器能力：${result.capabilities.slice(0, 12).join(" ") || "(未报告)"}`);
  lines.push("");
  lines.push(`文件夹（共 ${result.folders.length} 个）：`);
  for (const folder of result.folders) {
    const unseen = folder.unseen ? `，未读 ${folder.unseen}` : "";
    lines.push(`  · ${folder.name} — ${folder.messages} 封${unseen}`);
  }
  return lines.join("\n");
}

function reportFolders(result) {
  const lines = [`文件夹清单（共 ${result.folders.length} 个）`];
  for (const folder of result.folders) {
    if (!folder.selectable) {
      lines.push(`  · ${folder.name} — 容器（不可选）`);
      continue;
    }
    const unseen = folder.unseen ? `，未读 ${folder.unseen}` : "，全部已读";
    lines.push(`  · ${folder.name} — ${folder.messages} 封${unseen}`);
  }
  return lines.join("\n");
}

function reportList(result) {
  const lines = [];
  const unreadNote = result.unreadInPage ? `，其中本页未读 ${result.unreadInPage} 封` : "";
  const countNote = result.serverExists != null && result.serverExists !== result.exists
    ? `（服务器 COUNT 曾报 ${result.serverExists} 封，以 UID 检索为准）`
    : "";
  lines.push(
    `【${result.mailbox}】共 ${result.exists} 封${countNote}（未读 ${result.unseenInBox} 封）· 命中 ${result.matched} 封 · 本页 ${result.shown} 封${unreadNote}`,
  );
  if (!result.messages.length) {
    lines.push("");
    lines.push("没有符合条件的邮件。");
    return lines.join("\n");
  }
  lines.push("");
  result.messages.forEach((message, index) => {
    const flags = [message.unread ? "未读" : "已读", message.flagged ? "星标" : "", message.hasAttachments ? "有附件" : ""]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${index + 1}. uid=${message.uid}  ${message.subject}`);
    lines.push(`   ${message.from} · ${message.date}（${message.ago}）· ${bytes(message.size)} · ${flags}`);
  });
  lines.push("");
  lines.push("读哪一封就用 mail_read（folder + uid）；要正文外加附件清单，它一次给全。");
  return lines.join("\n");
}

function reportSearch(result) {
  const lines = [];
  lines.push(`在【${result.mailbox}】里搜索：扫了 ${result.scanned} 封，命中 ${result.matched} 封，列出 ${result.shown} 封`);
  lines.push(`服务端条件：${result.criteria}`);
  // 正文回捞的三条闸门要如实说，别让人以为「没命中」就是「确实没有」。
  const bodyNotes = [];
  if (result.bodyScanned) bodyNotes.push(`翻了 ${result.bodyScanned} 封正文`);
  if (result.bodySkippedLarge) bodyNotes.push(`跳过 ${result.bodySkippedLarge} 封超过 3 MB 的`);
  if (result.bodySkippedBudget) bodyNotes.push(`另有 ${result.bodySkippedBudget} 封没来得及翻`);
  if (result.bodyStoppedByBudget) bodyNotes.push("★ 正文没找完（撞上时间预算），要更彻底就加 sinceDays 缩小范围");
  if (bodyNotes.length) lines.push(`正文回捞：${bodyNotes.join("；")}`);
  if (result.elapsedMs) lines.push(`用时 ${result.elapsedMs} ms`);
  if (!result.messages.length) {
    lines.push("");
    lines.push("没有找到。换关键词、放宽时间，或者去掉 unreadOnly 再试。");
    return lines.join("\n");
  }
  lines.push("");
  result.messages.forEach((message, index) => {
    const flags = [message.unread ? "未读" : "已读", message.hasAttachments ? "有附件" : ""].filter(Boolean).join(" · ");
    lines.push(`${index + 1}. uid=${message.uid}  ${message.subject}`);
    lines.push(`   ${message.from} · ${message.date}（${message.ago}）· ${bytes(message.size)} · ${flags}`);
    if (message.snippet) lines.push(`   …${clip(message.snippet, 120)}`);
  });
  return lines.join("\n");
}

function reportRead(result) {
  const lines = [];
  lines.push(`【主题】${result.subject}`);
  lines.push(`【发件人】${result.from}`);
  if (result.to) lines.push(`【收件人】${result.to}`);
  if (result.cc) lines.push(`【抄送】${result.cc}`);
  lines.push(`【时间】${result.date}`);
  lines.push(`【位置】${result.mailbox} · uid=${result.uid}`);
  if (result.bodySource && result.bodySource !== "整封") lines.push(`【取法】${result.bodySource}`);
  if (result.fromCache) lines.push("【取法】刚读过，走缓存");
  if (result.attachments.length) {
    lines.push(`【附件】${result.attachments.length} 个：`);
    for (const file of result.attachments) {
      const size = file.sizeIsEstimate ? `约 ${bytes(file.size)}` : bytes(file.size);
      lines.push(`   [${file.index}] ${file.filename}（${file.contentType}，${size}）${file.embedded ? " · 内嵌" : ""}`);
    }
  } else {
    lines.push("【附件】无");
  }
  lines.push("");
  lines.push("──────── 正文 ────────");
  lines.push(result.text ? result.text.trim() : "(正文为空或只有 HTML 结构)");
  if (result.truncated) lines.push(`\n…… 正文被截断（全文 ${result.totalChars} 字，这里显示了前 ${result.text.length} 字）`);
  if (result.attachments.length) {
    lines.push("");
    lines.push("要存附件就 mail_attachment（folder + uid，可选 index 只存某一个）。");
  }
  return lines.join("\n");
}

function reportSend(result) {
  const lines = [];
  if (result.dryRun) {
    lines.push("（演练模式：只验证到收件人被接受，没有真正投递）");
    lines.push(`SMTP 认证通过 ✅ 发件人 ${result.from}`);
  } else {
    lines.push(`已投递 ✅ ${result.response ?? ""}`.trim());
  }
  lines.push(`发件人：${result.from}`);
  lines.push(`收件人：${result.accepted.join(", ")}`);
  if (result.cc.length) lines.push(`抄送：${result.cc.join(", ")}`);
  if (result.bcc.length) lines.push(`密送：${result.bcc.length} 个（不显示地址）`);
  if (result.rejected.length) {
    lines.push(`被拒：${result.rejected.map((item) => `${item.recipient}（${item.code} ${item.message}）`).join("；")}`);
  }
  lines.push(`主题：${result.subject}`);
  lines.push(`大小：${bytes(result.bytes)}${result.attachments.length ? ` · 附件 ${result.attachments.map((file) => file.filename).join("、")}` : ""}`);
  lines.push(`Message-ID：${result.messageId}`);
  return lines.join("\n");
}

function reportAttachments(result) {
  if (!result.saved.length) return `${result.dir}\n${result.note ?? "没有可保存的附件"}`;
  const lines = [`已保存 ${result.saved.length} 个附件（共 ${result.total} 个）到 ${result.dir}`];
  for (const file of result.saved) lines.push(`  · ${file.filename} — ${bytes(file.size)}`);
  return lines.join("\n");
}

function reportUpdate(result) {
  return result.note ?? `${result.action} 完成`;
}

/* --------------------------------------------------------------- 工具表 */

const textOutput = (render) => ({
  schema: {
    type: "object",
    properties: { report: { type: "string" } },
    required: ["report"],
    additionalProperties: false,
  },
  render: (_args, value) => [
    { type: "text", text: typeof value?.report === "string" ? value.report : JSON.stringify(value, null, 2) },
  ],
});

const folderParam = { type: "string", description: "文件夹名，默认 INBOX；可用 mail_folders 查全名（如「已发送」）" };

function defineTools(register, settings) {
  const wrap = (render, run) => async (args) => {
    try {
      return { report: render(await run(args ?? {})) };
    } catch (error) {
      const detail = error?.message ?? String(error);
      return { report: `操作没成功：${detail}` };
    }
  };

  register({
    name: "mail_check",
    description:
      "网易企业邮箱连通性自检：登录、列文件夹、读各箱邮件数与未读数，并回报授权码来自哪个来源（不回显授权码）。"
      + "第一次用邮箱工具、或报错怀疑凭据/网络时先跑它。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: textOutput(),
    execute: wrap(reportCheck, () => checkConnection(settings)),
  });

  register({
    name: "mail_folders",
    description: "列出网易企业邮箱的全部文件夹（收件箱、已发送、垃圾箱等）及各自邮件数与未读数。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: textOutput(),
    execute: wrap(reportFolders, async () => ({ folders: await listFolders(settings, { withCounts: true }) })),
  });

  register({
    name: "mail_list",
    description:
      "列出一个文件夹里最近的邮件（按时间倒序），返回每封的 uid、主题、发件人、时间、大小、未读/星标/是否有附件。"
      + "用 mail_read 再打开正文。默认读收件箱。",
    parameters: {
      type: "object",
      properties: {
        mailbox: folderParam,
        limit: { type: "number", description: "列出几封，默认 15，上限 60" },
        unreadOnly: { type: "boolean", description: "只看未读" },
        sinceDays: { type: "number", description: "只看最近 N 天内收到的" },
      },
      additionalProperties: false,
    },
    output: textOutput(),
    execute: wrap(reportList, (args) => listMessages(settings, args)),
  });

  register({
    name: "mail_read",
    description:
      "按 uid 读一封邮件的正文（HTML 已转成纯文本）并列出附件清单。默认在读的同时标记为已读；"
      + "只想看看不想改状态就传 markRead=false。正文过长会截断并告知全文长度。",
    parameters: {
      type: "object",
      properties: {
        uid: { type: "number", description: "邮件的 UID（从 mail_list / mail_search 得到）" },
        mailbox: folderParam,
        markRead: { type: "boolean", description: "是否顺手标记已读，默认 true" },
        bodyChars: { type: "number", description: "正文最多显示多少字，默认 6000" },
      },
      required: ["uid"],
      additionalProperties: false,
    },
    output: textOutput(),
    execute: wrap(reportRead, (args) => readMessage(settings, args)),
  });

  register({
    name: "mail_search",
    description:
      "搜索邮件：关键词（中英文都可以，中文在本地匹配，英文走服务端全文检索）、发件人、主题、时间范围、未读/星标过滤。"
      + "返回 uid 供 mail_read 打开。注意会扫描最近若干封（默认 300），范围太大可加 sinceDays 缩小。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "关键词，匹配主题/发件人，必要时也匹配正文" },
        mailbox: folderParam,
        from: { type: "string", description: "发件人包含的字符串" },
        subject: { type: "string", description: "主题包含的字符串" },
        sinceDays: { type: "number", description: "最近 N 天" },
        beforeDays: { type: "number", description: "N 天以前" },
        unreadOnly: { type: "boolean", description: "只看未读" },
        flaggedOnly: { type: "boolean", description: "只看星标" },
        limit: { type: "number", description: "最多返回几封，默认 15" },
        scanLimit: { type: "number", description: "最多扫描最近多少封，默认 300" },
        bodyScan: { type: "number", description: "头里没命中时，再翻多少封正文，默认 10（单封超过 3 MB 跳过，总共 8 秒预算）" },
      },
      additionalProperties: false,
    },
    output: textOutput(),
    execute: wrap(reportSearch, (args) => searchMessages(settings, args)),
  });

  register({
    name: "mail_send",
    description:
      "用网易企业邮箱发一封信（支持纯文本或 HTML 正文、本机文件作附件、抄送密送）。"
      + "★ 这是对外动作：必须先把收件人、主题、正文给伙伴过目并拿到明确同意，才能调用；"
      + "拿不准就先传 dryRun=true，只验证 SMTP 认证与收件人是否被接受，不真正投递。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "收件人地址数组" },
        cc: { type: "array", items: { type: "string" }, description: "抄送地址数组" },
        bcc: { type: "array", items: { type: "string" }, description: "密送地址数组" },
        subject: { type: "string", description: "主题" },
        text: { type: "string", description: "纯文本正文" },
        html: { type: "string", description: "HTML 正文（可选，给了就发双变体）" },
        attachments: { type: "array", items: { type: "string" }, description: "本机文件绝对路径数组" },
        dryRun: { type: "boolean", description: "只做认证与收件人校验，不投递" },
      },
      required: ["to", "subject"],
      additionalProperties: false,
    },
    output: textOutput(),
    execute: wrap(reportSend, (args) => sendMail(settings, args)),
  });

  register({
    name: "mail_attachment",
    description: "把某封邮件的附件存到本机（默认存到下载目录下的 mail-attachments）。不传 index 就全部保存。",
    parameters: {
      type: "object",
      properties: {
        uid: { type: "number", description: "邮件 UID" },
        mailbox: folderParam,
        index: { type: "number", description: "只存第几个附件（0 起，编号见 mail_read）" },
        dir: { type: "string", description: "保存目录，默认设置里的 downloadDir" },
      },
      required: ["uid"],
      additionalProperties: false,
    },
    output: textOutput(),
    execute: wrap(reportAttachments, (args) => saveAttachments(settings, args)),
  });

  register({
    name: "mail_flag",
    description:
      "改邮件状态：read/unread（已读未读）、flag/unflag（星标）、move（移动到别的文件夹）、delete（删除）。"
      + "★ move 与 delete 会改动邮箱内容，是较重的动作，先跟伙伴确认再调用。",
    parameters: {
      type: "object",
      properties: {
        uids: { type: "array", items: { type: "number" }, description: "要处理的 UID 数组" },
        mailbox: folderParam,
        action: {
          type: "string",
          enum: ["read", "unread", "flag", "unflag", "move", "delete"],
          description: "要做什么",
        },
        target: { type: "string", description: "action=move 时的目标文件夹名" },
      },
      required: ["uids", "action"],
      additionalProperties: false,
    },
    output: textOutput(),
    execute: wrap(reportUpdate, (args) => updateMessages(settings, args)),
  });
}

/* ------------------------------------------------------- Web GUI 路由 */

/**
 * 面板的数据面。客户端只用 same-origin fetch 打这些路径，解析逻辑一律留在服务端，
 * 前端不复制一份 —— 那样两处口径迟早会分家。
 */
const ROUTE_TABLE_KEY = "__dshNeteaseMailRoutes__";
const ROUTE_API = "/mail/api2";

function defineRoutes(server, settings) {
  // ★ 踩过的坑（2026-11-19 实测）：插件的网页路由一旦注册，就**跟着当时那份模块**活着 ——
  //   重载插件（disable→enable）不会把旧路由换掉，旧处理器继续吃请求，
  //   于是「代码改了、面板还是老行为」，且旧代码没有的超时闸门全都不生效。
  //   ⇒ 路由只注册一层「薄委托」，真正的处理器放进 globalThis 的一张表里，每次 apply 覆盖它；
  //     改代码 → 重载插件 → 立刻生效，不用重启宿主。
  //   ⇒ 路径同时升到 /mail/api2，绕开已经被钉死的旧 /mail/api 那一批。
  const routes = new Map();
  globalThis[ROUTE_TABLE_KEY] = routes;
  const webServer = {
    register({ kind = "exact", path, handler }) {
      const livePath = ROUTE_API + String(path).replace(/^\/mail\/api2?/, "");
      routes.set(livePath, handler);
      try {
        server.register({
          kind,
          path: livePath,
          handler: (request, response) => {
            const live = globalThis[ROUTE_TABLE_KEY]?.get(livePath) ?? handler;
            Promise.resolve()
              .then(() => live(request, response))
              .catch((error) => {
                try {
                  json(response, 500, { error: String(error?.message ?? error) });
                } catch {
                  /* 响应已经断了 */
                }
              });
          },
        });
      } catch (error) {
        // 宿主里还留着上一轮的同一条路径 → 注册被拒；但上面那张表已经换成新的了，不算失败。
        server?.logger?.warn?.(`[dsh-netease-mail] 网页路由 ${livePath} 注册被拒：${error?.message ?? error}`);
      }
    },
  };

  const json = (response, status, body) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  };

  const readJson = (request, limit = 2 * 1024 * 1024) =>
    new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          rejectBody(new Error("请求体太大"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (!chunks.length) return resolveBody({});
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          rejectBody(new Error(`请求体不是合法 JSON：${error.message}`));
        }
      });
      request.on("error", rejectBody);
    });

  const guarded = (handler) => (request, response) => {
    Promise.resolve()
      .then(() => handler(request, response))
      .catch((error) => {
        const message = String(error?.message ?? error);
        try {
          json(response, 500, { error: message });
        } catch {
          /* 响应已经断了 */
        }
      });
  };

  const query = (request) => new URL(request.url, "http://localhost").searchParams;

  /* 面板启动时的第一口数据：账号、文件夹计数、授权码来源 */
  webServer.register({
    kind: "exact",
    path: "/mail/api/bootstrap",
    handler: guarded(async (request, response) => {
      const credential = describeCredential(settings);
      const folders = await listFolders(settings, { withCounts: true, exactCounts: true });
      json(response, 200, {
        account: settings.account,
        displayName: settings.displayName ?? "",
        imap: `${settings.imapHost}:${settings.imapPort}`,
        smtp: `${settings.smtpHost}:${settings.smtpPort}`,
        credentialSource: credential.source ?? "",
        credentialAvailable: credential.available,
        credentialReason: credential.reason ?? "",
        downloadDir: settings.downloadDir,
        folders: folders
          .filter((folder) => folder.selectable !== false)
          .map((folder) => ({ name: folder.name, label: folder.name, exists: folder.messages ?? 0, unseen: folder.unseen ?? 0 })),
      });
    }),
  });

  webServer.register({
    kind: "exact",
    path: "/mail/api/list",
    handler: guarded(async (request, response) => {
      const params = query(request);
      const result = await listMessages(settings, {
        mailbox: params.get("folder") || settings.defaultMailbox,
        limit: Number(params.get("limit")) || settings.pageSize,
        unreadOnly: params.get("unread") === "1",
        beforeUid: Number(params.get("before")) || 0,
        sinceDays: Number(params.get("sinceDays")) || 0,
      });
      json(response, 200, result);
    }),
  });

  webServer.register({
    kind: "exact",
    path: "/mail/api/message",
    handler: guarded(async (request, response) => {
      const params = query(request);
      const result = await readMessage(settings, {
        mailbox: params.get("folder") || settings.defaultMailbox,
        uid: Number(params.get("uid")),
        // 界面上「打开即已读」由客户端单独发一次 flags，这里只负责把信读出来
        markRead: false,
        bodyChars: Number(params.get("bodyChars")) || settings.bodyChars,
      });
      json(response, 200, result);
    }),
  });

  webServer.register({
    kind: "exact",
    path: "/mail/api/search",
    handler: guarded(async (request, response) => {
      const params = query(request);
      const result = await searchMessages(settings, {
        mailbox: params.get("folder") || settings.defaultMailbox,
        keyword: params.get("q") || "",
        limit: Number(params.get("limit")) || settings.pageSize,
        // 正文回捞默认 10 封 / 8 秒预算；界面或脚本要更狠或更省都可以自己给。
        bodyScan: params.get("bodyScan") === null ? undefined : Number(params.get("bodyScan")),
        scanLimit: params.get("scan") === null ? undefined : Number(params.get("scan")),
      });
      json(response, 200, result);
    }),
  });

  webServer.register({
    kind: "exact",
    path: "/mail/api/flags",
    handler: guarded(async (request, response) => {
      const body = await readJson(request);
      const result = await updateMessages(settings, {
        mailbox: body.folder || settings.defaultMailbox,
        uids: body.uids,
        action: body.action,
        target: body.target,
      });
      json(response, 200, result);
    }),
  });

  webServer.register({
    kind: "exact",
    path: "/mail/api/send",
    handler: guarded(async (request, response) => {
      const body = await readJson(request);
      const result = await sendMail(settings, {
        to: body.to,
        cc: body.cc,
        subject: body.subject,
        text: body.text,
        html: body.html,
        attachments: body.attachments,
        dryRun: Boolean(body.dryRun),
      });
      json(response, 200, result);
    }),
  });

  webServer.register({
    kind: "exact",
    path: "/mail/api/attachment",
    handler: guarded(async (request, response) => {
      const body = await readJson(request);
      const result = await saveAttachments(settings, {
        mailbox: body.folder || settings.defaultMailbox,
        uid: Number(body.uid),
        index: body.index === undefined || body.index === null ? null : Number(body.index),
        dir: body.dir || settings.downloadDir,
      });
      json(response, 200, result);
    }),
  });

  /* 选附件：走 PowerShell 的原生文件对话框（同「技术评审」插件的选目录做法）。
     路径用 UTF-8 临时文件带回，避免 GBK 控制台把中文路径弄成乱码。 */
  webServer.register({
    kind: "exact",
    path: "/mail/api/pick-files",
    handler: guarded((request, response) => {
      const outFile = join(process.env.TEMP || process.env.TMP || ".", `dsh-mail-pick-${Date.now()}.json`);
      const run = (command, args) =>
        new Promise((resolveRun) => {
          execFile(command, args, { timeout: 180000, windowsHide: true }, (error, stdout) => {
            resolveRun({ error, stdout });
          });
        });
      run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PICK_SCRIPT, "-OutFile", outFile])
        .then(async (first) => {
          let text = "";
          try {
            const { readFileSync } = await import("node:fs");
            text = readFileSync(outFile, "utf8");
          } catch {
            text = first.stdout || "";
          }
          let paths = [];
          try {
            const parsed = JSON.parse(text || "[]");
            paths = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
          } catch {
            paths = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          }
          json(response, 200, { paths });
        })
        .catch((error) => json(response, 200, { paths: [], error: String(error?.message ?? error) }));
    }),
  });

  /* 客户端报错落盘：面板出问题时不用猜，直接看 lib/client-errors.log */
  webServer.register({
    kind: "exact",
    path: "/mail/api/clientlog",
    handler: guarded(async (request, response) => {
      const body = await readJson(request, 512 * 1024);
      try {
        mkdirSync(dirname(LOG_FILE), { recursive: true });
        appendFileSync(LOG_FILE, `${JSON.stringify({ ...body, at: body.at ?? new Date().toISOString() })}\n`, "utf8");
      } catch {
        /* 日志写不进去也不影响界面 */
      }
      json(response, 200, { ok: true });
    }),
  });
}

/* ------------------------------------------------------------------ apply */

export const inject = ["tools"];

export function apply(ctx, config) {
  const settings = normaliseSettings(config);
  const credential = describeCredential(settings);
  if (!credential.available) {
    ctx?.logger?.warn?.(`[dsh-netease-mail] 授权码不可用：${credential.reason}`);
  }

  /* 卸载/重载时把复用的 IMAP 连接关掉，别在宿主里留半死的 socket。 */
  try {
    if (typeof ctx?.on === "function") ctx.on("dispose", () => { closePool().catch(() => {}); });
  } catch {
    /* 清理尽力而为 */
  }

  if (typeof ctx?.inject !== "function") {
    ctx?.logger?.warn?.("[dsh-netease-mail] 这个宿主没有 ctx.inject，装不了工具");
    return;
  }

  ctx.inject(["tools"], (scoped) => {
    if (typeof scoped?.tools?.register !== "function") {
      scoped?.logger?.warn?.("[dsh-netease-mail] scoped 里没有 tools.register");
      return;
    }
    const register = (definition) => {
      const dispose = scoped.tools.register(definition);
      try {
        if (typeof dispose === "function" && typeof scoped.on === "function") scoped.on("dispose", dispose);
      } catch {
        /* 清理尽力而为 */
      }
    };
    try {
      defineTools(register, settings);
    } catch (error) {
      scoped?.logger?.warn?.(`[dsh-netease-mail] 注册工具失败：${error?.message ?? error}`);
    }
  });

  /* Web GUI 面板的数据面（侧栏「邮箱」那一页）。没有 webServer 的宿主跳过即可。 */
  try {
    ctx.inject(["webServer"], (scoped) => {
      if (typeof scoped?.webServer?.register !== "function") {
        scoped?.logger?.warn?.("[dsh-netease-mail] scoped 里没有 webServer.register，面板数据面没挂上");
        return;
      }
      try {
        defineRoutes(scoped.webServer, settings);
      } catch (error) {
        scoped?.logger?.warn?.(`[dsh-netease-mail] 注册面板路由失败：${error?.message ?? error}`);
      }
    });
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-netease-mail] 注入 webServer 失败：${error?.message ?? error}`);
  }
}