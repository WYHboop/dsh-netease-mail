/**
 * 极简 SMTP 客户端（TLS，零依赖）：EHLO / AUTH LOGIN / MAIL / RCPT / DATA / QUIT。
 *
 * 只走 465 端口的隐式 TLS，这正是网易企业邮给的口子；
 * 一条连接发一封信，发完就退，不做连接池（发信不频繁，简单比复用安全）。
 */

import { connect as tlsConnect } from "node:tls";
import { randomBytes } from "node:crypto";

const CRLF = "\r\n";

export class SmtpError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "SmtpError";
    this.detail = detail;
  }
}

class LineReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.failure = null;
    socket.on("data", (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.#wake();
    });
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new SmtpError("SMTP 连接已关闭")));
    socket.on("end", () => this.#fail(new SmtpError("SMTP 连接被服务器断开")));
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

  async readLine() {
    for (;;) {
      const index = this.buffer.indexOf(CRLF);
      if (index >= 0) {
        const line = this.buffer.subarray(0, index).toString("utf8");
        this.buffer = this.buffer.subarray(index + 2);
        return line;
      }
      if (this.failure) throw this.failure;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}

class Session {
  constructor(socket, { timeoutMs = 30000, log = () => {} } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.reader = new LineReader(socket);
  }

  /** 读一条完整应答（含 `250-` 续行）。 */
  async reply() {
    const lines = [];
    for (;;) {
      const line = await withTimeout(this.reader.readLine(), this.timeoutMs, "SMTP 应答超时");
      lines.push(line);
      const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!match) continue;
      if (match[2] !== "-") return { code: Number(match[1]), lines, text: match[3] };
    }
  }

  async send(text) {
    this.socket.write(`${text}${CRLF}`);
  }

  async command(text, expect) {
    this.log(`C: ${mask(text)}`);
    await this.send(text);
    const reply = await this.reply();
    this.log(`S: ${reply.code} ${reply.text}`);
    const expected = Array.isArray(expect) ? expect : [expect];
    if (expect !== undefined && !expected.includes(reply.code)) {
      throw new SmtpError(`SMTP 命令被拒（${mask(text)}）：${reply.code} ${reply.text}`, reply);
    }
    return reply;
  }

  /** DATA 段：点号转义 + 结尾补 CRLF，然后等 250。 */
  async data(raw) {
    const text = raw.toString("utf8");
    const normalised = text.replace(/\r\n/g, "\n").replace(/\n/g, CRLF).replace(/(^|\r\n)\./g, "$1..");
    const payload = normalised.endsWith(CRLF) ? normalised : normalised + CRLF;
    this.socket.write(payload + "." + CRLF);
    const reply = await this.reply();
    this.log(`S: ${reply.code} ${reply.text}`);
    if (reply.code !== 250) {
      throw new SmtpError(`信件被服务器拒收：${reply.code} ${reply.text}`, reply);
    }
    return reply;
  }
}

function mask(text) {
  const value = String(text);
  if (/^[A-Za-z0-9+/=]{8,}$/.test(value)) return "<base64 credential>";
  return value;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function connectTls({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: true, timeout: timeoutMs });
    const fail = (error) => {
      socket.destroy();
      reject(error instanceof Error ? error : new SmtpError(String(error)));
    };
    socket.once("secureConnect", () => {
      socket.setTimeout(0);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", fail);
    socket.once("timeout", () => fail(new SmtpError(`连接 ${host}:${port} 超时`)));
  });
}

/**
 * 发一封信。
 * @param {{host:string, port?:number, user:string, pass:string, from:string,
 *   recipients:string[], raw:Buffer, timeoutMs?:number, log?:(line:string)=>void, dryRun?:boolean}} options
 * dryRun=true 时只走到 RCPT（验证账号、收件人都被接受），不投递 DATA。
 */
export async function sendMessage(options) {
  const {
    host,
    port = 465,
    user,
    pass,
    from,
    recipients,
    raw,
    timeoutMs = 40000,
    log = () => {},
    dryRun = false,
  } = options;

  const list = (recipients ?? []).map((item) => String(item).trim()).filter(Boolean);
  if (!list.length) throw new SmtpError("没有收件人");
  if (!raw) throw new SmtpError("没有信件内容");

  const socket = await connectTls({ host, port, timeoutMs });
  socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError("SMTP 空闲超时")));
  const session = new Session(socket, { timeoutMs, log });
  const accepted = [];
  const rejected = [];

  try {
    await session.reply(); // 220 问候
    const hostname = `dsh-mail.${randomBytes(3).toString("hex")}.local`;
    await session.command(`EHLO ${hostname}`, 250);

    // AUTH LOGIN：340/334 → 用户名 → 密码
    let authed = false;
    try {
      const challenge = await session.command("AUTH LOGIN", [334, 503]);
      if (challenge.code === 334) {
        await session.command(Buffer.from(user, "utf8").toString("base64"), 334);
        await session.command(Buffer.from(pass, "utf8").toString("base64"), 235);
        authed = true;
      } else if (challenge.code === 503) {
        authed = true; // 服务器认为已认证
      }
    } catch (error) {
      throw new SmtpError(`SMTP 认证失败（账号 ${user}）：${error.message}`, error);
    }
    if (!authed) throw new SmtpError("SMTP 认证未完成");

    await session.command(`MAIL FROM:<${from}>`, 250);

    for (const recipient of list) {
      await session.send(`RCPT TO:<${recipient}>`);
      const answer = await session.reply();
      log(`S: ${answer.code} ${answer.text}`);
      if (answer.code === 250 || answer.code === 251) accepted.push(recipient);
      else rejected.push({ recipient, code: answer.code, message: answer.text });
    }
    if (!accepted.length) {
      throw new SmtpError(`所有收件人都被拒：${rejected.map((r) => `${r.recipient} ${r.code}`).join("; ")}`, rejected);
    }

    if (dryRun) {
      await session.command("RSET", [250]);
      await session.command("QUIT", [221]);
      return { delivered: false, dryRun: true, accepted, rejected };
    }

    await session.command("DATA", 354);
    const delivered = await session.data(raw);
    await session.command("QUIT", [221]);
    return { delivered: true, dryRun: false, accepted, rejected, response: `${delivered.code} ${delivered.text}` };
  } finally {
    try {
      socket.destroy();
    } catch {
      /* 忽略 */
    }
  }
}