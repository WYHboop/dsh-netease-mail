/**
 * dsh-netease-mail · DSH 内嵌页（客户端半边）
 *
 * 目标：把「看邮件 / 操作邮件」变成 DSH 侧栏里的一个面板，而不是只靠对话里打字。
 *   左栏 = 文件夹（未读数）、中间 = 邮件列表（搜索 / 只看未读 / 加载更多）、
 *   右侧 = 正文 + 附件 + 操作条（已读、星标、删除、回复），右上「写邮件」开抽屉。
 *
 * 铁律：
 *   1. 前端不复制服务端逻辑 —— 解析、排序、判定全由 host 的 /mail/api2/* 给；
 *   2. 发信、删除是不可逆/对外动作，必须在界面上再点一次「确认」；
 *   3. host 路由没起来时不许整屏白掉 —— 能显示的照常显示，缺的那块写清原因。
 */

window.__ModuleLoader__.load({
  id: "dsh-netease-mail",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const PANEL_KEY = "mail";
    const BUILD = "mail-ui-2026-11-19-a";

    /* ── 与服务端说话 ──────────────────────────────────────── */

    async function api(path, options = {}) {
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { error: text.slice(0, 400) };
      }
      if (!response.ok || data?.error) throw new Error(data?.error ?? `HTTP ${response.status}`);
      return data;
    }

    function report(stage, payload) {
      try {
        fetch("/mail/api2/clientlog", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stage, payload, at: new Date().toISOString() }),
        }).catch(() => {});
      } catch {
        /* 上报失败不影响界面 */
      }
    }

    /* ── 样式令牌 ─────────────────────────────────────────── */

    const C = {
      bg: "var(--dsw-alias-bg-base, #ffffff)",
      bgSoft: "var(--dsw-alias-bg-secondary, #f6f7f9)",
      bgHover: "var(--dsw-alias-bg-tertiary, #eef1f5)",
      line: "var(--dsw-alias-border-default, #e3e6ec)",
      text: "var(--dsw-alias-label-primary, #1f2430)",
      dim: "var(--dsw-alias-label-secondary, #5b6472)",
      faint: "var(--dsw-alias-label-tertiary, #8b93a1)",
      brand: "var(--dsw-alias-brand-primary, #0a6cff)",
    };

    const mono = "ui-monospace, SFMono-Regular, Consolas, monospace";
    const btn = (extra) => ({
      border: `1px solid ${C.line}`,
      background: C.bg,
      color: C.text,
      borderRadius: 8,
      padding: "5px 10px",
      fontSize: 12.5,
      cursor: "pointer",
      lineHeight: 1.4,
      ...extra,
    });
    const input = {
      border: `1px solid ${C.line}`,
      borderRadius: 8,
      background: C.bg,
      color: C.text,
      fontSize: 13,
      padding: "7px 10px",
      outline: "none",
      width: "100%",
      boxSizing: "border-box",
      fontFamily: "inherit",
    };

    /* ── 小工具 ───────────────────────────────────────────── */

    function size(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    function Dot({ on, title }) {
      return h("span", {
        title,
        style: {
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: 999,
          background: on ? C.brand : "transparent",
          border: on ? "none" : `1px solid ${C.faint}`,
          marginRight: 6,
          flex: "0 0 auto",
        },
      });
    }

    function Empty({ children }) {
      return h("div", { style: { color: C.faint, fontSize: 13, padding: "28px 16px", textAlign: "center", lineHeight: 1.8 } }, children);
    }

    /* ── 错误边界：一块坏了不许整屏白 ──────────────────────── */

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        report("render-crash", { message: String(error?.message ?? error), stack: String(error?.stack ?? "").slice(0, 2000), info: String(info?.componentStack ?? "").slice(0, 2000) });
      }
      render() {
        if (!this.state.error) return this.props.children;
        return h(
          "div",
          { style: { padding: 24, fontFamily: mono, fontSize: 12, color: "#b4283c", whiteSpace: "pre-wrap" } },
          "邮箱面板渲染崩了：\n",
          String(this.state.error?.message ?? this.state.error),
          "\n\n刷新页面（Ctrl+R）再试；还不行就看 lib/client-errors.log。",
        );
      }
    }

    /* ── 文件夹栏 ─────────────────────────────────────────── */

    function FolderRail({ folders, active, onPick, loading }) {
      return h(
        "div",
        { style: { width: 168, flex: "0 0 auto", borderRight: `1px solid ${C.line}`, background: C.bgSoft, display: "flex", flexDirection: "column", padding: "10px 8px", gap: 2, overflowY: "auto" } },
        h("div", { style: { fontSize: 11.5, color: C.faint, padding: "4px 8px 6px", letterSpacing: ".04em" } }, "文件夹"),
        ...folders.map((folder) =>
          h(
            "button",
            {
              key: folder.name,
              onClick: () => onPick(folder.name),
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
                textAlign: "left",
                border: "none",
                borderRadius: 8,
                padding: "7px 9px",
                cursor: "pointer",
                fontSize: 13,
                fontFamily: "inherit",
                background: folder.name === active ? C.bg : "transparent",
                color: C.text,
                boxShadow: folder.name === active ? `inset 0 0 0 1px ${C.line}` : "none",
              },
            },
            h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, folder.label ?? folder.name),
            h(
              "span",
              { style: { fontSize: 11.5, color: folder.unseen ? C.brand : C.faint, fontWeight: folder.unseen ? 600 : 400, flex: "0 0 auto" } },
              folder.unseen ? String(folder.unseen) : String(folder.exists ?? folder.messages ?? ""),
            ),
          ),
        ),
        loading ? h("div", { style: { fontSize: 11.5, color: C.faint, padding: "8px 9px" } }, "读计数中…") : null,
      );
    }

    /* ── 列表栏 ───────────────────────────────────────────── */

    function MessageRow({ item, active, onOpen }) {
      const [hover, setHover] = useState(false);
      return h(
        "div",
        {
          onClick: () => onOpen(item),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            padding: "9px 12px",
            borderBottom: `1px solid ${C.line}`,
            cursor: "pointer",
            background: active ? C.bgHover : hover ? C.bgSoft : "transparent",
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
          },
        },
        h(Dot, { on: item.unread, title: item.unread ? "未读" : "已读" }),
        h(
          "div",
          { style: { minWidth: 0, flex: 1 } },
          h(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 } },
            h(
              "div",
              {
                style: {
                  fontSize: 13,
                  fontWeight: item.unread ? 650 : 400,
                  color: C.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                },
                title: item.subject,
              },
              item.subject,
            ),
            h("div", { style: { fontSize: 11, color: C.faint, flex: "0 0 auto" } }, item.ago ?? ""),
          ),
          h(
            "div",
            { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 3, minWidth: 0 } },
            h(
              "div",
              { style: { fontSize: 11.5, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 } },
              item.from,
            ),
            item.hasAttachments ? h("span", { title: "有附件", style: { fontSize: 11, color: C.faint } }, "📎") : null,
            item.flagged ? h("span", { title: "星标", style: { fontSize: 11, color: "#e0a300" } }, "★") : null,
            item.size ? h("span", { style: { fontSize: 11, color: C.faint, flex: "0 0 auto" } }, size(item.size)) : null,
          ),
        ),
      );
    }

    /* ── 读信栏 ───────────────────────────────────────────── */

    function AttachmentRow({ file, onSave, saving }) {
      return h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", border: `1px solid ${C.line}`, borderRadius: 8, background: C.bgSoft, fontSize: 12.5 } },
        h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, file.filename),
        h("span", { style: { color: C.faint, fontSize: 11.5 } }, size(file.size)),
        h(
          "button",
          { onClick: () => onSave(file), disabled: saving, style: btn({ padding: "2px 8px", fontSize: 11.5, opacity: saving ? 0.6 : 1 }) },
          saving ? "保存中…" : "保存",
        ),
      );
    }

    function Reader({ folder, message, loading, onFlag, onDelete, onReply, onSaveAttachment, savingIndex, notice }) {
      const [showDetail, setShowDetail] = useState(false);
      useEffect(() => {
        setShowDetail(false);
      }, [message?.uid]);
      if (loading) return h(Empty, null, "打开中…");
      if (!message) return h(Empty, null, "从左边挑一封看看呀 ♪");
      return h(
        "div",
        { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: C.bg } },
        // 标题条
        h(
          "div",
          { style: { padding: "12px 16px 10px", borderBottom: `1px solid ${C.line}` } },
          h("div", { style: { fontSize: 15.5, fontWeight: 650, lineHeight: 1.5, wordBreak: "break-word" } }, message.subject),
          h(
            "div",
            { style: { marginTop: 6, fontSize: 12.5, color: C.dim, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" } },
            h("span", null, message.from),
            h("span", { style: { color: C.faint } }, message.date),
            h("span", { style: { color: C.faint, cursor: "pointer", textDecoration: "underline dotted" }, onClick: () => setShowDetail(!showDetail) }, showDetail ? "收起收件人" : "收件人"),
            message.markedRead === false ? h("span", { style: { color: C.brand } }, "已标记未读") : null,
          ),
          showDetail
            ? h(
                "div",
                { style: { marginTop: 6, fontSize: 11.5, color: C.dim, lineHeight: 1.7, fontFamily: mono, wordBreak: "break-all" } },
                h("div", null, `收件人：${message.to || "(无)"}`),
                message.cc ? h("div", null, `抄送：${message.cc}`) : null,
                message.messageId ? h("div", null, `Message-ID：${message.messageId}`) : null,
              )
            : null,
          // 操作条
          h(
            "div",
            { style: { marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
            h("button", { onClick: () => onReply(message), style: btn() }, "回复"),
            h("button", { onClick: () => onFlag(message, message.unread ? "read" : "unread"), style: btn() }, message.unread ? "标记已读" : "标记未读"),
            h("button", { onClick: () => onFlag(message, message.flagged ? "unflag" : "flag"), style: btn() }, message.flagged ? "取消星标" : "加星标"),
            h("button", { onClick: () => onFlag(message, "move", "已发送"), style: btn(), title: "复制到「已发送」，并从当前文件夹移除" }, "存到已发送"),
            h("button", { onClick: () => onDelete(message), style: btn({ color: "#b4283c", borderColor: "#efd3d8" }) }, "删除"),
            message.truncated ? h("span", { style: { fontSize: 11.5, color: C.faint } }, `正文截断（全文 ${message.totalChars} 字）`) : null,
          ),
          notice ? h("div", { style: { marginTop: 8, fontSize: 12, color: C.brand } }, notice) : null,
        ),
        // 附件
        message.attachments?.length
          ? h(
              "div",
              { style: { padding: "10px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
              h("span", { style: { fontSize: 11.5, color: C.faint } }, `附件 ${message.attachments.length} 个：`),
              ...message.attachments.map((file) =>
                h(AttachmentRow, {
                  key: file.index,
                  file,
                  saving: savingIndex === file.index,
                  onSave: (target) => onSaveAttachment(folder, message, target),
                }),
              ),
            )
          : null,
        // 正文
        h(
          "div",
          { style: { flex: 1, overflowY: "auto", padding: "14px 16px 40px" } },
          message.text
            ? h("div", { style: { fontSize: 13.5, lineHeight: 1.85, whiteSpace: "pre-wrap", wordBreak: "break-word", color: C.text } }, message.text)
            : h(Empty, null, "这封没有可显示的纯文本正文（可能只有 HTML，或解码失败）"),
        ),
      );
    }

    /* ── 写邮件抽屉 ───────────────────────────────────────── */

    function Compose({ onClose, defaultAccount, initial }) {
      const [to, setTo] = useState(initial?.to ?? "");
      const [cc, setCc] = useState(initial?.cc ?? "");
      const [subject, setSubject] = useState(initial?.subject ?? "");
      const [body, setBody] = useState(initial?.body ?? "");
      const [files, setFiles] = useState([]);
      const [busy, setBusy] = useState(false);
      const [picking, setPicking] = useState(false);
      const [result, setResult] = useState(null);
      const [error, setError] = useState("");

      const pickFiles = useCallback(async () => {
        setPicking(true);
        try {
          const data = await api("/mail/api2/pick-files");
          if (data.paths?.length) setFiles((prev) => [...new Set([...prev, ...data.paths])]);
        } catch (e) {
          setError(`选文件不太顺：${String(e.message ?? e)}`);
        } finally {
          setPicking(false);
        }
      }, []);

      const send = useCallback(async () => {
        const recipients = to.split(/[,;，；\s]+/).filter(Boolean);
        if (!recipients.length) {
          setError("得先写收件人呀");
          return;
        }
        if (!body.trim()) {
          setError("正文是空的，再写两句吧");
          return;
        }
        const summary = `确认发这封信？\n\n收件人：${recipients.join("、")}${cc.trim() ? `\n抄送：${cc}` : ""}\n主题：${subject || "(无主题)"}\n附件：${files.length ? files.map((f) => f.split(/[\\/]/).pop()).join("、") : "无"}`;
        if (!window.confirm(summary)) return;
        setBusy(true);
        setError("");
        try {
          const data = await api("/mail/api2/send", { method: "POST", body: { to, cc, subject, text: body, attachments: files } });
          setResult(data);
          report("sent", { messageId: data.messageId, bytes: data.bytes });
        } catch (e) {
          setError(String(e.message ?? e));
        } finally {
          setBusy(false);
        }
      }, [to, cc, subject, body, files]);

      return h(
        "div",
        { style: { position: "fixed", inset: 0, background: "rgba(18,22,30,.34)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 } },
        h(
          "div",
          { style: { width: 640, maxWidth: "92vw", maxHeight: "86vh", background: C.bg, borderRadius: 14, border: `1px solid ${C.line}`, display: "flex", flexDirection: "column", boxShadow: "0 18px 48px rgba(10,20,40,.24)" } },
          h(
            "div",
            { style: { padding: "12px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between" } },
            h("div", { style: { fontSize: 14, fontWeight: 650 } }, "写邮件"),
            h("button", { onClick: onClose, style: btn({ border: "none", background: "transparent", fontSize: 16, padding: "0 6px" }) }, "×"),
          ),
          result
            ? h(
                "div",
                { style: { padding: "20px 18px 24px", lineHeight: 1.9, fontSize: 13 } },
                h("div", { style: { fontSize: 14, fontWeight: 650, color: C.brand } }, result.dryRun ? "演练通过（没有真投递）" : "已投递 ✅"),
                h("div", { style: { color: C.dim, marginTop: 8 } }, `收件人：${result.to.join("、")}`),
                result.cc?.length ? h("div", { style: { color: C.dim } }, `抄送：${result.cc.join("、")}`) : null,
                h("div", { style: { color: C.dim } }, `主题：${result.subject}`),
                h("div", { style: { color: C.dim } }, `大小：${size(result.bytes)}${result.attachments?.length ? ` · 附件 ${result.attachments.map((f) => f.filename).join("、")}` : ""}`),
                h("div", { style: { color: C.faint, fontFamily: mono, fontSize: 11.5, marginTop: 6, wordBreak: "break-all" } }, `Message-ID：${result.messageId}`),
                h("div", { style: { marginTop: 16, display: "flex", gap: 8 } },
                  h("button", { onClick: onClose, style: btn({ background: C.brand, color: "#fff", borderColor: C.brand }) }, "好，收工"),
                  h("button", { onClick: () => { setResult(null); setSubject(""); setBody(""); setFiles([]); setError(""); }, style: btn() }, "再写一封"),
                ),
              )
            : h(
                "div",
                { style: { padding: "14px 16px 18px", display: "flex", flexDirection: "column", gap: 9, overflowY: "auto" } },
                h("div", { style: { fontSize: 11.5, color: C.faint } }, `发件人：${defaultAccount || "(账号未配置)"}`),
                h("input", { style: input, placeholder: "收件人（多个用逗号或空格分隔）", value: to, onChange: (e) => setTo(e.target.value) }),
                h("input", { style: input, placeholder: "抄送（可留空）", value: cc, onChange: (e) => setCc(e.target.value) }),
                h("input", { style: input, placeholder: "主题", value: subject, onChange: (e) => setSubject(e.target.value) }),
                h("textarea", {
                  style: { ...input, minHeight: 220, resize: "vertical", lineHeight: 1.75, fontFamily: "inherit" },
                  placeholder: "正文…",
                  value: body,
                  onChange: (e) => setBody(e.target.value),
                }),
                h(
                  "div",
                  { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
                  h("button", { onClick: pickFiles, disabled: picking, style: btn() }, picking ? "选着…" : "添加附件…"),
                  ...files.map((path) =>
                    h(
                      "span",
                      { key: path, style: { fontSize: 11.5, color: C.dim, background: C.bgSoft, border: `1px solid ${C.line}`, borderRadius: 6, padding: "3px 7px", display: "inline-flex", gap: 6, alignItems: "center" } },
                      path.split(/[\\/]/).pop(),
                      h("span", { style: { cursor: "pointer", color: C.faint }, onClick: () => setFiles(files.filter((item) => item !== path)) }, "×"),
                    ),
                  ),
                ),
                error ? h("div", { style: { fontSize: 12, color: "#b4283c", whiteSpace: "pre-wrap" } }, error) : null,
                h(
                  "div",
                  { style: { display: "flex", gap: 8, marginTop: 4 } },
                  h("button", { onClick: send, disabled: busy, style: btn({ background: C.brand, color: "#fff", borderColor: C.brand, opacity: busy ? 0.7 : 1 }) }, busy ? "发送中…" : "发送"),
                  h("button", { onClick: onClose, style: btn() }, "取消"),
                ),
              ),
        ),
      );
    }

    /* ── 主面板 ───────────────────────────────────────────── */

    function MailPage() {
      const [boot, setBoot] = useState(null);
      const [bootError, setBootError] = useState("");
      const [folder, setFolder] = useState("INBOX");
      const [list, setList] = useState(null);
      const [listBusy, setListBusy] = useState(false);
      const [onlyUnread, setOnlyUnread] = useState(false);
      const [keyword, setKeyword] = useState("");
      const [searchResult, setSearchResult] = useState(null);
      const [current, setCurrent] = useState(null);
      const [readBusy, setReadBusy] = useState(false);
      const [savingIndex, setSavingIndex] = useState(-1);
      const [notice, setNotice] = useState("");
      const [composing, setComposing] = useState(false);
      const [composeInit, setComposeInit] = useState(null);

      const loadBoot = useCallback(async () => {
        try {
          const data = await api("/mail/api2/bootstrap");
          setBoot(data);
          setBootError("");
        } catch (e) {
          setBootError(String(e.message ?? e));
        }
      }, []);

      const loadList = useCallback(
        async (targetFolder, options = {}) => {
          setListBusy(true);
          try {
            const params = new URLSearchParams({ folder: targetFolder, limit: String(options.limit ?? 30) });
            if (options.unread) params.set("unread", "1");
            if (options.before) params.set("before", String(options.before));
            const data = await api(`/mail/api2/list?${params.toString()}`);
            setList(options.append && list ? { ...data, messages: [...list.messages, ...data.messages] } : data);
          } catch (e) {
            setNotice(`列表没读出来：${String(e.message ?? e)}`);
          } finally {
            setListBusy(false);
          }
        },
        [list],
      );

      useEffect(() => {
        loadBoot();
      }, [loadBoot]);

      useEffect(() => {
        setSearchResult(null);
        setKeyword("");
        loadList(folder, { unread: onlyUnread });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [folder, onlyUnread]);

      const openMessage = useCallback(
        async (item) => {
          setReadBusy(true);
          setNotice("");
          try {
            const data = await api(`/mail/api2/message?folder=${encodeURIComponent(folder)}&uid=${item.uid}`);
            // 正文接口不重复算 flags，把列表行上的 unread/flagged 并进来给操作条用
            setCurrent({ ...data, uid: item.uid, unread: item.unread, flagged: item.flagged });
            if (item.unread) {
              // 打开即已读（跟常见邮件客户端一致）；失败不吵人
              api("/mail/api2/flags", { method: "POST", body: { folder, uids: [item.uid], action: "read" } })
                .then(() => {
                  setList((prev) => (prev ? { ...prev, messages: prev.messages.map((row) => (row.uid === item.uid ? { ...row, unread: false } : row)) } : prev));
                  setBoot((prev) => (prev ? { ...prev, folders: prev.folders.map((f) => (f.name === folder ? { ...f, unseen: Math.max(0, (f.unseen ?? 0) - 1) } : f)) } : prev));
                })
                .catch(() => {});
            }
          } catch (e) {
            setNotice(`这封打不开：${String(e.message ?? e)}`);
            setCurrent(null);
          } finally {
            setReadBusy(false);
          }
        },
        [folder],
      );

      const doFlag = useCallback(
        async (message, action, target) => {
          if (action === "move" && target && !window.confirm(`把这一封复制到「${target}」并从当前文件夹移除？`)) return;
          try {
            const data = await api("/mail/api2/flags", { method: "POST", body: { folder, uids: [message.uid], action, target } });
            setNotice(data.note ?? "完成");
            if (action === "read" || action === "unread") {
              const unread = action === "unread";
              setList((prev) => (prev ? { ...prev, messages: prev.messages.map((row) => (row.uid === message.uid ? { ...row, unread } : row)) } : prev));
              setCurrent((prev) => (prev && prev.uid === message.uid ? { ...prev, unread } : prev));
            }
            if (action === "flag" || action === "unflag") {
              const flagged = action === "flag";
              setList((prev) => (prev ? { ...prev, messages: prev.messages.map((row) => (row.uid === message.uid ? { ...row, flagged } : row)) } : prev));
              setCurrent((prev) => (prev && prev.uid === message.uid ? { ...prev, flagged } : prev));
            }
            if (action === "move" || action === "delete") {
              setList((prev) => (prev ? { ...prev, messages: prev.messages.filter((row) => row.uid !== message.uid) } : prev));
              setCurrent(null);
              loadBoot();
            }
          } catch (e) {
            setNotice(`操作没成功：${String(e.message ?? e)}`);
          }
        },
        [folder, loadBoot],
      );

      const saveAttachment = useCallback(async (targetFolder, message, file) => {
        setSavingIndex(file.index);
        try {
          const data = await api("/mail/api2/attachment", { method: "POST", body: { folder: targetFolder, uid: message.uid, index: file.index } });
          setNotice(`已保存到 ${data.saved?.[0]?.path ?? data.dir}`);
        } catch (e) {
          setNotice(`附件没存下来：${String(e.message ?? e)}`);
        } finally {
          setSavingIndex(-1);
        }
      }, []);

      const runSearch = useCallback(async () => {
        const q = keyword.trim();
        if (!q) {
          setSearchResult(null);
          return;
        }
        setListBusy(true);
        try {
          const data = await api(`/mail/api2/search?q=${encodeURIComponent(q)}&folder=${encodeURIComponent(folder)}`);
          setSearchResult(data);
        } catch (e) {
          setNotice(`搜不动：${String(e.message ?? e)}`);
        } finally {
          setListBusy(false);
        }
      }, [keyword, folder]);

      const rows = searchResult ? searchResult.messages : list?.messages ?? [];
      const account = boot?.account ?? "";
      const folders = boot?.folders ?? [];
      const totalShown = searchResult ? searchResult.matched : list?.matched ?? rows.length;

      if (bootError) {
        return h(
          "div",
          { style: { padding: 28, fontFamily: mono, fontSize: 12.5, lineHeight: 1.9, color: "#b4283c", whiteSpace: "pre-wrap" } },
          "邮箱面板起来了，但服务端路由没应答：\n\n" + bootError + "\n\n多半是宿主要重启一次才挂上新路由（插件刚装）。\n重启后刷新页面即可。",
        );
      }

      return h(
        "div",
        { style: { height: "100%", display: "flex", flexDirection: "column", background: C.bg, color: C.text, fontSize: 13 } },
        // 顶栏
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${C.line}` } },
          h("div", { style: { fontWeight: 650, fontSize: 13.5 } }, "邮箱"),
          h("div", { style: { fontSize: 11.5, color: C.faint, fontFamily: mono } }, account || "…"),
          h(
            "div",
            { style: { marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" } },
            h("input", {
              style: { ...input, width: 220, padding: "5px 9px", fontSize: 12.5 },
              placeholder: "搜主题 / 发件人，回车",
              value: keyword,
              onChange: (e) => setKeyword(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter") runSearch();
                if (e.key === "Escape") {
                  setKeyword("");
                  setSearchResult(null);
                }
              },
            }),
            h(
              "button",
              {
                onClick: () => {
                  if (onlyUnread) setOnlyUnread(false);
                  setSearchResult(null);
                  loadList(folder);
                  loadBoot();
                },
                style: btn({ padding: "5px 9px", fontSize: 12 }),
              },
              "刷新",
            ),
            h("button", { onClick: () => setComposing(true), style: btn({ background: C.brand, color: "#fff", borderColor: C.brand, padding: "5px 11px", fontSize: 12 }) }, "写邮件"),
            h("span", { style: { fontSize: 10.5, color: C.faint, fontFamily: mono }, title: "界面构建戳：变了说明浏览器拿到了新的客户端件" }, BUILD),
          ),
        ),
        // 三栏
        h(
          "div",
          { style: { flex: 1, display: "flex", minHeight: 0 } },
          h(FolderRail, { folders, active: folder, onPick: (name) => setFolder(name), loading: !boot }),
          h(
            "div",
            { style: { width: 372, flex: "0 0 auto", borderRight: `1px solid ${C.line}`, display: "flex", flexDirection: "column", minHeight: 0 } },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: `1px solid ${C.line}`, background: C.bgSoft } },
              h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.dim, cursor: "pointer" } },
                h("input", { type: "checkbox", checked: onlyUnread, onChange: (e) => setOnlyUnread(e.target.checked) }),
                "只看未读",
              ),
              h("div", { style: { marginLeft: "auto", fontSize: 11, color: C.faint } }, searchResult ? `搜索命中 ${totalShown} 封` : `${totalShown} 封`),
              listBusy ? h("span", { style: { fontSize: 11, color: C.faint } }, "…") : null,
            ),
            h(
              "div",
              { style: { flex: 1, overflowY: "auto", minHeight: 0 } },
              rows.length
                ? rows.map((item) => h(MessageRow, { key: `${folder}-${item.uid}`, item, active: current?.uid === item.uid, onOpen: openMessage }))
                : h(Empty, null, searchResult ? "没搜到，换个词试试" : "这个文件夹里没有信"),
            ),
            // 加载更多：只在正常列表模式下给
            !searchResult && list?.matched > rows.length
              ? h(
                  "div",
                  { style: { padding: 8, borderTop: `1px solid ${C.line}` } },
                  h(
                    "button",
                    { onClick: () => loadList(folder, { unread: onlyUnread, limit: 30, before: rows[rows.length - 1]?.uid, append: true }), style: btn({ width: "100%", fontSize: 12 }) },
                    `加载更多（还有 ${list.matched - rows.length} 封）`,
                  ),
                )
              : null,
          ),
          h(Reader, {
            folder,
            message: current,
            loading: readBusy,
            onFlag: doFlag,
            onDelete: (message) => {
              if (window.confirm(`确定删掉「${message.subject}」？这会进「已删除」，不可逆。`)) doFlag(message, "delete");
            },
            onReply: (message) => {
              const quoted = `\n\n──────── 原信 ────────\n发件人：${message.from}\n时间：${message.date}\n主题：${message.subject}\n\n${message.text ?? ""}`;
              setComposeInit({
                to: message.from.match(/<([^>]+)>/)?.[1] ?? message.from,
                subject: message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`,
                body: quoted,
              });
              setComposing(true);
            },
            onSaveAttachment: saveAttachment,
            savingIndex,
            notice,
          }),
        ),
        composing
          ? h(Compose, {
              defaultAccount: account,
              initial: composeInit,
              onClose: () => {
                setComposing(false);
                setComposeInit(null);
                loadBoot();
                loadList(folder, { unread: onlyUnread });
              },
            })
          : null,
      );
    }

    /* ── 侧栏图标 ─────────────────────────────────────────── */

    function PanelIcon(props) {
      const active = Boolean(props?.active);
      const stroke = active ? C.brand : C.dim;
      return h(
        "svg",
        { width: 20, height: 20, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
        h("rect", { x: 2.6, y: 4.6, width: 14.8, height: 10.8, rx: 2, stroke, strokeWidth: 1.4 }),
        h("path", { d: "M3.4 6.2 10 10.9l6.6-4.7", stroke, strokeWidth: 1.4, strokeLinecap: "round" }),
      );
    }

    /* ── 注册 ─────────────────────────────────────────────── */

    return {
      inject: ["slots", "layout"],
      __test: { MailPage, Reader, FolderRail, MessageRow, Compose, Boundary },
      apply(ctx) {
        report("apply", { build: BUILD });
        ctx.slots.inject("main", () =>
          ctx.slots.register({ name: "main", key: PANEL_KEY, order: 12 }, () => h(Boundary, null, h(MailPage))),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register({ name: "sidebar.panellist", id: PANEL_KEY, order: 12, label: "邮箱" }, PanelIcon),
        );
      },
    };
  },
});