/**
 * 极简 IMAP4rev1 客户端（TLS，零依赖）。
 *
 * 只实现这个插件真正用到的命令：LOGIN / ID / LIST / SELECT / UID SEARCH /
 * UID FETCH / UID STORE / UID COPY / UID EXPUNGE / LOGOUT。
 *
 * 两个必须自己处理的协议细节：
 *  1. 服务器的字面量（`{123}\r\n` 后面跟 123 字节）会让「一行」被拆成多段，
 *     所以读取层是「逻辑行」而不是「物理行」；
 *  2. 中文邮箱名是 modified UTF-7（`&XfJT0ZAB-`），不转码就会看到乱码文件夹。
 */

import { connect as tlsConnect } from "node:tls";
import { decodeBytes } from "./mime.js";

const CRLF = "\r\n";

export class ImapError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ImapError";
    this.detail = detail;
  }
}

/* ------------------------------------------------------------ modified UTF-7 */

export function decodeMailboxName(name) {
  const text = String(name ?? "");
  if (!text.includes("&")) return text;
  return text.replace(/&([^-]*)-/g, (all, body) => {
    if (!body) return "&";
    try {
      let base64 = body.replace(/,/g, "/");
      while (base64.length % 4) base64 += "=";
      const bytes = Buffer.from(base64, "base64");
      return bytes.swap16().toString("utf16le");
    } catch {
      return all;
    }
  });
}

export function encodeMailboxName(name) {
  const text = String(name ?? "");
  if (!/[^\u0020-\u007e]/.test(text) && !text.includes("&")) return text;
  let out = "";
  let pending = "";
  const flush = () => {
    if (!pending) return;
    const buf = Buffer.from(pending, "utf16le");
    buf.swap16();
    out += "&" + buf.toString("base64").replace(/=$/, "").replace(/\//g, ",") + "-";
    pending = "";
  };
  for (const ch of text) {
    if (ch === "&") {
      flush();
      out += "&-";
    } else if (ch >= "\u0020" && ch <= "\u007e") {
      flush();
      out += ch;
    } else {
      pending += ch;
    }
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ 读取层 */

class WireReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0); // 已整理、待消费的字节
    this.pending = []; // 刚收到、还没拼进 buffer 的块
    this.pendingLength = 0;
    this.waiters = [];
    this.failure = null;
    socket.on("data", (chunk) => {
      // ★ 不在这里拼接：23 MB 的信按 64 KB 一块进来，每来一块拼一次整缓冲区
      // 就是 O(n²)，实测一封 23.22 MB 的信光「把字面量收齐」就要 142 秒。
      // 现在只排进队列，等真要用到这些字节时一次拼好。
      this.pending.push(chunk);
      this.pendingLength += chunk.length;
      this.#wake();
    });
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new ImapError("IMAP 连接已关闭")));
    socket.on("end", () => this.#fail(new ImapError("IMAP 连接被服务器断开")));
  }

  get length() {
    return this.buffer.length + this.pendingLength;
  }

  #absorb() {
    if (!this.pending.length) return;
    const parts = this.buffer.length ? [this.buffer, ...this.pending] : this.pending;
    this.buffer = Buffer.concat(parts);
    this.pending = [];
    this.pendingLength = 0;
  }

  #wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  #fail(error) {
    if (!this.failure) this.failure = error;
    this.#wake();
  }

  async #wait() {
    if (this.failure) throw this.failure;
    await new Promise((resolve) => this.waiters.push(resolve));
    if (this.failure) throw this.failure;
  }

  async readLine() {
    for (;;) {
      const index = this.buffer.indexOf(CRLF);
      if (index >= 0) {
        const line = this.buffer.subarray(0, index).toString("utf8");
        this.buffer = this.buffer.subarray(index + 2);
        return line;
      }
      if (this.pending.length) {
        this.#absorb();
        continue;
      }
      await this.#wait();
    }
  }

  async readBytes(size) {
    while (this.length < size) {
      if (this.failure) throw this.failure;
      await this.#wait();
    }
    if (this.buffer.length < size) this.#absorb();
    const chunk = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return chunk;
  }

  /** 读一条「逻辑行」：字面量被抽出来放进 literals，行里留占位符。 */
  async readLogicalLine() {
    let text = "";
    const literals = [];
    for (;;) {
      const line = await this.readLine();
      const match = /\{(\d+)\+?\}$/.exec(line);
      if (!match) {
        text += line;
        return { text, literals };
      }
      const size = Number(match[1]);
      text += `${line.slice(0, match.index)}\u0001${literals.length}\u0001`;
      literals.push(await this.readBytes(size));
    }
  }
}

/* --------------------------------------------------------------------- 客户端 */

export class ImapClient {
  constructor({ host, port = 993, timeoutMs = 30000, socketTimeoutMs = 60000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.socketTimeoutMs = socketTimeoutMs;
    this.socket = null;
    this.reader = null;
    this.tagSeq = 0;
    this.capabilities = [];
    this.state = "disconnected";
    this.selected = null;
  }

  #nextTag() {
    this.tagSeq += 1;
    return `A${String(this.tagSeq).padStart(4, "0")}`;
  }

  async connect() {
    if (this.socket) return this;
    await new Promise((resolve, reject) => {
      const socket = tlsConnect({
        host: this.host,
        port: this.port,
        servername: this.host,
        rejectUnauthorized: true,
        timeout: this.timeoutMs,
      });
      const fail = (error) => {
        socket.destroy();
        reject(error instanceof Error ? error : new ImapError(String(error)));
      };
      socket.once("secureConnect", () => {
        socket.setTimeout(0);
        socket.setNoDelay(true);
        resolve();
      });
      socket.once("error", fail);
      socket.once("timeout", () => fail(new ImapError(`连接 ${this.host}:${this.port} 超时`)));
      this.socket = socket;
    });
    this.socket.setTimeout(this.socketTimeoutMs, () => {
      this.socket?.destroy(new ImapError("IMAP 空闲超时"));
    });
    this.reader = new WireReader(this.socket);
    this.state = "connected";

    const greeting = await this.reader.readLine();
    if (!greeting.startsWith("* OK") && !greeting.startsWith("* PREAUTH")) {
      throw new ImapError(`IMAP 服务器问候异常：${greeting}`, greeting);
    }
    const capability = /\*\s+OK\s+\[CAPABILITY\s+([^\]]+)\]/i.exec(greeting);
    if (capability) this.capabilities = capability[1].trim().split(/\s+/);
    return this;
  }

  /**
   * 发一条命令并读到打标签的完成行。未打标签的行逐条回调给 onUntagged。
   * @returns {Promise<{status:string, text:string, lines:Array<{text:string,literals:Buffer[]}>}>}
   */
  async #run(command, { onUntagged } = {}) {
    if (!this.socket || !this.reader) throw new ImapError("IMAP 未连接");
    const tag = this.#nextTag();
    this.socket.write(`${tag} ${command}${CRLF}`);
    const lines = [];
    for (;;) {
      let item;
      try {
        item = await this.reader.readLogicalLine();
      } catch (error) {
        throw new ImapError(`IMAP 通信中断（${command}）：${error.message}`, error);
      }
      if (item.text.startsWith(`${tag} `)) {
        const rest = item.text.slice(tag.length + 1);
        const status = (rest.split(" ")[0] || "").toUpperCase();
        if (status === "OK") return { status, text: rest, lines };
        throw new ImapError(`IMAP 命令失败：${command} → ${rest}`, rest);
      }
      lines.push(item);
      if (onUntagged) onUntagged(item);
    }
  }

  /** 诊断用：原样发一条命令，返回未打标签行（排障时才用）。 */
  async rawCommand(command) {
    return this.#run(command);
  }

  async login(user, pass) {
    const quote = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    await this.#run(`LOGIN ${quote(user)} ${quote(pass)}`);
    this.state = "authenticated";
    try {
      const { lines } = await this.#run("CAPABILITY");
      const found = lines.find((line) => line.text.startsWith("* CAPABILITY"));
      if (found) this.capabilities = found.text.replace("* CAPABILITY", "").trim().split(/\s+/);
    } catch {
      /* 拿不到能力表不致命 */
    }
    // 网易邮箱要求登录后发一次 ID，否则部分账号后续命令会被判「不安全登录」
    try {
      await this.#run('ID ("name" "dsh-netease-mail" "version" "1.0" "vendor" "deepseek-harness")');
    } catch {
      /* 不支持 ID 的服务器会回 BAD，忽略 */
    }
    return this;
  }

  supports(capability) {
    const wanted = String(capability).toUpperCase();
    return this.capabilities.some((item) => item.toUpperCase() === wanted);
  }

  /** LIST "" "*" → [{ name, displayName, delimiter, attributes }] */
  async list() {
    const { lines } = await this.#run('LIST "" "*"');
    const out = [];
    for (const line of lines) {
      const match = /^\*\s+LIST\s+\(([^)]*)\)\s+("[^"]*"|NIL)\s+(.+)$/i.exec(line.text);
      if (!match) continue;
      let rawName = match[3].trim();
      const literal = /\u0001(\d+)\u0001/.exec(rawName);
      if (literal) rawName = decodeBytes(line.literals[Number(literal[1])] ?? Buffer.alloc(0), "utf-8");
      else rawName = rawName.replace(/^"|"$/g, "");
      out.push({
        name: decodeMailboxName(rawName),
        rawName,
        displayName: decodeMailboxName(rawName),
        delimiter: match[2] === "NIL" ? "/" : match[2].replace(/^"|"$/g, ""),
        attributes: match[1].trim().split(/\s+/).filter(Boolean),
      });
    }
    return out;
  }

  /** SELECT / EXAMINE，返回计数与 UID 有效期等状态。 */
  async select(mailbox, { readOnly = false } = {}) {
    const name = encodeMailboxName(mailbox);
    const { lines, text } = await this.#run(`${readOnly ? "EXAMINE" : "SELECT"} "${name.replace(/"/g, '\\"')}"`);
    const state = { mailbox, readOnly, exists: 0, recent: 0, unseen: 0, uidValidity: null, uidNext: null, flags: [] };
    for (const line of lines) {
      const exists = /^\*\s+(\d+)\s+EXISTS/i.exec(line.text);
      if (exists) state.exists = Number(exists[1]);
      const recent = /^\*\s+(\d+)\s+RECENT/i.exec(line.text);
      if (recent) state.recent = Number(recent[1]);
      const flags = /^\*\s+FLAGS\s+\(([^)]*)\)/i.exec(line.text);
      if (flags) state.flags = flags[1].trim().split(/\s+/).filter(Boolean);
      const unseen = /^\*\s+OK\s+\[UNSEEN\s+(\d+)\]/i.exec(line.text);
      if (unseen) state.unseen = Number(unseen[1]);
    }
    const validity = /\[UIDVALIDITY\s+(\d+)\]/i.exec(text);
    if (validity) state.uidValidity = Number(validity[1]);
    const next = /\[UIDNEXT\s+(\d+)\]/i.exec(text);
    if (next) state.uidNext = Number(next[1]);
    const permanentUnseen = /\[UNSEEN\s+(\d+)\]/i.exec(text);
    if (permanentUnseen) state.unseen = Number(permanentUnseen[1]);
    this.state = "selected";
    this.selected = mailbox;
    return state;
  }

  /** UID SEARCH，criteria 必须已经是 IMAP 语法（如 `UNSEEN SINCE 01-Nov-2026`）。 */
  async uidSearch(criteria) {
    const { lines } = await this.#run(`UID SEARCH ${criteria}`.trim());
    const uids = [];
    for (const line of lines) {
      const match = /^\*\s+SEARCH\b(.*)$/i.exec(line.text);
      if (!match) continue;
      for (const token of match[1].trim().split(/\s+/)) if (token) uids.push(Number(token));
    }
    return uids.filter((uid) => Number.isFinite(uid));
  }

  /** 批量取头部（含 UID/FLAGS/INTERNALDATE/SIZE）。 */
  async fetchHeaders(uids, { fields = "FROM TO CC SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING" } = {}) {
    const out = [];
    for (const batch of chunk(uids, 40)) {
      const { lines } = await this.#run(`UID FETCH ${batch.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (${fields})])`);
      for (const item of lines) out.push(parseFetch(item));
    }
    return out.filter((entry) => entry.uid);
  }

  /** 取整封原文（BODY.PEEK[]，不改变已读状态）。 */
  async fetchRaw(uid) {
    const { lines } = await this.#run(`UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])`);
    const parsed = lines.map(parseFetch).find((entry) => entry.uid && entry.body);
    if (!parsed) throw new ImapError(`取不到 uid=${uid} 的邮件正文`);
    return parsed;
  }

  /**
   * 只取「轮廓」：大小 + BODYSTRUCTURE + 头部字段，**不下载正文与附件**。
   * 大信只想要正文时先要这个，再按部件号取需要的部件。
   */
  async fetchOutline(uid, { fields = "FROM TO CC SUBJECT DATE MESSAGE-ID" } = {}) {
    const { lines } = await this.#run(`UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (${fields})])`);
    const item = lines.find((entry) => /\bUID (\d+)/.test(entry.text) && Number(/\bUID (\d+)/.exec(entry.text)[1]) === Number(uid));
    if (!item) throw new ImapError(`取不到 uid=${uid} 的邮件轮廓`);
    const parsed = parseFetch(item);
    return {
      uid: parsed.uid,
      size: parsed.size,
      flags: parsed.flags,
      internalDate: parsed.internalDate,
      headers: parsed.body,
      structure: extractBodyStructure(item.text),
    };
  }

  /** 按部件号取指定部件的内容（BODY.PEEK[<part>]，不动已读状态）。 */
  async fetchParts(uid, paths) {
    const out = new Map();
    const list = (paths ?? []).filter(Boolean).map(String);
    if (!list.length) return out;
    const specs = list.map((path) => `BODY.PEEK[${path}]`).join(" ");
    const { lines } = await this.#run(`UID FETCH ${uid} (UID ${specs})`);
    for (const item of lines) {
      const pattern = /BODY\[([^\]]*)\]\s*\u0001(\d+)\u0001/g;
      let match;
      while ((match = pattern.exec(item.text))) {
        out.set(match[1], item.literals[Number(match[2])] ?? Buffer.alloc(0));
      }
    }
    return out;
  }

  /** mode: '+' 加 / '-' 去 / '' 覆盖。flag 形如 `\\Seen`。 */
  async storeFlags(uids, flag, { mode = "+", silent = true } = {}) {
    for (const batch of chunk(uids, 40)) {
      await this.#run(`UID STORE ${batch.join(",")} ${mode}FLAGS${silent ? ".SILENT" : ""} (${flag})`);
    }
  }

  async copy(uids, mailbox) {
    const name = encodeMailboxName(mailbox).replace(/"/g, '\\"');
    for (const batch of chunk(uids, 40)) await this.#run(`UID COPY ${batch.join(",")} "${name}"`);
  }

  /** 只删已打 \Deleted 且属于给定 uid 集合的邮件（需要 UIDPLUS）。 */
  async uidExpunge(uids) {
    if (!this.supports("UIDPLUS")) return false;
    for (const batch of chunk(uids, 40)) await this.#run(`UID EXPUNGE ${batch.join(",")}`);
    return true;
  }

  async expunge() {
    await this.#run("EXPUNGE");
  }

  async noop() {
    await this.#run("NOOP");
  }

  async logout() {
    try {
      if (this.socket && !this.socket.destroyed) await this.#run("LOGOUT");
    } catch {
      /* 关连接时出错不算错 */
    }
    this.close();
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {
      /* 忽略 */
    }
    this.socket = null;
    this.reader = null;
    this.state = "disconnected";
    this.selected = null;
  }
}

/* ------------------------------------------------------------------- 小工具 */

/**
 * 从一条 FETCH 响应里抠出 BODYSTRUCTURE 那一段 S 表达式（含最外层括号）。
 * 括号匹配要跳过引号里的字符，不然主题里一个括号就能把它带偏。
 */
function extractBodyStructure(text) {
  const at = String(text ?? "").indexOf("BODYSTRUCTURE (");
  if (at < 0) return "";
  const start = at + "BODYSTRUCTURE ".length;
  let depth = 0;
  let inQuote = false;
  for (let index = start; index < text.length; index++) {
    const ch = text[index];
    if (inQuote) {
      if (ch === "\\") index++;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return "";
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 把一条 FETCH 响应行拆成字段。只认这里需要的字段，
 * 用正则逐个抠，比写完整解析器稳。
 */
function parseFetch(item) {
  const text = item.text;
  const uid = Number(/\bUID (\d+)/.exec(text)?.[1] ?? 0);
  if (!uid) return { uid: 0 };
  const flags = (/\bFLAGS \(([^)]*)\)/.exec(text)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const internalDate = /\bINTERNALDATE "([^"]*)"/.exec(text)?.[1] ?? "";
  const size = Number(/\bRFC822\.SIZE (\d+)/.exec(text)?.[1] ?? 0);
  const body = item.literals.length ? item.literals[item.literals.length - 1] : null;
  // BODYSTRUCTURE 里出现 "attachment" 或带文件名的部件，就当有附件（够用的启发式）
  const hasAttachment = /"attachment"|"filename"|"name"\s+"[^"]+"/i.test(text);
  return { uid, flags, internalDate, size, body, hasAttachment };
}