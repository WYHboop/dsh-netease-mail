/**
 * MIME 编解码（零依赖）：RFC 2047 编码字、RFC 2231 参数、multipart 拆分、
 * quoted-printable / base64 正文解码、字符集回退、HTML → 纯文本、以及发信体的拼装。
 *
 * 中文邮件现实情况：GBK / GB2312 / GB18030 巨多，且常带 `filename="=?GBK?B?...?="`
 * 这种非标准写法，所以这里对字体的处理一律走「先按声明、不行再退」的策略。
 */

const CRLF = "\r\n";

/* ------------------------------------------------------------------ 字符集 */

const CHARSET_ALIAS = new Map([
  ["utf8", "utf-8"],
  ["utf-8", "utf-8"],
  ["gb2312", "gbk"],
  ["gbk", "gbk"],
  ["cp936", "gbk"],
  ["gb18030", "gb18030"],
  ["big5", "big5"],
  ["latin1", "windows-1252"],
  ["iso-8859-1", "windows-1252"],
  ["us-ascii", "utf-8"],
  ["ascii", "utf-8"],
  ["ks_c_5601-1987", "euc-kr"],
  ["shift_jis", "shift_jis"],
]);

/** 把 `charset=gb2312` 之类归一化成 TextDecoder 认识的标签。 */
export function normaliseCharset(label) {
  const raw = String(label ?? "").trim().toLowerCase().replace(/^"|"$/g, "");
  if (!raw) return "utf-8";
  return CHARSET_ALIAS.get(raw) ?? raw;
}

/** 字节 → 字符串。声明优先，坏字节就退到 GBK，再退 UTF-8，最差拉丁。 */
export function decodeBytes(buffer, charset) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
  const order = [];
  const declared = normaliseCharset(charset);
  order.push(declared, "utf-8", "gb18030", "gbk");
  for (const label of order) {
    try {
      const text = new TextDecoder(label, { fatal: false }).decode(buf);
      if (!text.includes("\uFFFD")) return text;
    } catch {
      /* 不认识的标签，继续退 */
    }
  }
  return buf.toString("latin1");
}

/* -------------------------------------------------------- RFC 2047 编码字 */

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function decodeQ(text) {
  const bytes = [];
  const src = text.replace(/_/g, " ");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(src.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** 还原 `=?UTF-8?B?...?=` / `=?GBK?Q?...?=`；相邻编码字之间的空白按 RFC 去掉。 */
export function decodeWords(input) {
  const text = String(input ?? "");
  if (!text.includes("=?")) return text;
  return text
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(ENCODED_WORD, (_all, charset, enc, payload) => {
      try {
        const bytes = enc.toUpperCase() === "B"
          ? Buffer.from(payload.replace(/[^A-Za-z0-9+/=]/g, ""), "base64")
          : decodeQ(payload);
        return decodeBytes(bytes, charset);
      } catch {
        return _all;
      }
    });
}

/** 头里的裸 8 位字节（不规范的 UTF-8/GBK 原文）也要救一下。 */
function fixRawBytes(value) {
  if (!/[\u0080-\u00ff]/.test(value)) return value;
  return decodeBytes(Buffer.from(value, "latin1"));
}

/** 头值一体化解码：有编码字就交给 decodeWords（它自带 charset），否则救裸 8 位字节。 */
export function decodeHeaderValue(input) {
  const text = String(input ?? "");
  // ★ 不能在解码后再跑一次 fixRawBytes：编码字解得的中文里常夹着 U+00B7「·」、
  // U+00CA 这类 Latin-1 区字符，那一步会把它当裸字节再解一遍，整串就烂了。
  return text.includes("=?") ? decodeWords(text) : fixRawBytes(text);
}

/* ------------------------------------------------------------ 头字段解析 */

/** 把 `text/plain; charset="gbk"; name="a.txt"` 拆成 { value, params }。 */
export function parseHeaderValue(raw) {
  const text = String(raw ?? "");
  const parts = [];
  let buf = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quoted) {
      buf += ch + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      buf += ch;
      continue;
    }
    if (ch === ";" && !quoted) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);

  const main = unquote((parts.shift() ?? "").trim());
  /** @type {Record<string, string>} */
  const params = {};
  /** @type {Record<string, Record<number, string>>} */
  const chunks = {};
  const starred = new Set();

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    let key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    const asChunk = /^(.*?)\*(\d+)(\*?)$/.exec(key);
    if (asChunk) {
      const base = asChunk[1];
      const index = Number(asChunk[2]);
      const extended = asChunk[3] === "*";
      let piece = unquote(val);
      if (extended) piece = decodeRfc2231Piece(piece);
      (chunks[base] ??= {})[index] = piece;
      continue;
    }
    const extended = key.endsWith("*");
    if (extended) key = key.slice(0, -1);
    let value = unquote(val);
    if (extended) {
      const parsed = decodeRfc2231Piece(value);
      value = parsed;
      starred.add(key);
    }
    params[key] = value;
  }

  for (const [base, pieces] of Object.entries(chunks)) {
    const ordered = Object.keys(pieces)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => pieces[k])
      .join("");
    params[base] = ordered;
  }

  // 参数里塞 RFC2047 编码字（大量中文客户端这么干）
  for (const [key, value] of Object.entries(params)) {
    if (value.includes("=?")) params[key] = decodeWords(value);
    if (starred.has(key)) params[key] = value;
  }
  return { value: main, params };
}

function unquote(value) {
  const text = String(value ?? "").trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return text;
}

/** `UTF-8''%E4%B8%AD` → `中`；不带 charset 的裸百分号编码也吃得下。 */
function decodeRfc2231Piece(value) {
  const text = String(value ?? "");
  const match = /^([^']*)'[^']*'(.*)$/.exec(text);
  const charset = match ? match[1] || "utf-8" : "utf-8";
  const payload = match ? match[2] : text;
  let decoded;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    decoded = payload.replace(/%([0-9A-Fa-f]{2})/g, (_a, hex) => String.fromCharCode(parseInt(hex, 16)));
    return decodeBytes(Buffer.from(decoded, "latin1"), charset);
  }
  return decoded;
}

/** 头块（Buffer/二进制字符串）→ [{ name, value }]，折叠行按 RFC 拼回。 */
export function parseHeaders(input) {
  const text = Buffer.isBuffer(input) ? input.toString("latin1") : String(input ?? "");
  const out = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && current) {
      current.raw += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    current = { name: line.slice(0, colon).trim().toLowerCase(), raw: line.slice(colon + 1).trim() };
    out.push(current);
  }
  return out.map(({ name, raw }) => ({ name, value: decodeHeaderValue(raw) }));
}

/** 取第一个同名头。 */
export function headerValue(headers, name) {
  const key = String(name).toLowerCase();
  const found = headers.find((h) => h.name === key);
  return found ? found.value : "";
}

/* ------------------------------------------------------ 传输编码 & 正文码 */

/** quoted-printable 解码（软换行、=XX，兼容裸 8 位）。 */
export function decodeQuotedPrintable(input) {
  const src = Buffer.isBuffer(input) ? input.toString("latin1") : String(input ?? "");
  const soft = src.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < soft.length; i++) {
    const ch = soft[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function decodeTransfer(buffer, encoding) {
  const enc = String(encoding ?? "").trim().toLowerCase();
  if (enc === "base64") {
    const clean = buffer.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
    return Buffer.from(clean, "base64");
  }
  if (enc === "quoted-printable") return decodeQuotedPrintable(buffer);
  return buffer;
}

/* ------------------------------------------------------------- multipart */

function splitMultipart(body, boundary) {
  const text = body.toString("latin1");
  const delimiter = "--" + boundary;
  const parts = [];
  let index = text.indexOf(delimiter);
  if (index < 0) return [];
  while (index >= 0) {
    const next = text.indexOf(delimiter, index + delimiter.length);
    if (next < 0) break;
    let chunk = text.slice(index + delimiter.length, next);
    if (chunk.startsWith("--")) break; // 结束分隔符
    chunk = chunk.replace(/^\r?\n/, "");
    parts.push(Buffer.from(chunk, "latin1"));
    index = next;
  }
  // 逐个 Buffer 重新用 latin1 切会破坏字节吗？latin1 是 1:1 的，安全。
  return parts;
}

/**
 * 解析一封完整邮件（Buffer）。
 * @returns {{headers:Array<{name:string,value:string}>, text:string, html:string,
 *   attachments:Array<{filename:string, contentType:string, size:number, content:Buffer}>}}
 */
export function parseMessage(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? "");
  const split = indexOfHeaderEnd(buffer);
  const headerBlock = buffer.subarray(0, split);
  const body = buffer.subarray(split);
  const headers = parseHeaders(headerBlock);

  const result = { headers, text: "", html: "", attachments: [] };
  const contentType = parseHeaderValue(headerValue(headers, "content-type") || "text/plain");
  const encoding = headerValue(headers, "content-transfer-encoding");
  const disposition = parseHeaderValue(headerValue(headers, "content-disposition"));

  const walk = (ct, disp, enc, payload) => {
    const type = (ct.value || "text/plain").toLowerCase();
    if (type.startsWith("multipart/")) {
      const boundary = ct.params.boundary;
      if (!boundary) return;
      for (const part of splitMultipart(payload, boundary)) {
        const partSplit = indexOfHeaderEnd(part);
        const partHeaders = parseHeaders(part.subarray(0, partSplit));
        const partBody = part.subarray(partSplit);
        walk(
          parseHeaderValue(headerValue(partHeaders, "content-type") || "text/plain"),
          parseHeaderValue(headerValue(partHeaders, "content-disposition")),
          headerValue(partHeaders, "content-transfer-encoding"),
          partBody,
        );
      }
      return;
    }

    const decoded = decodeTransfer(payload, enc);
    const isAttachment = disp.value.toLowerCase() === "attachment" || Boolean(disp.params.filename) || Boolean(ct.params.name);
    const filename = disp.params.filename || ct.params.name || "";
    if (isAttachment) {
      result.attachments.push({
        filename: filename || `attachment-${result.attachments.length + 1}`,
        contentType: type,
        size: decoded.length,
        content: decoded,
      });
      return;
    }
    if (type === "text/html") {
      if (!result.html) result.html = decodeBytes(decoded, ct.params.charset);
      return;
    }
    if (type.startsWith("text/")) {
      const text = decodeBytes(decoded, ct.params.charset);
      if (!result.text) result.text = text;
      return;
    }
    // 内嵌图片/其它二进制：当附件留着，免得正文里的图丢掉线索
    if (decoded.length) {
      result.attachments.push({
        filename: ct.params.name || `embedded-${result.attachments.length + 1}`,
        contentType: type,
        size: decoded.length,
        content: decoded,
        embedded: true,
      });
    }
  };

  walk(contentType, disposition, encoding, body);
  if (!result.text && result.html) result.text = htmlToText(result.html);
  return result;
}

/** 找到头与正文的分界：第一个空行之后的位置（跳过 CRLF / LF）。 */
function indexOfHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return crlf + 4;
  if (lf >= 0) return lf + 2;
  return buffer.length;
}

/* -------------------------------------------------------------- HTML 转文本 */

const ENTITIES = new Map([
  ["nbsp", " "], ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"],
  ["copy", "©"], ["reg", "®"], ["hellip", "…"], ["mdash", "—"], ["ndash", "–"],
  ["ldquo", "“"], ["rdquo", "”"], ["lsquo", "‘"], ["rsquo", "’"], ["middot", "·"],
  ["bull", "•"], ["times", "×"], ["yen", "¥"],
]);

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (all, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return all;
        }
      }
      return all;
    }
    return ENTITIES.get(body.toLowerCase()) ?? all;
  });
}

/** 粗暴但够用的 HTML → 纯文本：去 script/style，块级元素换行，保留基本排版。 */
export function htmlToText(html) {
  let text = String(html ?? "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|h[1-6]|table|blockquote)\s*>/gi, "\n");
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, "[图: $1]");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/* ---------------------------------------------------------------- 发信拼装 */

export function encodeWord(text, charset = "utf-8") {
  const value = String(text ?? "");
  if (!/[^\u0000-\u007f]/.test(value)) return value;
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `=?${charset.toUpperCase()}?B?${encoded}?=`;
}

export function formatAddress({ name, address }) {
  const addr = String(address ?? "").trim();
  const label = String(name ?? "").trim();
  if (!label) return addr;
  if (/[^\u0000-\u007f]/.test(label) || /["\\]/.test(label)) {
    return `${encodeWord(label)} <${addr}>`;
  }
  return `"${label.replace(/"/g, '\\"')}" <${addr}>`;
}

/** 附件头里的文件名：ASCII 直写，中文按 RFC2231 加 RFC2047 双保险。 */
export function encodeFilenameParam(filename) {
  const name = String(filename ?? "attachment.bin");
  if (!/[^\u0000-\u007f]/.test(name)) return `filename="${name.replace(/"/g, "")}"`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `filename="=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?="; filename*=UTF-8''${encoded}`;
}

function wrapBase64(buffer) {
  return buffer.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function normaliseNewlines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\n/g, CRLF);
}

/**
 * 拼一封可发信件。
 * @param {{from:string, fromName?:string, to:string[], cc?:string[], subject?:string,
 *   text?:string, html?:string, headers?:Record<string,string>,
 *   attachments?:Array<{filename:string, contentType?:string, content:Buffer}>}} input
 * @returns {{raw: Buffer, messageId: string}}
 */
export function buildMessage(input) {
  const to = (input.to ?? []).filter(Boolean);
  const cc = (input.cc ?? []).filter(Boolean);
  const from = String(input.from ?? "");
  const fromName = input.fromName ?? "";
  const subject = String(input.subject ?? "");
  const domain = from.includes("@") ? from.split("@").pop() : "localhost";
  const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${domain}>`;

  const alternatives = [];
  if (input.text) {
    alternatives.push(
      [
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(Buffer.from(normaliseNewlines(input.text), "utf8")),
      ].join(CRLF),
    );
  }
  if (input.html) {
    alternatives.push(
      [
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(Buffer.from(normaliseNewlines(input.html), "utf8")),
      ].join(CRLF),
    );
  }
  if (!alternatives.length) {
    alternatives.push(
      ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrapBase64(Buffer.from("", "utf8"))].join(CRLF),
    );
  }

  const boundaryMixed = `----dsh-mail-mixed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const boundaryAlt = `----dsh-mail-alt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;

  /* 第一层：正文（纯文本 / 纯文本+HTML 的双变体），只要 Content-Type 的值，不要头名 */
  let altContentType;
  let altBody;
  let altEncoding = null;
  if (alternatives.length > 1) {
    altContentType = `multipart/alternative; boundary="${boundaryAlt}"`;
    altBody = `${alternatives.map((part) => `--${boundaryAlt}${CRLF}${part}`).join(CRLF)}${CRLF}--${boundaryAlt}--`;
  } else {
    const firstBreak = alternatives[0].indexOf(CRLF);
    const bodyBreak = alternatives[0].indexOf(CRLF + CRLF);
    altContentType = alternatives[0].slice("Content-Type: ".length, firstBreak);
    altBody = alternatives[0].slice(bodyBreak + 4);
    altEncoding = "base64";
  }

  /* 第二层：有附件就整体再包一层 multipart/mixed */
  let topContentType = altContentType;
  let topBody = altBody;
  if (hasAttachments) {
    topContentType = `multipart/mixed; boundary="${boundaryMixed}"`;
    const chunks = [`--${boundaryMixed}`, `Content-Type: ${altContentType}`, "", altBody];
    for (const file of input.attachments) {
      const contentType = file.contentType || "application/octet-stream";
      chunks.push(
        `--${boundaryMixed}`,
        `Content-Type: ${contentType}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; ${encodeFilenameParam(file.filename)}`,
        "",
        wrapBase64(file.content),
      );
    }
    chunks.push(`--${boundaryMixed}--`);
    topBody = chunks.join(CRLF);
  }

  const head = [
    `From: ${formatAddress({ name: fromName, address: from })}`,
    `To: ${to.join(", ")}`,
    cc.length ? `Cc: ${cc.join(", ")}` : null,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    ...Object.entries(input.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    altEncoding && !hasAttachments ? `Content-Transfer-Encoding: ${altEncoding}` : null,
    `Content-Type: ${topContentType}`,
    "",
  ].filter((line) => line !== null).join(CRLF);

  return { raw: Buffer.from(`${head}${CRLF}${topBody}${CRLF}`, "utf8"), messageId };
}

/* ------------------------------------------------- BODYSTRUCTURE 解析 */

/**
 * 解析 IMAP BODYSTRUCTURE（RFC 3501 §7.4.2 的 S 表达式）。
 *
 * ★ 为什么需要它：读一封大信，旧做法是把整封原文（含全部附件）拉下来。
 * 实测收件箱里那封 23.22 MB 的臭氧发生器来信，`readMessage` 要 **37.5 秒**，
 * 1.58 MB 那封也要 2.5 秒 —— 慢在「下载附件」上，而看正文根本不看附件。
 * 现在改成：先要 BODYSTRUCTURE（几 KB），再按部件号只取正文部件。
 */
export function parseBodyStructure(input) {
  const text = String(input ?? "").trim();
  if (!text.startsWith("(")) return null;
  const parsed = readStructureValue(tokenizeStructure(text), 0);
  if (!parsed) return null;
  const node = buildStructureNode(parsed.value, []);
  // 单部件信件的正文就是部件「1」（IMAP 里顶层正文的部件号是 1，不是空）。
  if (node && node.kind === "single" && !node.path.length) node.path = [1];
  return node;
}

function tokenizeStructure(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === " " || ch === "\r" || ch === "\n" || ch === "\t") {
      index++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: ch });
      index++;
      continue;
    }
    if (ch === '"') {
      let value = "";
      index++;
      while (index < text.length) {
        const c = text[index];
        if (c === "\\" && index + 1 < text.length) {
          value += text[index + 1];
          index += 2;
          continue;
        }
        if (c === '"') {
          index++;
          break;
        }
        value += c;
        index++;
      }
      tokens.push({ kind: "str", value });
      continue;
    }
    let value = "";
    while (index < text.length && !' \r\n\t()"'.includes(text[index])) {
      value += text[index];
      index++;
    }
    tokens.push({ kind: "atom", value });
  }
  return tokens;
}

function readStructureValue(tokens, start) {
  if (!tokens[start] || tokens[start].kind !== "(") return null;
  const values = [];
  let index = start + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === ")") return { value: values, next: index + 1 };
    if (token.kind === "(") {
      const nested = readStructureValue(tokens, index);
      if (!nested) return null;
      values.push(nested.value);
      index = nested.next;
      continue;
    }
    const isNil = token.kind === "atom" && String(token.value).toUpperCase() === "NIL";
    values.push(isNil ? null : token.value);
    index++;
  }
  return null;
}

function structureParams(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (let index = 0; index + 1 < list.length; index += 2) {
    const key = String(list[index] ?? "").toUpperCase();
    const value = list[index + 1];
    if (key && typeof value === "string") out[key] = value;
  }
  return out;
}

function findDisposition(list, from) {
  for (let index = from; index < list.length; index++) {
    const candidate = list[index];
    if (!Array.isArray(candidate) || !candidate.length) continue;
    const label = String(candidate[0] ?? "").toUpperCase();
    if (label === "INLINE" || label === "ATTACHMENT") {
      return { type: label.toLowerCase(), params: structureParams(candidate[1]) };
    }
  }
  return null;
}

function buildStructureNode(list, path) {
  const first = list[0];
  if (Array.isArray(first)) {
    const parts = [];
    let index = 0;
    while (index < list.length && Array.isArray(list[index])) {
      parts.push(buildStructureNode(list[index], [...path, index + 1]));
      index++;
    }
    return {
      kind: "multipart",
      type: "multipart",
      subtype: String(list[index] ?? "").toLowerCase(),
      params: structureParams(list[index + 1]),
      disposition: findDisposition(list, index + 2),
      parts,
      path,
    };
  }
  const type = String(list[0] ?? "").toLowerCase();
  const subtype = String(list[1] ?? "").toLowerCase();
  const params = structureParams(list[2]);
  const disposition = findDisposition(list, 6);
  // ★ BODYSTRUCTURE 里的文件名常常是 RFC2047 编码字（=?UTF-8?B?...?=），
  // 不解码的话面板上会显示成一长串 base64，说不清是哪个附件。
  const filename = decodeHeaderValue(disposition?.params?.FILENAME || params.NAME || "");
  return {
    kind: "single",
    type,
    subtype,
    params,
    disposition,
    filename,
    encoding: String(list[5] ?? "7bit").toLowerCase(),
    size: Number(list[6]) || 0,
    lines: type === "text" ? Number(list[7]) || 0 : 0,
    path,
  };
}

/** 传输编码 → 解码后大致的字节数（不是精确值，只用来在列表里给人看）。 */
function estimateDecodedSize(size, encoding) {
  const bytes = Number(size) || 0;
  if (encoding === "base64") return Math.round((bytes * 3) / 4);
  if (encoding === "quoted-printable") return Math.round(bytes * 0.97);
  return bytes;
}

/**
 * 从结构里分出「正文部件」与「附件」。
 * 判定口径与 `parseMessage` 完全对齐，否则同一封信「结构取」和「整封取」
 * 会给出一份不一样的附件清单，保存附件时序号就对不上了。
 */
export function structureParts(node) {
  const texts = [];
  const attachments = [];
  const walk = (item) => {
    if (!item) return;
    if (item.kind === "multipart") {
      for (const child of item.parts) walk(child);
      return;
    }
    if (!item.path.length) return;
    const path = item.path.join(".");
    const isAttachment =
      item.disposition?.type === "attachment" || Boolean(item.params.NAME) || Boolean(item.filename);
    const isText = item.type === "text" && (item.subtype === "plain" || item.subtype === "html");
    if (isAttachment) {
      attachments.push({
        path,
        filename: item.filename || `attachment-${attachments.length + 1}`,
        contentType: `${item.type}/${item.subtype}`,
        encoding: item.encoding,
        size: estimateDecodedSize(item.size, item.encoding),
        embedded: item.disposition?.type === "inline",
      });
      return;
    }
    if (isText) {
      texts.push({
        path,
        subtype: item.subtype,
        charset: item.params.CHARSET || "",
        encoding: item.encoding,
      });
      return;
    }
    if (item.size) {
      attachments.push({
        path,
        filename: decodeHeaderValue(item.params.NAME || "") || `embedded-${attachments.length + 1}`,
        contentType: `${item.type}/${item.subtype}`,
        encoding: item.encoding,
        size: estimateDecodedSize(item.size, item.encoding),
        embedded: true,
      });
    }
  };
  walk(node);
  return { texts, attachments };
}