/**
 * 高层邮箱操作。
 *
 * 连接策略（2026-11-19 改）：**养一条复用连接**，不再「一次调用一次登录」。
 * 为什么改：面板上每点一下（开一封、标已读、存附件）都免不了登录一次，
 * TLS + AUTH 一趟 0.5~0.65 秒，点十下就是五六秒的纯等待 —— 那不是网易慢，是人家自己慢。
 * 现在：同一条连接串行复用（IMAP 单连接不能并发，所以排队），闲置 `poolIdleMs` 后自动关掉；
 * 连接层面出错（断线/超时/掉认证）就丢掉重连一次，业务错误（参数不对之类）不重试。
 * `withSession(settings, fn, { fresh: true })` 可强制走一次性连接（自检、排障用）。
 */

const poolIdleMs = 120000;
const pools = new Map();

function poolKey(settings) {
  return `${settings.imapHost}:${settings.imapPort}|${settings.account}`;
}

function looksLikeConnectionTrouble(error) {
  const text = String(error?.message ?? error ?? "");
  return /中断|超时|未连接|断开|socket|hang up|ECONNRESET|EPIPE|BYE|Not authenticated|LOGOUT/i.test(text);
}

/** 关掉所有复用的连接（插件卸载时调用，别在宿主里留半死的 socket）。 */
export async function closePool() {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.client) await entry.client.logout().catch(() => entry.client?.close?.());
      entry.client = null;
    }),
  );
}

function scheduleIdleClose(entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const client = entry.client;
    entry.client = null;
    entry.timer = null;
    client?.logout?.().catch(() => client?.close?.());
  }, poolIdleMs);
  entry.timer.unref?.();
}

async function withSession(settings, fn, options = {}) {
  if (options.fresh) {
    const { client, credentialSource } = await openSession(settings);
    try {
      return await fn(client, credentialSource);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  const key = poolKey(settings);
  let entry = pools.get(key);
  if (!entry) {
    entry = { client: null, credentialSource: "", chain: Promise.resolve(), timer: null };
    pools.set(key, entry);
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  // IMAP 一条连接同时只能跑一条命令，所以同一个池里的调用必须排队。
  const run = entry.chain.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let session = null;
      try {
        if (entry.client) session = { client: entry.client, credentialSource: entry.credentialSource };
        else {
          session = await openSession(settings);
          entry.client = session.client;
          entry.credentialSource = session.credentialSource;
        }
        const result = await fn(session.client, session.credentialSource);
        scheduleIdleClose(entry);
        return result;
      } catch (error) {
        // 这条连接可能是「看着活着、其实被服务器掐了」——丢掉重连一次再说。
        const client = entry.client;
        entry.client = null;
        if (client) await client.logout().catch(() => client.close());
        if (attempt === 1 || !looksLikeConnectionTrouble(error)) throw error;
      }
    }
    throw new Error("IMAP 复用连接连试两次都没成");
  });

  entry.chain = run.catch(() => {});
  return run;
}

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ImapClient } from "./imap.js";
import { sendMessage } from "./smtp.js";
import {
  buildMessage,
  decodeBytes,
  decodeTransfer,
  headerValue,
  htmlToText,
  parseBodyStructure,
  parseHeaders,
  parseMessage,
  structureParts,
} from "./mime.js";
import { resolveAuthCode } from "./settings.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_INDEX = new Map(MONTH_NAMES.map((name, index) => [name.toLowerCase(), index]));

const MIME_BY_EXT = new Map([
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".xml", "application/xml"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
  [".rar", "application/vnd.rar"],
  [".7z", "application/x-7z-compressed"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".dwg", "application/acad"],
  [".dxf", "image/vnd.dxf"],
]);

export function guessContentType(path) {
  return MIME_BY_EXT.get(extname(String(path)).toLowerCase()) ?? "application/octet-stream";
}

/* ------------------------------------------------------------------ 连接 */

export async function openSession(settings) {
  if (!settings.account) {
    throw new Error(
      "还没配邮箱账号呢。请在插件目录的 local-settings.json 里（或插件 config 里）填 account，"
        + "例如 {\"account\":\"you@yourcompany.com\",\"authCodeFile\":\"D:\\\\secret\\\\authcode.txt\"}。",
    );
  }
  const { code, source } = resolveAuthCode(settings);
  const client = new ImapClient({
    host: settings.imapHost,
    port: settings.imapPort,
    timeoutMs: settings.timeoutMs,
    socketTimeoutMs: Math.max(settings.timeoutMs, 45000),
  });
  await client.connect();
  try {
    await client.login(settings.account, code);
  } catch (error) {
    client.close();
    throw new Error(`IMAP 登录失败（账号 ${settings.account}，授权码来自${source}）：${error.message}`);
  }
  return { client, credentialSource: source };
}



/* -------------------------------------------------------------- 日期工具 */

export function toImapDate(date) {
  const value = date instanceof Date ? date : new Date(date);
  return `${String(value.getDate()).padStart(2, "0")}-${MONTH_NAMES[value.getMonth()]}-${value.getFullYear()}`;
}

export function parseInternalDate(text) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const month = MONTH_INDEX.get(match[2].toLowerCase());
  if (month === undefined) return null;
  const [, day, , year, hour, minute, second, sign, offHour, offMinute] = match;
  const utc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second));
  const offset = (sign === "-" ? -1 : 1) * (Number(offHour) * 60 + Number(offMinute)) * 60000;
  return new Date(utc - offset);
}

export function formatLocal(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function relative(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const delta = Date.now() - date.getTime();
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatLocal(date);
}

function parseHeaderDate(value, fallbackText) {
  const raw = String(value ?? "").trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return parseInternalDate(fallbackText);
}

function splitAddress(value) {
  const raw = String(value ?? "").trim();
  const match = /^(.*)<([^>]+)>\s*$/.exec(raw);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ""), address: match[2].trim() };
  }
  return { name: "", address: raw };
}

export function formatAddress(value) {
  const { name, address } = splitAddress(value);
  if (name && address) return `${name} <${address}>`;
  return address || name || "(未知)";
}

/* ---------------------------------------------------------- 文件夹与自检 */

const SKIP_SELECT = new Set(["\\noselect", "\\nonexistent"]);

export async function listFolders(settings, { withCounts = true, exactCounts = false, client: provided, credentialSource } = {}) {
  const run = async (client) => {
    const folders = await client.list();
    const rows = [];
    for (const folder of folders) {
      const row = { name: folder.name, delimiter: folder.delimiter, attributes: folder.attributes, selectable: true };
      if (folder.attributes.some((attr) => SKIP_SELECT.has(attr.toLowerCase()))) {
        row.selectable = false;
        rows.push(row);
        continue;
      }
      if (withCounts) {
        try {
          const state = await client.select(folder.name, { readOnly: true });
          row.messages = state.exists;
          row.unseen = state.unseen;
          row.serverMessages = state.exists;
          // ★ 网易的 SELECT EXISTS 会撒谎（同一次会话里 INBOX 报过 2552 / 146），
          //   面板上的计数要准，所以按需改用 UID SEARCH ALL 实数。
          if (exactCounts) {
            try {
              const uids = await client.uidSearch("ALL");
              row.messages = uids.length;
            } catch {
              /* 检索失败就退回 SELECT 的计数 */
            }
          }
        } catch (error) {
          row.selectable = false;
          row.error = error.message;
        }
      }
      rows.push(row);
    }
    return rows;
  };
  if (provided) return run(provided);
  return withSession(settings, (client) => run(client));
}

export async function checkConnection(settings) {
  const started = Date.now();
  return withSession(settings, async (client, credentialSource) => {
    const folders = [];
    const listed = await client.list();
    for (const folder of listed) {
      if (folder.attributes.some((attr) => SKIP_SELECT.has(attr.toLowerCase()))) continue;
      try {
        const state = await client.select(folder.name, { readOnly: true });
        folders.push({ name: folder.name, messages: state.exists, unseen: state.unseen });
      } catch {
        /* 有些系统文件夹不可选，跳过 */
      }
    }
    return {
      ok: true,
      account: settings.account,
      imap: `${settings.imapHost}:${settings.imapPort}`,
      smtp: `${settings.smtpHost}:${settings.smtpPort}`,
      credentialSource,
      capabilities: client.capabilities,
      folders,
      elapsedMs: Date.now() - started,
    };
  });
}

/* ------------------------------------------------------------------ 列表 */

export async function listMessages(settings, options = {}) {
  const mailbox = options.mailbox || settings.defaultMailbox;
  const limit = Math.min(Math.max(Number(options.limit) || settings.pageSize, 1), settings.maxPageSize);
  const sinceDays = Number(options.sinceDays) || 0;

  return withSession(settings, async (client) => {
    const state = await client.select(mailbox, { readOnly: true });
    const criteria = [];
    if (options.unreadOnly) criteria.push("UNSEEN");
    if (sinceDays > 0) criteria.push(`SINCE ${toImapDate(new Date(Date.now() - sinceDays * 86400000))}`);
    const uids = await client.uidSearch(criteria.length ? criteria.join(" ") : "ALL");
    let ordered = [...uids].sort((a, b) => b - a);
    // 分页用：只要比 beforeUid 更早（uid 更小）的那批，供界面「加载更多」翻页。
    const beforeUid = Number(options.beforeUid) || 0;
    if (beforeUid > 0) ordered = ordered.filter((uid) => uid < beforeUid);
    const picked = ordered.slice(0, limit);
    const fetched = picked.length ? await client.fetchHeaders(picked) : [];
    const byUid = new Map(fetched.map((entry) => [entry.uid, entry]));
    const messages = [];
    for (const uid of picked) {
      const entry = byUid.get(uid);
      if (!entry) continue;
      const headers = parseHeaders(entry.body ?? Buffer.alloc(0));
      const date = parseHeaderDate(headerValue(headers, "date"), entry.internalDate);
      messages.push({
        uid,
        subject: headerValue(headers, "subject") || "(无主题)",
        from: formatAddress(headerValue(headers, "from")),
        fromAddress: splitAddress(headerValue(headers, "from")).address,
        date: formatLocal(date),
        ago: relative(date),
        size: entry.size,
        unread: !entry.flags.includes("\\Seen"),
        flagged: entry.flags.includes("\\Flagged"),
        hasAttachments: entry.hasAttachment,
      });
    }
    const unreadMatched = messages.filter((item) => item.unread).length;
    // 网易的 SELECT 有时报一个大得离谱的 EXISTS（首次连接见过 2552 vs 实际 146）。
    // 无筛选条件时以 UID 检索结果为准，服务器那次数字只留作对照。
    const totalBySearch = criteria.length === 0 ? ordered.length : null;
    return {
      mailbox,
      exists: totalBySearch ?? state.exists,
      serverExists: state.exists,
      unseenInBox: state.unseen,
      matched: ordered.length,
      shown: messages.length,
      unreadInPage: unreadMatched,
      messages,
    };
  });
}

/* -------------------------------------------------------------------- 读信 */

/**
 * 超过这个大小就只按部件取正文，不下载附件。
 * 512 KB 是实测定的：这个尺寸以下的信整封拉下来不到 0.3 秒，
 * 犯不着为它冒「结构解析和整封解析对不齐」的风险；
 * 而 1.58 MB 那封整封取要 2.5 秒、23.22 MB 那封要 37.5 秒，全耗在附件上。
 */
const LARGE_MESSAGE_BYTES = 512 * 1024;

/**
 * 最近读过的信缓存两分钟（最多 24 封）。
 * 面板上左点右点、来回对照同一封信是常态，重复解一遍纯属浪费；
 * 缓存只放**解析结果**（正文与附件清单），不放附件内容，所以体积很小。
 */
const MESSAGE_CACHE_TTL_MS = 120000;
const MESSAGE_CACHE_MAX = 24;
const messageCache = new Map();

function cacheGet(key) {
  const entry = messageCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    messageCache.delete(key);
    return null;
  }
  messageCache.delete(key);
  messageCache.set(key, entry); // 移到队尾 = 最近用过
  return entry.value;
}

function cacheSet(key, value) {
  messageCache.set(key, { expires: Date.now() + MESSAGE_CACHE_TTL_MS, value });
  while (messageCache.size > MESSAGE_CACHE_MAX) messageCache.delete(messageCache.keys().next().value);
}

function shapeMessage(value, bodyLimit, markRead) {
  const full = value.fullText ?? "";
  const truncated = full.length > bodyLimit;
  const { fullText, ...rest } = value;
  return {
    ...rest,
    text: truncated ? full.slice(0, bodyLimit) : full,
    truncated,
    totalChars: full.length,
    markedRead: markRead,
  };
}

export async function readMessage(settings, options = {}) {
  const mailbox = options.mailbox || settings.defaultMailbox;
  const uid = Number(options.uid);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("mail_read 需要有效的 uid（先 mail_list 或 mail_search 拿到 uid）");
  const markRead = options.markRead !== false;
  const bodyLimit = Math.min(Math.max(Number(options.bodyChars) || settings.bodyChars, 200), 60000);
  const cacheKey = `${mailbox}\u0000${uid}`;

  const cached = cacheGet(cacheKey);
  if (cached) {
    if (markRead) {
      await withSession(settings, async (client) => {
        await client.select(mailbox, { readOnly: false });
        await client.storeFlags([uid], "\\Seen", { mode: "+" }).catch(() => {});
      }).catch(() => {});
    }
    return shapeMessage({ ...cached, fromCache: true }, bodyLimit, markRead);
  }

  const value = await withSession(settings, async (client) => {
    await client.select(mailbox, { readOnly: !markRead });

    const outline = await client.fetchOutline(uid);
    const size = Number(outline.size) || 0;
    const structure = parseBodyStructure(outline.structure);
    const info = structure ? structureParts(structure) : { texts: [], attachments: [] };

    let headers;
    let text = "";
    let html = "";
    let attachments;
    let bodySource = "整封";

    if (size > LARGE_MESSAGE_BYTES && info.texts.length) {
      bodySource = `按部件（${size > 1048576 ? (size / 1048576).toFixed(2) + " MB" : Math.round(size / 1024) + " KB"} 的信，附件没下载）`;
      headers = parseHeaders(outline.headers ?? Buffer.alloc(0));
      const parts = await client.fetchParts(uid, info.texts.map((part) => part.path));
      for (const part of info.texts) {
        const rawPart = parts.get(part.path);
        if (!rawPart?.length) continue;
        const decoded = decodeTransfer(rawPart, part.encoding);
        const body = decodeBytes(decoded, part.charset);
        if (part.subtype === "html") {
          if (!html) html = body;
        } else if (!text) {
          text = body;
        }
      }
      if (!text && html) text = htmlToText(html);
      attachments = info.attachments.map((file, index) => ({
        index,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        embedded: Boolean(file.embedded),
        sizeIsEstimate: true,
      }));
    } else {
      const entry = await client.fetchRaw(uid);
      const parsed = parseMessage(entry.body ?? Buffer.alloc(0));
      headers = parsed.headers;
      text = parsed.text || "";
      html = parsed.html || "";
      attachments = parsed.attachments.map((file, index) => ({
        index,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        embedded: Boolean(file.embedded),
      }));
    }

    const body = (text || "").trim();
    if (markRead) {
      await client.storeFlags([uid], "\\Seen", { mode: "+" }).catch(() => {});
    }
    return {
      mailbox,
      uid,
      size,
      subject: headerValue(headers, "subject") || "(无主题)",
      from: formatAddress(headerValue(headers, "from")),
      to: formatAddress(headerValue(headers, "to")),
      cc: headerValue(headers, "cc") ? formatAddress(headerValue(headers, "cc")) : "",
      date: formatLocal(parseHeaderDate(headerValue(headers, "date"), outline.internalDate)),
      messageId: headerValue(headers, "message-id"),
      fullText: body,
      hasHtml: Boolean(html),
      bodySource,
      attachments,
    };
  });

  cacheSet(cacheKey, value);
  return shapeMessage(value, bodyLimit, markRead);
}

/* ------------------------------------------------------------------ 搜索 */

function quoteImap(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const isAscii = (value) => !/[^\u0000-\u007f]/.test(String(value ?? ""));

/** 取第一个有限的数字（NaN / 空 / 非数字都退到下一个），全不行才用兜底。 */
function finiteOr(...candidates) {
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/* 搜索缓存：同一句搜索连着按几遍是常态（面板里来回试关键词），
   中文关键词又必须在本地过滤一遍全部信头，一次三四秒。缓存 20 秒，够挡掉重复。 */
const SEARCH_CACHE_TTL_MS = 20000;
const searchCache = new Map();

export async function searchMessages(settings, options = {}) {
  const key = JSON.stringify([
    options.mailbox ?? settings.defaultMailbox,
    options.keyword ?? "",
    options.query ?? "",
    options.from ?? "",
    options.subject ?? "",
    Number(options.limit) || settings.pageSize,
    Number(options.bodyScan ?? Math.nan),
  ]);
  const cached = searchCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return { ...cached.value, fromCache: true };
  }
  const value = await searchMessagesUncached(settings, options);
  searchCache.set(key, { expires: Date.now() + SEARCH_CACHE_TTL_MS, value });
  if (searchCache.size > 20) searchCache.delete(searchCache.keys().next().value);
  return value;
}

async function searchMessagesUncached(settings, options = {}) {
  const mailbox = options.mailbox || settings.defaultMailbox;
  const limit = Math.min(Math.max(Number(options.limit) || settings.pageSize, 1), settings.maxPageSize);
  const scan = Math.min(Math.max(Number(options.scanLimit) || settings.scanLimit, 10), 3000);
  const keywords = [options.keyword, options.query].filter(Boolean).map(String);
  const from = options.from ? String(options.from) : "";
  const subjectFilter = options.subject ? String(options.subject) : "";
  const bodyScan = Math.min(Math.max(finiteOr(options.bodyScan, settings.bodyScan, 0), 0), 80);
  const bodyScanMaxBytes = finiteOr(options.bodyScanMaxBytes, settings.bodyScanMaxBytes, 0) || 3000000;
  const bodyBudgetMs = finiteOr(options.bodyBudgetMs, settings.bodyBudgetMs, 0) || 8000;
  const startedAt = Date.now();

  return withSession(settings, async (client) => {
    const state = await client.select(mailbox, { readOnly: true });
    const criteria = [];
    if (options.unreadOnly) criteria.push("UNSEEN");
    if (options.flaggedOnly) criteria.push("FLAGGED");
    if (options.sinceDays > 0) criteria.push(`SINCE ${toImapDate(new Date(Date.now() - Number(options.sinceDays) * 86400000))}`);
    if (options.beforeDays > 0) criteria.push(`BEFORE ${toImapDate(new Date(Date.now() - Number(options.beforeDays) * 86400000))}`);
    if (from && isAscii(from)) criteria.push(`FROM ${quoteImap(from)}`);
    if (subjectFilter && isAscii(subjectFilter)) criteria.push(`SUBJECT ${quoteImap(subjectFilter)}`);
    for (const keyword of keywords) {
      if (isAscii(keyword) && keyword.length >= 2) criteria.push(`TEXT ${quoteImap(keyword)}`);
    }

    let uids = await client.uidSearch(criteria.length ? criteria.join(" ") : "ALL");
    uids.sort((a, b) => b - a);
    const candidates = uids.slice(0, scan);
    const fetched = candidates.length ? await client.fetchHeaders(candidates) : [];
    const byUid = new Map(fetched.map((entry) => [entry.uid, entry]));

    const lowerNeedles = [...keywords, from, subjectFilter].filter(Boolean).map((item) => item.toLowerCase());
    const matched = [];
    for (const uid of candidates) {
      const entry = byUid.get(uid);
      if (!entry) continue;
      const headers = parseHeaders(entry.body ?? Buffer.alloc(0));
      const decodedSubject = headerValue(headers, "subject") || "";
      const decodedFrom = headerValue(headers, "from") || "";
      const haystack = `${decodedSubject}\n${decodedFrom}`.toLowerCase();
      const headerHit = lowerNeedles.length === 0 || lowerNeedles.some((needle) => haystack.includes(needle));
      const date = parseHeaderDate(headerValue(headers, "date"), entry.internalDate);
      matched.push({
        uid,
        entry,
        headers,
        subject: decodedSubject || "(无主题)",
        from: formatAddress(decodedFrom),
        date,
        headerHit,
        bodyHit: false,
      });
    }

    // 头里找不到的，再去正文里找。正文回捞是最贵的一步，所以三重闸：
    //   ① 只挑前 bodyScan 封；② 单封超过 bodyScanMaxBytes 不拉（一封信 23 MB 会把整次搜索拖死）；
    //   ③ 总共只用 bodyBudgetMs，超了就不再找，并在结果里如实说明「没找完」。
    let bodyScanned = 0;
    let skippedLarge = 0;
    let stoppedByBudget = false;
    let skippedByBudget = 0;
    if (bodyScan > 0 && lowerNeedles.length > 0) {
      const pending = matched.filter((item) => !item.headerHit);
      const picked = [];
      for (const item of pending) {
        if (picked.length >= bodyScan) {
          skippedByBudget = pending.length - picked.length;
          break;
        }
        if ((item.entry.size ?? 0) > bodyScanMaxBytes) {
          skippedLarge += 1;
          continue;
        }
        picked.push(item);
      }
      for (const item of picked) {
        if (Date.now() - startedAt > bodyBudgetMs) {
          stoppedByBudget = true;
          skippedByBudget += picked.length - bodyScanned;
          break;
        }
        try {
          const raw = await client.fetchRaw(item.uid);
          const parsed = parseMessage(raw.body ?? Buffer.alloc(0));
          const haystack = `${parsed.text}\n${parsed.html}`.toLowerCase();
          item.bodyHit = lowerNeedles.some((needle) => haystack.includes(needle));
          item.snippet = (parsed.text || "").replace(/\s+/g, " ").slice(0, 200);
          bodyScanned += 1;
        } catch {
          /* 单封取不到就跳过，不拖垮整次搜索 */
        }
      }
    }

    const hits = matched.filter((item) => item.headerHit || item.bodyHit);
    const messages = hits.slice(0, limit).map((item) => {
      const date = item.date;
      return {
        uid: item.uid,
        subject: item.subject,
        from: item.from,
        date: formatLocal(date),
        ago: relative(date),
        size: item.entry.size,
        unread: !item.entry.flags.includes("\\Seen"),
        hasAttachments: item.entry.hasAttachment,
        snippet: item.snippet,
      };
    });

    return {
      mailbox,
      exists: state.exists,
      scanned: candidates.length,
      matched: hits.length,
      shown: messages.length,
      criteria: criteria.join(" ") || "ALL",
      bodyScanned,
      bodySkippedLarge: skippedLarge,
      bodySkippedBudget: skippedByBudget,
      bodyStoppedByBudget: stoppedByBudget,
      elapsedMs: Date.now() - startedAt,
      messages,
    };
  });
}

/* -------------------------------------------------------------------- 发信 */

export async function sendMail(settings, input = {}) {
  const to = toList(input.to);
  const cc = toList(input.cc);
  const bcc = toList(input.bcc);
  if (!to.length && !cc.length && !bcc.length) throw new Error("mail_send 需要至少一个收件人（to / cc / bcc）");
  const subject = String(input.subject ?? "").trim();
  const text = String(input.text ?? input.body ?? "");
  const html = String(input.html ?? "");
  if (!text && !html) throw new Error("mail_send 需要正文（text 或 html）");

  const attachments = [];
  for (const path of toList(input.attachments)) {
    const info = statSync(path);
    if (!info.isFile()) throw new Error(`附件不是文件：${path}`);
    attachments.push({ filename: basename(path), contentType: guessContentType(path), content: readFileSync(path) });
  }

  const from = settings.account;
  const { raw, messageId } = buildMessage({
    from,
    fromName: settings.displayName,
    to,
    cc,
    subject,
    text,
    html,
    attachments,
  });

  const recipients = [...to, ...cc, ...bcc];
  const result = await sendMessage({
    host: settings.smtpHost,
    port: settings.smtpPort,
    user: from,
    pass: resolveAuthCode(settings).code,
    from,
    recipients,
    raw,
    timeoutMs: Math.max(settings.timeoutMs, 45000),
    dryRun: Boolean(input.dryRun),
  });

  return {
    from,
    to,
    cc,
    bcc,
    subject,
    messageId,
    bytes: raw.length,
    attachments: attachments.map((file) => ({ filename: file.filename, size: file.content.length })),
    ...result,
  };
}

function toList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value)
    .split(/[,;，；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ 附件 */

function safeFilename(name, fallback) {
  const base = basename(String(name || "").replace(/[\\/:*?"<>|]/g, "_")).trim();
  return base || fallback;
}

export async function saveAttachments(settings, options = {}) {
  const mailbox = options.mailbox || settings.defaultMailbox;
  const uid = Number(options.uid);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("需要有效的 uid");
  const dir = options.dir ? String(options.dir) : settings.downloadDir;
  const wanted = options.index === undefined || options.index === null ? null : Number(options.index);

  return withSession(settings, async (client) => {
    await client.select(mailbox, { readOnly: true });

    /* 大信按部件取：一封 23 MB 的信要存它 13 MB 的 dwg，
       整封下载实测 21 秒（旧读取器 142 秒），只取那一个部件是零点几秒。 */
    const outline = await client.fetchOutline(uid);
    const size = Number(outline.size) || 0;
    const structure = parseBodyStructure(outline.structure);
    const info = structure ? structureParts(structure) : { texts: [], attachments: [] };
    if (size > LARGE_MESSAGE_BYTES && info.attachments.length) {
      const selected = wanted === null ? info.attachments : [info.attachments[wanted]].filter(Boolean);
      if (!selected.length) throw new Error(`附件序号 ${wanted} 不存在（这封邮件共 ${info.attachments.length} 个附件）`);
      const parts = await client.fetchParts(uid, selected.map((file) => file.path));
      mkdirSync(dir, { recursive: true });
      const saved = [];
      for (const file of selected) {
        const rawPart = parts.get(file.path) ?? Buffer.alloc(0);
        const content = decodeTransfer(rawPart, file.encoding);
        const name = safeFilename(file.filename, `attachment-${saved.length + 1}`);
        const target = join(dir, name);
        writeFileSync(target, content);
        saved.push({ path: target, filename: name, size: content.length, contentType: file.contentType });
      }
      return { saved, total: info.attachments.length, dir, source: "按部件取" };
    }

    const entry = await client.fetchRaw(uid);
    const parsed = parseMessage(entry.body ?? Buffer.alloc(0));
    if (!parsed.attachments.length) return { saved: [], total: 0, dir, note: "这封邮件没有附件" };
    const selected = wanted === null ? parsed.attachments : [parsed.attachments[wanted]].filter(Boolean);
    if (!selected.length) throw new Error(`附件序号 ${wanted} 不存在（这封邮件共 ${parsed.attachments.length} 个附件）`);
    mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const file of selected) {
      const name = safeFilename(file.filename, `attachment-${saved.length + 1}`);
      const target = join(dir, name);
      writeFileSync(target, file.content);
      saved.push({ path: target, filename: name, size: file.content.length, contentType: file.contentType });
    }
    return { saved, total: parsed.attachments.length, dir };
  });
}

/* -------------------------------------------------------- 标记 / 移动 / 删 */

export async function updateMessages(settings, options = {}) {
  const mailbox = options.mailbox || settings.defaultMailbox;
  const uids = (Array.isArray(options.uids) ? options.uids : [options.uid]).map(Number).filter((uid) => uid > 0);
  if (!uids.length) throw new Error("需要至少一个有效 uid");
  const action = String(options.action ?? "").toLowerCase();
  if (!action) throw new Error("需要 action：read | unread | flag | unflag | delete | move");

  return withSession(settings, async (client) => {
    await client.select(mailbox, { readOnly: false });
    const done = { mailbox, uids, action };

    if (action === "read" || action === "seen") {
      await client.storeFlags(uids, "\\Seen", { mode: "+" });
      return { ...done, note: `已把 ${uids.length} 封标记为已读` };
    }
    if (action === "unread" || action === "unseen") {
      await client.storeFlags(uids, "\\Seen", { mode: "-" });
      return { ...done, note: `已把 ${uids.length} 封标记为未读` };
    }
    if (action === "flag" || action === "star") {
      await client.storeFlags(uids, "\\Flagged", { mode: "+" });
      return { ...done, note: `已给 ${uids.length} 封加星标` };
    }
    if (action === "unflag" || action === "unstar") {
      await client.storeFlags(uids, "\\Flagged", { mode: "-" });
      return { ...done, note: `已取消 ${uids.length} 封的星标` };
    }
    if (action === "move") {
      const target = String(options.target ?? "").trim();
      if (!target) throw new Error("move 需要 target（目标文件夹名，如 \"已发送\" 或 INBOX/Trash）");
      await client.copy(uids, target);
      await client.storeFlags(uids, "\\Deleted", { mode: "+" });
      const expunged = await client.uidExpunge(uids);
      if (!expunged) await client.expunge().catch(() => {});
      return { ...done, target, note: `已把 ${uids.length} 封移动到「${target}」` };
    }
    if (action === "delete") {
      await client.storeFlags(uids, "\\Deleted", { mode: "+" });
      const expunged = await client.uidExpunge(uids);
      if (!expunged) await client.expunge().catch(() => {});
      return { ...done, note: `已删除 ${uids.length} 封（进了垃圾箱/已彻底删除，取决于服务器设置）` };
    }
    throw new Error(`不认识的 action：${action}`);
  });
}