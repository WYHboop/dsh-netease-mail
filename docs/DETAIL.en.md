# NetEase Enterprise Mail connector (dsh-netease-mail)

Brings **NetEase enterprise mail** (`imap.qiye.163.com` / `smtp.qiye.163.com`) into DSH:
list, read, search, send, save attachments, and change flags — each as one sentence in chat —
plus a three-pane "Mail" panel in the sidebar.

The official connector only covers QQ Mail, and the mail plugins in the marketplace are either
QQ-specific or read-only boards (`dsh-email`, `dsh-qq-email`, `dsh-email-board`,
the QQ inbox card inside `dsh-pm-workbench`). None of them names NetEase enterprise mail.
So this plugin speaks IMAP4rev1 and SMTP itself, over `node:tls`, with **no third-party
dependencies** — the machine has no nodemailer / imapflow / mailparser, and pulling a whole
bundling toolchain in for one job is not worth it.

## Install

```powershell
git clone <repo url> dsh-netease-mail
dsh plugin --profile desktop add link:C:/path/to/dsh-netease-mail
```

Then copy `local-settings.example.json` to `local-settings.json` in the package root and fill in
`account` plus either `authCodeFile` or the `NETEASE_AUTH_CODE` environment variable.
`local-settings.json` is git-ignored; the published defaults contain no personal account.

## Tools

| Tool | Purpose | Risk |
|---|---|---|
| `mail_check` | Login self-check: folders, counts, credential source (never the code itself) | read-only |
| `mail_folders` | Folder list with counts | read-only |
| `mail_list` | Recent mail, newest first (uid / subject / from / date / size / unread / flagged / attachments) | read-only |
| `mail_read` | Body as plain text (HTML converted) plus attachment list; `markRead=false` keeps the state | marks read by default |
| `mail_search` | Keyword / sender / subject / date range / unread / flagged | read-only |
| `mail_send` | Send a message (text or HTML, cc/bcc, local files as attachments, `dryRun`) | ★ outgoing, ask the user first |
| `mail_attachment` | Save attachments to `~/Downloads/mail-attachments` by default | writes local files |
| `mail_flag` | read/unread, flag, move, delete | ★ move/delete, ask the user first |

## Configuration

Two layers, later wins:

1. `local-settings.json` in the package root (git-ignored — this is where your account and
   auth-code file path belong; copy `local-settings.example.json` to start).
2. `config` in `cordis.patch.yml` (the published defaults: hostnames, ports, page size).

The **auth code never goes into either file**; it is resolved in this order:

1. `config.authCode` (debugging only)
2. env var `NETEASE_AUTH_CODE` (renameable via `authCodeEnv`)
3. the first line of the file at `authCodeFile`

`mail_check` reports which source was used — and never prints the code.

## Verified on the live server (2026-11-19)

- IMAP login and five folder counts in 574 ms.
- A 24 MB message with four Chinese-named attachments read correctly.
- SMTP AUTH LOGIN accepted in 526 ms (dryRun: no DATA); a real send returned `250 2.0.0 Ok`.
- Offline MIME round-trip (Chinese subject, text+HTML alternative, Chinese attachment name,
  Latin-1 symbols like `· ♪ é`) all green.
- Nine panel routes end-to-end: 9/9 in 4.6 s after the speed work.

## Known quirks and limits

- **`EXISTS` lies**: one session reported `* 2552 EXISTS` for INBOX and settled at a much smaller
  number afterwards, and draft/sent counts changed by an order of magnitude within one afternoon.
  Treat `UID SEARCH ALL` results as authoritative (`listFolders({ exactCounts: true })` costs ~0.9 s).
- **Chinese keywords are filtered locally**: non-ASCII `SEARCH` arguments need `CHARSET UTF-8`
  literals that NetEase handles inconsistently, so headers are fetched back and matched here
  (`scanLimit` 300 messages, `bodyScan` 10 bodies capped at 3 MB each and 8 s total).
- **No IDLE push**: the connection is reused (closes after 120 s idle) but no server push is
  consumed, so new mail is only visible when you ask.
- **Body truncation** at 6000 chars (`bodyChars`), with the full length reported.
- **No HTML rendering**: everything is converted to plain text.
- **Large attachments are bounded by server bandwidth** (~1.04 MB/s measured): code cannot fix that.