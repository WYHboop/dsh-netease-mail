/**
 * 配置与凭据。
 *
 * 账号信息（服务器名、邮箱地址）走 cordis.patch.yml 的 `config`，
 * 或本机私有的 local-settings.json（见下）；
 * 授权码**不进配置**，只从下面三个来源按序取：
 *   1) config.authCode（临时调试用，不建议长期留着）
 *   2) 环境变量（默认 NETEASE_AUTH_CODE）
 *   3) 授权码文件（路径由 config.authCodeFile / local-settings.json 指定）
 * 报告里只说「来自哪个来源」，绝不回显授权码本身。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 本机私有配置（不进仓库、不进发布包）。
 *
 * 公开的默认值必须是中性的：别人的机器不该默认连上谁的邮箱。
 * 私有值可以从三个地方来（都读得到就当一层，越靠后越优先）：
 *   1) 环境变量 DSH_NETEASE_MAIL_SETTINGS 指向的 JSON 文件
 *   2) 用户目录下的 .dsh/dsh-netease-mail.json（装成 npm 包时改这里最方便）
 *   3) 包根目录的 local-settings.json（源码目录开发时用，已 gitignore）
 * 再往上是插件 config（cordis.patch.yml），config 永远最后生效。
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_SETTINGS_FILE = join(PACKAGE_ROOT, "local-settings.json");
export const USER_SETTINGS_FILE = join(homedir(), ".dsh", "dsh-netease-mail.json");
export const ENV_SETTINGS_FILE = (process.env.DSH_NETEASE_MAIL_SETTINGS || "").trim();

export const DEFAULTS = {
  account: "",
  displayName: "",
  imapHost: "imap.qiye.163.com",
  imapPort: 993,
  smtpHost: "smtp.qiye.163.com",
  smtpPort: 465,
  authCodeEnv: "NETEASE_AUTH_CODE",
  authCodeFile: "",
  defaultMailbox: "INBOX",
  sentMailbox: "",
  draftMailbox: "",
  trashMailbox: "",
  pageSize: 15,
  maxPageSize: 60,
  snippetChars: 90,
  bodyChars: 6000,
  scanLimit: 300,
  timeoutMs: 30000,
  // 中文关键词只能本地过滤；正文回捞是最贵的一步，给它三条闸：
  // 最多几封、单封超过多大就不拉（一封信 23 MB 那种会把这步拖死）、总共给它多少毫秒。
  bodyScan: 10,
  bodyScanMaxBytes: 3_000_000,
  bodyBudgetMs: 8000,
  downloadDir: join(homedir(), "Downloads", "mail-attachments"),
};

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** 读一份私有配置；文件不存在或读坏了都当空对象，不打断插件加载。 */
function readSettingsFile(file) {
  try {
    if (!file || !existsSync(file)) return {};
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (error) {
    process.emitWarning?.(`[dsh-netease-mail] ${file} 读取失败：${error.message}`);
    return {};
  }
}

/** 三处私有配置合并（后读的盖先读的）：包内 < 用户目录 < 环境变量指定的文件。 */
export function readLocalOverrides() {
  return {
    ...readSettingsFile(LOCAL_SETTINGS_FILE),
    ...readSettingsFile(USER_SETTINGS_FILE),
    ...readSettingsFile(ENV_SETTINGS_FILE),
  };
}

export function normaliseSettings(config) {
  const raw = { ...readLocalOverrides(), ...(config && typeof config === "object" ? config : {}) };
  return {
    account: text(raw.account, DEFAULTS.account),
    displayName: text(raw.displayName, DEFAULTS.displayName),
    imapHost: text(raw.imapHost, DEFAULTS.imapHost),
    imapPort: num(raw.imapPort, DEFAULTS.imapPort),
    smtpHost: text(raw.smtpHost, DEFAULTS.smtpHost),
    smtpPort: num(raw.smtpPort, DEFAULTS.smtpPort),
    authCodeEnv: text(raw.authCodeEnv, DEFAULTS.authCodeEnv),
    authCodeFile: text(raw.authCodeFile, DEFAULTS.authCodeFile),
    authCode: typeof raw.authCode === "string" ? raw.authCode.trim() : "",
    defaultMailbox: text(raw.defaultMailbox, DEFAULTS.defaultMailbox),
    sentMailbox: text(raw.sentMailbox, DEFAULTS.sentMailbox),
    trashMailbox: text(raw.trashMailbox, DEFAULTS.trashMailbox),
    pageSize: num(raw.pageSize, DEFAULTS.pageSize),
    maxPageSize: num(raw.maxPageSize, DEFAULTS.maxPageSize),
    snippetChars: num(raw.snippetChars, DEFAULTS.snippetChars),
    bodyChars: num(raw.bodyChars, DEFAULTS.bodyChars),
    scanLimit: num(raw.scanLimit, DEFAULTS.scanLimit),
    timeoutMs: num(raw.timeoutMs, DEFAULTS.timeoutMs),
    bodyScan: num(raw.bodyScan, DEFAULTS.bodyScan),
    bodyScanMaxBytes: num(raw.bodyScanMaxBytes, DEFAULTS.bodyScanMaxBytes),
    bodyBudgetMs: num(raw.bodyBudgetMs, DEFAULTS.bodyBudgetMs),
    downloadDir: text(raw.downloadDir, DEFAULTS.downloadDir),
  };
}

export class AuthCodeMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthCodeMissingError";
  }
}

/**
 * 取授权码。
 * @returns {{ code: string, source: string }}
 */
export function resolveAuthCode(settings) {
  if (settings.authCode) return { code: settings.authCode, source: "插件配置 config.authCode" };

  const envName = settings.authCodeEnv;
  const fromEnv = envName ? process.env[envName] : "";
  if (fromEnv && fromEnv.trim()) return { code: fromEnv.trim(), source: `环境变量 ${envName}` };

  const file = settings.authCodeFile;
  if (file && existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    const code = raw.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
    if (code) return { code: code.replace(/^["']|["']$/g, ""), source: `授权码文件 ${file}` };
  }

  throw new AuthCodeMissingError(
    `找不到网易企业邮授权码。三条路都不通：config.authCode 为空、环境变量 ${envName || "(未配置)"} 未设置、`
      + `授权码文件 ${file || "(未配置)"} 不存在或为空。`,
  );
}

/** 授权码来源的可读描述（给自检报告用，不含码本身）。 */
export function describeCredential(settings) {
  try {
    const { source } = resolveAuthCode(settings);
    return { available: true, source };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}