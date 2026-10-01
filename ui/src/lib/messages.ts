// UI-owned text only. Logs, questions, notes and third-party data keep their original language.
export const messages = {
  "agentMessage.label": {
    en: "Message from ChatGPT",
    zh: "ChatGPT 发来的消息",
  },
  "agentMessage.sent": { en: "sent you a message", zh: "给你发来消息" },
  "agentMessage.unread": { en: "Unread", zh: "未读" },
  "agentMessage.unreadOne": { en: "1 unread", zh: "1 条未读" },
  "agentMessage.unreadMany": { en: "{0} unread", zh: "{0} 条未读" },
  "agentMessage.copy": { en: "Copy message", zh: "复制消息" },
  "agentMessage.dismiss": { en: "Got it", zh: "知道了" },
  "agentMessage.dismissAll": { en: "Dismiss all", zh: "全部知道了" },
  "agentMessage.dock": {
    en: "Unread messages from ChatGPT",
    zh: "ChatGPT 的未读消息",
  },
  "agentMessage.newer": { en: "Newer message", zh: "较新的消息" },
  "agentMessage.older": { en: "Older message", zh: "较早的消息" },
  "agentMessage.collapse": { en: "Collapse", zh: "收起" },
  "agentMessage.locate": { en: "Show in timeline", zh: "在时间线中查看" },
  "agentMessage.view": { en: "View", zh: "查看" },
  "agentMessage.readFailed": {
    en: "Could not mark the message as read: {0}",
    zh: "无法将消息标为已读：{0}",
  },
  "timeline.earlierMessages": { en: "Earlier messages", zh: "更早的消息" },
  "media.open": { en: "Open full size", zh: "查看原图" },
  "media.gone": {
    en: "no longer kept in the audit",
    zh: "已不在审计记录中",
  },
  "step.messaged": { en: "Sent you a message", zh: "给你发了一条消息" },
  "step.messagedMany": {
    en: "Sent you {0} messages",
    zh: "给你发了 {0} 条消息",
  },
  "live.message": { en: "Sending you a message", zh: "正在给你发消息" },
  "notification.newMessage": {
    en: "Conversation {0} has a new message from ChatGPT. Click to view.",
    zh: "对话 {0} 收到 ChatGPT 的新消息，点击查看。",
  },
  "notification.messageTitle": {
    en: "EXEC MCP · Message",
    zh: "EXEC MCP · 新消息",
  },
  "sidebar.message": { en: "Says: {0}", zh: "消息：{0}" },
  "sidebar.messageUnread": { en: "1 unread message", zh: "1 条未读消息" },
  "sidebar.messagesUnread": {
    en: "{0} unread messages",
    zh: "{0} 条未读消息",
  },
  "app.title": { en: "EXEC MCP Console", zh: "EXEC MCP 控制台" },
  "app.checkingAuth": {
    en: "Checking console access…",
    zh: "正在检查控制台访问权限…",
  },

  "common.back": { en: "Back", zh: "返回" },
  "common.clear": { en: "Clear", zh: "清除" },
  "common.close": { en: "Close", zh: "关闭" },
  "common.copied": { en: "Copied", zh: "已复制" },
  "common.copy": { en: "Copy", zh: "复制" },
  "common.copyFailed": { en: "Copy failed", zh: "复制失败" },
  "common.disabled": { en: "Disabled", zh: "已停用" },
  "common.loading": { en: "Loading…", zh: "正在读取…" },
  "common.more": { en: "More", zh: "更多" },
  "common.next": { en: "Next", zh: "下一个" },
  "common.previous": { en: "Previous", zh: "上一个" },
  "common.refresh": { en: "Refresh", zh: "刷新" },
  "common.retry": { en: "Retry", zh: "重试" },
  "common.saving": { en: "Saving…", zh: "保存中…" },
  "common.stopped": { en: "Terminated", zh: "已终止" },

  "unit.ms": { en: "{0} ms", zh: "{0} ms" },
  "unit.s": { en: "{0} s", zh: "{0} 秒" },
  "unit.min": { en: "{0}m {1}s", zh: "{0} 分 {1} 秒" },
  "unit.h": { en: "{0}h {1}m", zh: "{0} 小时 {1} 分" },
  "time.now": { en: "now", zh: "刚刚" },
  "time.justNow": { en: "just now", zh: "刚刚" },
  "time.minutesAgo": { en: "{0} min ago", zh: "{0} 分钟前" },
  "time.hoursAgo": { en: "{0} h ago", zh: "{0} 小时前" },
  "time.daysAgo": { en: "{0} d ago", zh: "{0} 天前" },
  "time.today": { en: "Today", zh: "今天" },
  "time.yesterday": { en: "Yesterday", zh: "昨天" },

  "language.label": { en: "Language", zh: "界面语言" },
  "language.auto": { en: "Auto", zh: "自动" },
  "language.help": {
    en: "Auto follows your browser. Changes apply immediately.",
    zh: "自动跟随浏览器语言，切换立即生效。",
  },
  "theme.light": { en: "Light", zh: "浅色" },
  "theme.dark": { en: "Dark", zh: "深色" },
  "theme.system": { en: "Match system", zh: "跟随系统" },

  "auth.title": { en: "Sign in to this machine", zh: "登录这台机器" },
  "auth.help": {
    en: "Enter the Web access key from the server's startup log, or open the LAN link that contains #token=….",
    zh: "输入服务启动日志中的访问密钥，或直接打开带 #token=… 的局域网链接。",
  },
  "auth.remember": {
    en: "This browser stays signed in while you use the console and expires after 30 days without a visit. Signing out, clearing cookies or rotating the token requires signing in again.",
    zh: "登录后此浏览器会保持登录，连续 30 天未访问才过期。退出登录、清除 Cookie 或更换密钥后需要重新登录。",
  },
  "auth.boundary": {
    en: "This machine's own browser needs no token. LAN access must be enabled in the configuration.",
    zh: "本机浏览器访问无需密钥；局域网访问需要在配置中开启。",
  },
  "auth.token": { en: "Web access key", zh: "访问密钥" },
  "auth.placeholder": { en: "Paste the Web access key", zh: "粘贴访问密钥" },
  "auth.invalid": {
    en: "The Web access key is invalid or has been rotated. Check the server startup log.",
    zh: "密钥不正确或已更换，请查看服务启动日志中的访问密钥。",
  },
  "auth.verifying": { en: "Verifying…", zh: "验证中…" },
  "auth.unlock": { en: "Sign in", zh: "登录" },
  "header.logout": { en: "Sign out", zh: "退出登录" },

  "nav.activity": { en: "All activity", zh: "全部活动" },
  "nav.processes": { en: "Processes", zh: "进程" },
  "nav.tools": { en: "Tools", zh: "工具" },
  "nav.files": { en: "Files", zh: "导出文件" },
  "nav.settings": { en: "Settings", zh: "设置" },

  "sidebar.thisMachine": { en: "This machine", zh: "本机" },
  "sidebar.machine": { en: "This machine", zh: "本机" },
  "sidebar.search": { en: "Find a conversation", zh: "查找对话" },
  "sidebar.conversations": { en: "Conversations", zh: "对话" },
  "sidebar.empty": { en: "No conversations yet.", zh: "还没有对话。" },
  "sidebar.noMatches": {
    en: "No conversations match.",
    zh: "没有匹配的对话。",
  },
  "sidebar.noCalls": { en: "No calls yet", zh: "尚无调用" },
  "sidebar.asking": { en: "Asks: {0}", zh: "提问：{0}" },
  "sidebar.questionsWaiting": {
    en: "{0} questions waiting",
    zh: "{0} 个问题待回答",
  },
  "sidebar.questionWaiting": { en: "1 question waiting", zh: "1 个问题待回答" },
  "sidebar.queuedNotes": {
    en: "{0} messages queued",
    zh: "{0} 条消息排队中",
  },
  "sidebar.queuedNote": { en: "1 message queued", zh: "1 条消息排队中" },

  "connection.live": { en: "Live", zh: "实时" },
  "connection.connecting": { en: "Connecting", zh: "连接中" },
  "connection.offline": { en: "Reconnecting", zh: "重连中" },
  "connection.lost": {
    en: "Lost the connection to this machine. Reconnecting…",
    zh: "与这台机器的连接已断开，正在重连…",
  },

  "home.title": { en: "Waiting for ChatGPT", zh: "等待 ChatGPT" },
  "home.body": {
    en: "Conversations appear here as soon as ChatGPT uses this machine. Watch each step, answer its questions and send it messages while it works.",
    zh: "ChatGPT 一旦使用这台机器，对话就会出现在这里。你可以实时查看每一步、回答它的问题，并在它工作时给它发消息。",
  },
  "home.step1": {
    en: "Connect ChatGPT to this machine's MCP endpoint.",
    zh: "把 ChatGPT 连接到这台机器的 MCP 地址。",
  },
  "home.step2": {
    en: "Ask it to work on something here, such as running a project's tests.",
    zh: "让它在这里做点事，比如运行某个项目的测试。",
  },
  "home.step3": {
    en: "Follow along live, and step in with a message whenever you need to.",
    zh: "实时查看进展，需要时随时发消息介入。",
  },
  "home.endpoint": { en: "MCP endpoint", zh: "MCP 地址" },

  "shortcuts.title": { en: "Keyboard shortcuts", zh: "键盘快捷键" },
  "shortcuts.steps": { en: "Move between calls", zh: "在调用之间移动" },
  "shortcuts.expand": {
    en: "Open or close the selected call",
    zh: "展开或收起选中的调用",
  },
  "shortcuts.compose": { en: "Write a message", zh: "写消息" },
  "shortcuts.answer": { en: "Pick an answer option", zh: "选择答案选项" },
  "shortcuts.search": { en: "Find a conversation", zh: "查找对话" },
  "shortcuts.find": {
    en: "Search this conversation",
    zh: "搜索当前对话",
  },
  "shortcuts.conversations": {
    en: "Previous or next conversation",
    zh: "上一个或下一个对话",
  },
  "shortcuts.toggle": { en: "Show this list", zh: "显示此列表" },

  "runtime.pending": {
    en: "Configuration saved. Restart the execution service to apply it.",
    zh: "配置已保存，重启执行服务后生效。",
  },
  "runtime.reloading": {
    en: "Restarting the execution service…",
    zh: "正在重启执行服务…",
  },
  "runtime.applied": {
    en: "The running configuration is current",
    zh: "运行配置已是最新",
  },
  "runtime.help": {
    en: "Restarting reloads MCP servers and Skills, and clears scripts, terminals, store data and export links. Messages, questions and names are kept.",
    zh: "重启会重新加载 MCP 服务和 Skills，并清空脚本、终端、store 数据和导出链接；消息、问题和对话名称会保留。",
  },
  "runtime.restart": { en: "Restart", zh: "重启" },
  "runtime.confirmRestart": {
    en: "Click again to restart",
    zh: "再次点击以重启",
  },
  "runtime.retry": {
    en: "Fix the problem, then restart again.",
    zh: "修正问题后可再次重启。",
  },
  "runtime.webClosing": {
    en: "Restarting will close this console. To turn it back on, edit the configuration and start the service from a terminal.",
    zh: "重启后会关闭此控制台；如需重新开启，请编辑配置并从终端启动服务。",
  },

  "conversation.untitled": { en: "Untitled conversation", zh: "未命名对话" },
  "conversation.unscoped": {
    en: "Unidentified calls",
    zh: "未识别对话的调用",
  },
  "conversation.unscopedHelp": {
    en: "These calls arrived without a ChatGPT conversation ID, so they can't be grouped or receive messages.",
    zh: "这些调用没有携带 ChatGPT 对话标识，无法归组，也无法接收消息。",
  },
  "conversation.rename": { en: "Rename", zh: "重命名" },
  "conversation.label": { en: "Conversation name", zh: "对话名称" },
  "conversation.labelPlaceholder": {
    en: "Name this conversation",
    zh: "给这个对话起个名字",
  },
  "conversation.labelTooLong": {
    en: "Names can be at most 256 bytes.",
    zh: "名称最多 256 字节。",
  },
  "conversation.calls": { en: "{0} calls", zh: "{0} 次调用" },
  "conversation.call": { en: "1 call", zh: "1 次调用" },
  "conversation.process": { en: "Process running: {0}", zh: "进程运行中：{0}" },
  "conversation.failed": { en: "{0} failed", zh: "{0} 次失败" },
  "conversation.processes": {
    en: "{0} processes running",
    zh: "{0} 个进程在运行",
  },
  "conversation.search": {
    en: "Search this conversation",
    zh: "搜索这个对话",
  },
  "conversation.filter": { en: "Show", zh: "显示" },
  "conversation.filterAll": { en: "All", zh: "全部" },
  "conversation.filterErrors": { en: "Failures", zh: "失败" },
  "conversation.copyId": {
    en: "Copy conversation ID",
    zh: "复制对话 ID",
  },

  "state.asking": {
    en: "{0} questions waiting for you",
    zh: "{0} 个问题等你回答",
  },
  "state.askingOne": {
    en: "1 question waiting for you",
    zh: "1 个问题等你回答",
  },
  "state.working": { en: "Working", zh: "正在工作" },
  "state.background": {
    en: "Script running in the background",
    zh: "脚本在后台运行",
  },
  "state.backgroundCells": {
    en: "{0} scripts running in the background",
    zh: "{0} 个脚本在后台运行",
  },
  "state.idle": { en: "Idle", zh: "空闲" },
  "state.idleSince": {
    en: "Idle · last active {0}",
    zh: "空闲 · 最近活动于 {0}",
  },
  "state.failed": { en: "Failed", zh: "失败" },
  "state.stopped": { en: "Stopped", zh: "已终止" },

  "status.running": { en: "Running", zh: "运行中" },
  "status.completed": { en: "Script completed", zh: "脚本完成" },
  "status.yielding": { en: "Script still running", zh: "脚本仍在运行" },
  "status.failed": { en: "Script failed", zh: "脚本失败" },
  "status.exited": {
    en: "Process exited; output pending",
    zh: "进程已退出，输出待取",
  },
  "status.terminal": {
    en: "Terminal running or output pending",
    zh: "终端运行或输出待取",
  },
  "calls.completed": { en: "Call completed", zh: "调用完成" },
  "calls.open": { en: "View {0} call details", zh: "查看 {0} 调用详情" },
  "detail.failed": { en: "Error or nonzero exit", zh: "报错或非零退出" },

  "step.ran": { en: "Ran", zh: "运行" },
  "step.ranScript": { en: "Ran script", zh: "运行脚本" },
  "step.typed": { en: "Typed", zh: "输入" },
  "step.readTerminal": { en: "Read output of", zh: "读取输出" },
  "step.edited": { en: "Edited", zh: "修改" },
  "step.asked": { en: "Asked you", zh: "向你提问" },
  "step.viewedImage": { en: "Viewed", zh: "查看图片" },
  "step.exported": { en: "Exported", zh: "导出" },
  "step.imported": { en: "Imported to", zh: "导入到" },
  "step.listedSkills": { en: "Listed Skills", zh: "列出 Skills" },
  "step.listedSkillsIn": { en: "Listed Skills in", zh: "列出 Skills：" },
  "step.readResource": { en: "Read", zh: "读取" },
  "step.listedResources": {
    en: "Listed MCP resources",
    zh: "列出 MCP 资源",
  },
  "step.called": { en: "Called", zh: "调用" },
  "step.checked": { en: "Checked on", zh: "查看进度" },
  "step.stopped": { en: "Stopped", zh: "终止" },
  "live.command": { en: "Running", zh: "正在运行" },
  "live.stdin": { en: "Working in terminal", zh: "正在操作终端" },
  "live.patch": { en: "Editing", zh: "正在修改" },
  "live.question": { en: "Asking you", zh: "正在向你提问" },
  "live.image": { en: "Viewing", zh: "正在查看图片" },
  "live.export": { en: "Exporting", zh: "正在导出" },
  "live.import": { en: "Importing to", zh: "正在导入到" },
  "live.skills": { en: "Listing Skills", zh: "正在列出 Skills" },
  "live.resource": { en: "Reading", zh: "正在读取" },
  "live.tool": { en: "Calling", zh: "正在调用" },
  "step.askedOne": { en: "Asked you a question", zh: "向你提了一个问题" },
  "step.askedMany": {
    en: "Asked you {0} questions",
    zh: "向你提了 {0} 个问题",
  },
  "step.more": { en: "+{0}", zh: "+{0}" },
  "step.inBackground": {
    en: "Still running in the background ({0})",
    zh: "仍在后台运行（{0}）",
  },
  "step.finishedLater": {
    en: "Finished at {0} after {1} checks",
    zh: "经过 {1} 次查看，于 {0} 结束",
  },
  "step.finishedLaterOne": {
    en: "Finished at {0} after {1} check",
    zh: "经过 {1} 次查看，于 {0} 结束",
  },
  "step.resumes": {
    en: "Continues the {0} script",
    zh: "接续 {0} 的脚本",
  },
  "step.carried": {
    en: "Delivered {0} of your messages",
    zh: "送达了你的 {0} 条消息",
  },
  "step.carriedOne": { en: "Delivered your message", zh: "送达了你的消息" },

  "kind.command": { en: "Command", zh: "命令" },
  "kind.stdin": { en: "Terminal", zh: "终端" },
  "kind.patch": { en: "Patch", zh: "补丁" },
  "kind.question": { en: "Question", zh: "提问" },
  "kind.image": { en: "Image", zh: "图片" },
  "kind.export": { en: "Export", zh: "导出" },
  "kind.import": { en: "Import", zh: "导入" },
  "kind.skills": { en: "Skills", zh: "Skills" },
  "kind.resource": { en: "Resource", zh: "资源" },
  "kind.mcp": { en: "MCP", zh: "MCP" },
  "kind.tool": { en: "Tool", zh: "工具" },

  "timeline.earlier": {
    en: "Show {0} earlier calls",
    zh: "显示更早的 {0} 次调用",
  },
  "timeline.earlierOne": {
    en: "Show 1 earlier call",
    zh: "显示更早的 1 次调用",
  },
  "timeline.empty": {
    en: "Nothing here yet. Calls, questions and your messages will appear in order.",
    zh: "这里还没有内容。调用、提问和你的消息会按时间顺序出现。",
  },
  "timeline.noMatches": { en: "No calls match.", zh: "没有匹配的调用。" },
  "timeline.newEntries": { en: "{0} new", zh: "{0} 条新内容" },

  "detail.loadFailed": {
    en: "Could not load this call: {0}",
    zh: "读取调用失败：{0}",
  },
  "detail.script": { en: "Script", zh: "脚本" },
  "detail.noToolsYet": { en: "No tool calls yet", zh: "尚未调用工具" },
  "detail.request": { en: "Request", zh: "请求" },
  "detail.returned": { en: "Returned to ChatGPT", zh: "返回给 ChatGPT" },
  "detail.returnedError": {
    en: "Returned to ChatGPT as an error",
    zh: "作为错误返回给 ChatGPT",
  },
  "detail.noOutput": { en: "No output", zh: "没有输出" },
  "detail.noteDelivered": {
    en: "Your message, delivered with this response",
    zh: "你的消息，随本次响应送达",
  },
  "detail.error": { en: "Error", zh: "错误" },
  "detail.files": { en: "{0} attached files", zh: "{0} 个附件" },
  "detail.file": { en: "1 attached file", zh: "1 个附件" },
  "detail.omitted": {
    en: "{0} nested calls in the middle were not kept; the earliest and latest are shown.",
    zh: "中间有 {0} 条内部调用未保留，这里显示最早和最新的记录。",
  },
  "detail.truncated": {
    en: "Parts of this audit copy were shortened. The call itself was not affected.",
    zh: "审计副本有部分内容被截短，实际调用不受影响。",
  },

  "nested.exit": { en: "exit {0}", zh: "退出码 {0}" },
  "nested.failed": { en: "Failed", zh: "失败" },
  "nested.running": { en: "Running", zh: "运行中" },
  "nested.unfinished": { en: "Did not finish", zh: "未完成" },
  "nested.outputLater": {
    en: "Output appears here when the command returns.",
    zh: "命令返回后，输出会显示在这里。",
  },
  "nested.noOutput": { en: "No output", zh: "没有输出" },
  "nested.stillRunning": {
    en: "Still running as {0}",
    zh: "仍在运行：{0}",
  },
  "nested.omittedBytes": {
    en: "{0} of log dropped in the middle",
    zh: "日志中间丢弃了 {0}",
  },
  "nested.input": { en: "Input", zh: "输入" },
  "nested.output": { en: "Output", zh: "输出" },
  "nested.toolError": {
    en: "The tool reported an error",
    zh: "工具返回了错误",
  },

  "code.expand": { en: "Show all {0} lines", zh: "展开全部 {0} 行" },
  "code.collapse": { en: "Show less", zh: "收起" },
  "code.omitted": {
    en: "{0} characters omitted from the audit copy",
    zh: "审计副本省略了 {0} 个字符",
  },
  "diff.add": { en: "Added", zh: "新增" },
  "diff.update": { en: "Modified", zh: "修改" },
  "diff.delete": { en: "Deleted", zh: "删除" },

  "composer.label": { en: "Message to ChatGPT", zh: "发给 ChatGPT 的消息" },
  "composer.placeholder": {
    en: "Message ChatGPT in this conversation…",
    zh: "给这个对话里的 ChatGPT 发消息…",
  },
  "composer.send": { en: "Send message", zh: "发送消息" },
  "composer.keys": { en: "↵ send · ⇧↵ new line", zh: "↵ 发送 · ⇧↵ 换行" },
  "composer.working": {
    en: "ChatGPT is working. Your message arrives with its next tool response.",
    zh: "ChatGPT 正在工作，消息会随它的下一次工具响应送达。",
  },
  "composer.recent": {
    en: "ChatGPT was active moments ago. Your message goes out with its next tool response.",
    zh: "ChatGPT 刚刚还在活动，消息会随它的下一次工具响应送达。",
  },
  "composer.idle": {
    en: "ChatGPT isn't using tools right now. The message waits for its next tool call.",
    zh: "ChatGPT 当前没有调用工具，消息会等到它下一次调用工具时送达。",
  },
  "composer.copy": {
    en: "Copy to paste in ChatGPT",
    zh: "复制，去 ChatGPT 粘贴",
  },
  "composer.unavailable": {
    en: "These calls can't receive messages",
    zh: "这些调用无法接收消息",
  },
  "composer.unavailableHelp": {
    en: "Only calls that carry a ChatGPT conversation ID can receive messages.",
    zh: "只有携带 ChatGPT 对话标识的调用才能接收消息。",
  },

  "note.queued": {
    en: "Queued for the next tool response",
    zh: "排队中，随下一次工具响应送达",
  },
  "note.delivered": { en: "Delivered", zh: "已送达" },
  "note.deliveredWith": {
    en: "Delivered with the {0} call",
    zh: "已随 {0} 的调用送达",
  },
  "note.withdraw": { en: "Withdraw", zh: "撤回" },
  "note.withdrawn": { en: "Withdrawn", zh: "已撤回" },
  "note.copy": { en: "Copy message", zh: "复制消息" },
  "notes.alreadyAttached": {
    en: "This message was already delivered.",
    zh: "这条消息已经送达。",
  },
  "notes.alreadyWithdrawn": {
    en: "This message was withdrawn. Type it again to send it as a new message.",
    zh: "这条消息已撤回，如需发送请重新输入。",
  },
  "notes.sendFailed": {
    en: "Not confirmed: {0}. Your text is kept, and sending the same text again won't duplicate it.",
    zh: "发送未确认：{0}。内容已保留，重发相同内容不会重复。",
  },

  "dock.label": { en: "Questions from ChatGPT", zh: "ChatGPT 的提问" },
  "dock.title": {
    en: "ChatGPT is waiting for your answer",
    zh: "ChatGPT 在等你回答",
  },
  "dock.position": { en: "{0} of {1}", zh: "第 {0} / {1} 个" },
  "dock.delivery": {
    en: "Your answer goes out with ChatGPT's next tool response.",
    zh: "答复会随 ChatGPT 的下一次工具响应送达。",
  },
  "dock.notify": { en: "Notify me next time", zh: "下次提醒我" },
  "dock.collapse": {
    en: "Minimize while you read the conversation",
    zh: "先收起，查看对话内容",
  },

  "question.asked": { en: "ChatGPT asked", zh: "ChatGPT 问" },
  "question.askedPending": { en: "ChatGPT is asking", zh: "ChatGPT 正在问" },
  "question.answerNow": { en: "Answer", zh: "回答" },
  "question.waiting": { en: "Waiting for you", zh: "等你回答" },
  "question.legend": { en: "Choose an answer to {0}", zh: "选择答案：{0}" },
  "question.none": { en: "None of the above", zh: "以上都不是" },
  "question.recommended": { en: "Recommended", zh: "推荐" },
  "question.required": {
    en: "Your answer (required)",
    zh: "你的回答（必填）",
  },
  "question.optional": {
    en: "Additional note (optional)",
    zh: "补充说明（可选）",
  },
  "question.customPlaceholder": {
    en: "Write your own answer…",
    zh: "写下你自己的答案…",
  },
  "question.notePlaceholder": {
    en: "Add a note (optional)",
    zh: "补充说明（可选）",
  },
  "question.bytes": {
    en: "Answer size {0} / {1} bytes",
    zh: "答复大小 {0} / {1} 字节",
  },
  "question.submit": { en: "Send answer", zh: "发送答复" },
  "question.saved": {
    en: "Answer queued. It goes out with ChatGPT's next tool response.",
    zh: "答复已排队，会随 ChatGPT 的下一次工具响应送达。",
  },
  "question.previousWithdrawn": {
    en: "This answer had been withdrawn. You can answer again.",
    zh: "这份答复已撤回，可以重新作答。",
  },
  "question.submitFailed": {
    en: "Not confirmed: {0}. Your draft is kept, and retrying won't submit it twice.",
    zh: "提交未确认：{0}。草稿已保留，重试不会重复提交。",
  },
  "question.selectAgain": {
    en: "Your previous answer was withdrawn. Choose again.",
    zh: "上一份答复已撤回，请重新选择。",
  },
  "question.queued": {
    en: "Queued for the next tool response",
    zh: "排队中，随下一次工具响应送达",
  },
  "question.expired": { en: "Answer record expired", zh: "答复记录已过期" },
  "question.copy": { en: "Copy answer", zh: "复制答复" },
  "question.withdraw": { en: "Withdraw", zh: "撤回" },
  "question.conflict": {
    en: "This question was answered elsewhere. Your unsent draft is kept; copy it into a message if it still matters.",
    zh: "这个问题已在别处回答。你的草稿仍保留，如仍需要可复制后作为消息发送。",
  },
  "question.copyDraft": { en: "Copy draft", zh: "复制草稿" },
  "question.discard": { en: "Discard draft", zh: "丢弃草稿" },

  "notification.label": { en: "Conversation notifications", zh: "对话通知" },
  "notification.default": {
    en: "Get a system notification when ChatGPT asks a question or sends you a message.",
    zh: "ChatGPT 提问或发来消息时，通过系统通知提醒你。",
  },
  "notification.enabled": {
    en: "On. Clicking a notification opens the conversation.",
    zh: "已开启。点击通知即可打开对应对话。",
  },
  "notification.paused": {
    en: "Paused in this browser.",
    zh: "此浏览器已暂停对话通知。",
  },
  "notification.denied": {
    en: "Notifications are blocked. Allow them in the browser's site settings.",
    zh: "浏览器已禁止通知，可在网站设置中改为允许。",
  },
  "notification.insecure": {
    en: "System notifications need localhost, 127.0.0.1 or HTTPS.",
    zh: "系统通知需要在 localhost、127.0.0.1 或 HTTPS 下使用。",
  },
  "notification.unsupported": {
    en: "This browser can't show page notifications. Questions and messages still appear in the console.",
    zh: "此浏览器不支持页面通知，问题和消息仍会显示在控制台中。",
  },
  "notification.error": {
    en: "The notification could not be shown. Check browser and system notification settings, then retry.",
    zh: "通知未能显示；请检查浏览器及系统通知设置后重试。",
  },
  "notification.requesting": {
    en: "Waiting for permission…",
    zh: "等待授权…",
  },
  "notification.enable": { en: "Enable", zh: "启用通知" },
  "notification.pause": { en: "Pause", zh: "暂停通知" },
  "notification.retry": { en: "Retry", zh: "重试" },
  "notification.test": { en: "Send a test", zh: "测试通知" },
  "notification.help": {
    en: "Keep this page open. Notifications omit message content; closed pages get no push, and Do Not Disturb may hide alerts.",
    zh: "请保持页面打开。通知不展示消息正文；页面关闭后没有推送，勿扰模式可能隐藏提醒。",
  },
  "notification.testBody": {
    en: "Test notification. New questions will appear like this.",
    zh: "这是一条测试通知，新问题会这样提醒你。",
  },
  "notification.newQuestions": {
    en: "Conversation {0} · New questions: {1}. Click to answer.",
    zh: "对话 {0} 有 {1} 个新问题，点击作答。",
  },
  "notification.title": {
    en: "EXEC MCP · Question alert",
    zh: "EXEC MCP · 提问提醒",
  },

  "activity.title": { en: "All activity", zh: "全部活动" },
  "activity.description": {
    en: "Every call from every conversation, newest first. Retained in memory: {0}.",
    zh: "所有对话的全部调用，最新的在前。内存中保留了 {0} 次调用。",
  },
  "activity.search": {
    en: "Search commands, code, output or IDs",
    zh: "搜索命令、代码、输出或 ID",
  },
  "activity.status": { en: "Status", zh: "状态" },
  "activity.all": { en: "All", zh: "全部" },
  "activity.running": { en: "Running", zh: "运行中" },
  "activity.background": { en: "Background", zh: "后台运行" },
  "activity.failed": { en: "Failed", zh: "失败" },
  "activity.stopped": { en: "Stopped", zh: "已终止" },
  "activity.clear": { en: "Clear history", zh: "清空记录" },
  "activity.clearConfirm": {
    en: "Click again to clear",
    zh: "再次点击以清空",
  },
  "activity.clearFailed": {
    en: "Could not clear history: {0}",
    zh: "清空失败：{0}",
  },
  "activity.empty": { en: "No calls yet", zh: "还没有调用" },
  "activity.emptyHelp": {
    en: "Calls appear here as soon as ChatGPT runs something on this machine.",
    zh: "ChatGPT 在这台机器上执行操作后，调用会立即出现在这里。",
  },
  "activity.noMatches": { en: "No calls match", zh: "没有匹配的调用" },
  "activity.more": { en: "Load {0} more", zh: "再加载 {0} 条" },

  "processes.title": { en: "Processes", zh: "进程" },
  "processes.description": {
    en: "What ChatGPT has left running on this machine, and the Code Mode memory it holds.",
    zh: "ChatGPT 在这台机器上留下的运行中进程，以及 Code Mode 占用的内存。",
  },
  "processes.commands": { en: "Commands", zh: "命令进程" },
  "processes.terminalsHelp": {
    en: "Started by tools.exec_command. Each keeps a bounded rolling log until it is read.",
    zh: "由 tools.exec_command 启动，每个进程都保留有界的滚动日志，直到被读取。",
  },
  "processes.noTerminals": {
    en: "Nothing is running",
    zh: "没有运行中的进程",
  },
  "processes.noTerminalsHelp": {
    en: "Commands that keep running after their call returns stay here until they exit and their output is read.",
    zh: "调用返回后仍在运行的命令会留在这里，直到退出且输出被读取。",
  },
  "processes.running": { en: "Running", zh: "运行中" },
  "processes.exitedHelp": {
    en: "Exited. The record is released after an idle period; running processes are never released.",
    zh: "已退出，空闲期满后释放记录；运行中的进程不会被释放。",
  },
  "processes.unread": { en: "Unread log", zh: "未读日志" },
  "processes.dropped": {
    en: "{0} dropped from the middle of the log",
    zh: "日志中间丢弃了 {0}",
  },
  "processes.sessions": { en: "Code Mode sessions", zh: "Code Mode 会话" },
  "processes.sessionsHelp": {
    en: "One per conversation, holding store data and unfinished cells. Idle sessions are kept for {0} hours.",
    zh: "每个对话一个，保存 store 数据和未收尾的 cell；空闲会话保留 {0} 小时。",
  },
  "processes.noSessions": {
    en: "No Code Mode sessions",
    zh: "没有 Code Mode 会话",
  },
  "processes.noSessionsHelp": {
    en: "Each ChatGPT conversation gets a session the first time it runs a script.",
    zh: "每个 ChatGPT 对话首次运行脚本时会创建一个会话。",
  },
  "processes.unscopedSession": {
    en: "Session without a conversation",
    zh: "未归属对话的会话",
  },
  "processes.busy": { en: "In use", zh: "使用中" },
  "processes.idle": { en: "Idle for {0}", zh: "已空闲 {0}" },
  "processes.reclaimed": { en: "Reclaimed", zh: "已回收" },
  "processes.cells": { en: "{0} unfinished cells", zh: "{0} 个未收尾 cell" },
  "processes.cell": { en: "1 unfinished cell", zh: "1 个未收尾 cell" },
  "processes.reclaimedMemory": {
    en: "Reclaimed under memory pressure. Its cells and store data are gone.",
    zh: "因内存压力被回收，其中的 cell 和 store 数据已丢失。",
  },
  "processes.released": {
    en: "Finished and released.",
    zh: "已结束并释放。",
  },
  "processes.oldestIdle": {
    en: "Oldest idle session; the first to be reclaimed above the high-water mark.",
    zh: "最早空闲的会话；超过高水位时最先被回收。",
  },
  "processes.idlePolicy": {
    en: "Idle. Kept for {0} hours; under memory pressure, idle sessions are reclaimed first.",
    zh: "空闲中，保留 {0} 小时；内存紧张时优先回收空闲会话。",
  },
  "processes.oldestActive": {
    en: "Least recently used active session. Reclaimed only if memory stays high with no idle sessions left.",
    zh: "最久未用的活动会话；只有没有空闲会话且内存持续偏高时才会被回收。",
  },
  "processes.activePolicy": {
    en: "In use by a running or unfinished cell, so idle expiry does not apply.",
    zh: "正被运行中或未收尾的 cell 使用，不参与空闲过期。",
  },
  "processes.memory": { en: "Code Mode memory", zh: "Code Mode 内存" },
  "processes.memoryHelp": {
    en: "Resident memory of the shared Code Mode host, sampled periodically.",
    zh: "共享 Code Mode 宿主的常驻内存，定期采样。",
  },
  "processes.unsampled": { en: "Not sampled", zh: "未采样" },
  "memory.normal": { en: "Normal", zh: "正常" },
  "memory.elevated": { en: "Elevated", zh: "偏高" },
  "memory.exceeded": {
    en: "Over the high-water mark",
    zh: "已超过高水位",
  },
  "memory.order": {
    en: "Above the high-water mark, idle sessions are reclaimed first, in the order they became idle; then the least recently used active session.",
    zh: "超过高水位时，先按进入空闲的先后回收空闲会话，再回收最久未用的活动会话。",
  },

  "tools.title": { en: "Tools", zh: "工具" },
  "tools.description": {
    en: "Downstream MCP servers and Skills available to ChatGPT on this machine.",
    zh: "ChatGPT 在这台机器上可用的下游 MCP 服务和 Skills。",
  },
  "tools.mcp": { en: "MCP servers", zh: "MCP 服务" },
  "tools.skills": { en: "Skills", zh: "Skills" },
  "tools.servers": { en: "Servers", zh: "服务" },
  "tools.serversHelp": {
    en: "Enabled servers connect and load their tools before the service reports ready.",
    zh: "启用的服务会在执行服务就绪前完成连接并加载工具。",
  },
  "tools.noServers": {
    en: "No MCP servers configured",
    zh: "没有配置 MCP 服务",
  },
  "tools.noServersHelp": {
    en: "Add servers under mcp_servers in config.toml.",
    zh: "在 config.toml 的 mcp_servers 中添加服务。",
  },
  "tools.notLoaded": { en: "Not loaded", zh: "未加载" },
  "tools.toolCount": { en: "{0} tools", zh: "{0} 个工具" },
  "tools.toolCountOne": { en: "1 tool", zh: "1 个工具" },
  "tools.enableServer": { en: "Enable {0}", zh: "启用 {0}" },
  "tools.args": {
    en: "({0} arguments hidden)",
    zh: "（{0} 个参数已隐藏）",
  },
  "tools.cwd": { en: "Directory", zh: "目录" },
  "tools.env": { en: "Environment", zh: "环境变量" },
  "tools.headers": { en: "Headers", zh: "请求头" },
  "tools.tokenEnv": { en: "Bearer token from", zh: "Bearer 令牌来自" },
  "tools.selected": { en: "Selected tools:", zh: "指定工具：" },
  "tools.catalog": { en: "Loaded tools ({0})", zh: "已加载的工具（{0}）" },
  "tools.catalogHelp": {
    en: "The catalog the next exec sees in ALL_TOOLS. Expand a tool to read its full contract.",
    zh: "下一次 exec 在 ALL_TOOLS 中看到的目录；展开可查看完整契约。",
  },
  "tools.filter": {
    en: "Filter by name or description",
    zh: "按名称或描述筛选",
  },
  "tools.noMatches": { en: "No tools match.", zh: "没有匹配的工具。" },
  "tools.noTools": {
    en: "No downstream tools are loaded.",
    zh: "没有加载下游工具。",
  },
  "tools.otherTools": { en: "Other", zh: "其他" },

  "skills.title": { en: "Skills ({0})", zh: "Skills（{0}）" },
  "skills.help": {
    en: "Discovered Skills, including disabled ones. Switches apply after a restart.",
    zh: "已发现的 Skill，包括已停用的；开关在重启后生效。",
  },
  "skills.budget": { en: "Catalog budget", zh: "目录预算" },
  "skills.directory": { en: "Project directory", zh: "项目目录" },
  "skills.placeholder": {
    en: "Optional project directory to include its Skills",
    zh: "可选：填入项目目录以包含项目级 Skill",
  },
  "skills.view": { en: "Scan", zh: "扫描" },
  "skills.warnings": { en: "Discovery warnings", zh: "发现过程提示" },
  "skills.empty": { en: "No Skills found here.", zh: "这里没有找到 Skill。" },
  "skills.explicit": { en: "Explicit only", zh: "仅显式调用" },
  "skills.explicitHelp": {
    en: "Read only when you ask for it by name; its trigger description is hidden from the model.",
    zh: "只有你点名要求时才读取；触发描述不向模型公开。",
  },
  "skills.enable": { en: "Enable Skill {0}", zh: "启用 Skill {0}" },

  "files.title": { en: "Exported files", zh: "导出文件" },
  "files.description": {
    en: "Snapshots exported with tools.export_file. They expire on their own; revoking one invalidates its link now.",
    zh: "通过 tools.export_file 导出的文件快照，会自动过期；撤销可让链接立即失效。",
  },
  "files.empty": { en: "No exported files", zh: "没有导出文件" },
  "files.emptyHelp": {
    en: "When ChatGPT exports a file from this machine, it appears here until it expires.",
    zh: "ChatGPT 从这台机器导出文件后，文件会显示在这里直到过期。",
  },
  "files.name": { en: "Name", zh: "名称" },
  "files.size": { en: "Size", zh: "大小" },
  "files.type": { en: "Type", zh: "类型" },
  "files.expiresIn": { en: "Expires in {0}", zh: "{0} 后过期" },
  "files.expired": { en: "Expired", zh: "已过期" },
  "files.revoke": { en: "Revoke", zh: "撤销" },
  "files.revokeConfirm": {
    en: "Click again to revoke",
    zh: "再次点击以撤销",
  },
  "files.revokeFailed": {
    en: "Could not revoke: {0}",
    zh: "撤销失败：{0}",
  },

  "settings.title": { en: "Settings", zh: "设置" },
  "settings.interface": { en: "Interface", zh: "界面" },
  "settings.theme": { en: "Theme", zh: "主题" },
  "settings.execution": { en: "Execution service", zh: "执行服务" },
  "settings.executionHelp": {
    en: "Switches are saved to config.toml and apply after a restart.",
    zh: "开关会保存到 config.toml，重启后生效。",
  },
  "settings.access": { en: "Console access", zh: "控制台访问" },
  "settings.rotateConfirm": {
    en: "Click again to rotate",
    zh: "再次点击以更换",
  },
  "settings.rotated": {
    en: "Token rotated. Other browsers must sign in again.",
    zh: "密钥已更换，其他浏览器需要重新登录。",
  },
  "settings.rotateFailed": {
    en: "Could not rotate the token: {0}",
    zh: "更换密钥失败：{0}",
  },
  "settings.configuration": { en: "Configuration", zh: "配置" },
  "settings.revealFailed": {
    en: "Could not open the folder: {0}",
    zh: "无法打开文件夹：{0}",
  },
  "settings.history": { en: "Call history", zh: "调用记录" },
  "settings.historyHelp": {
    en: "Audit records live in memory only. A restart from this console keeps them; stopping the process removes them. Clearing them does not undo anything that ran, and keeps messages, questions and names.",
    zh: "审计记录只保存在内存中。在控制台中重启会保留它们，停止进程后会消失。清空不会撤销已经执行的操作，也会保留消息、问题和对话名称。",
  },
  "settings.cleared": {
    en: "Call history cleared. Messages, questions and names were kept.",
    zh: "调用记录已清空，消息、问题和对话名称已保留。",
  },
  "settings.about": { en: "About", zh: "关于" },
  "settings.version": { en: "Version", zh: "版本" },
  "settings.host": { en: "Machine", zh: "机器" },
  "settings.platform": { en: "Platform", zh: "平台" },
  "settings.endpoint": { en: "MCP endpoint", zh: "MCP 地址" },
  "settings.uptime": { en: "Uptime", zh: "运行时长" },
  "settings.protocol": { en: "MCP protocol use", zh: "MCP 协议使用" },
  "settings.protocolModern": {
    en: "Current protocol: {0} requests",
    zh: "当前协议：{0} 次请求",
  },
  "settings.protocolLegacy": {
    en: "2025 protocol: {0} requests in {1} sessions, {2} open",
    zh: "2025 版协议：{1} 个会话共 {0} 次请求，{2} 个仍打开",
  },
  "settings.protocolLast": { en: "last {0}", zh: "最近 {0}" },
  "settings.protocolSince": {
    en: "Counted since {0}, when this process started.",
    zh: "从 {0} 进程启动时开始统计。",
  },
  "config.login": { en: "Login shell by default", zh: "默认使用登录 Shell" },
  "config.loginHelp": {
    en: "Commands load shell profiles (or the PowerShell profile). Individual calls can still override it.",
    zh: "命令默认加载 Shell profile（或 PowerShell profile），单次调用仍可覆盖。",
  },
  "config.loginLabel": {
    en: "Load shell profiles by default",
    zh: "默认加载 Shell profile",
  },
  "config.web": { en: "Web console", zh: "Web 控制台" },
  "config.webHelp": {
    en: "Tool execution keeps working without it. Turning it back on requires editing the configuration.",
    zh: "关闭后工具执行不受影响；重新开启需要编辑配置文件。",
  },
  "config.webEnable": {
    en: "Enable the Web console",
    zh: "启用 Web 控制台",
  },
  "config.accessHelp": {
    en: "LAN access requires [web].host set to 0.0.0.0 or ::. Sign in once with the Web access key; later visits renew the browser session.",
    zh: "[web].host 设为 0.0.0.0 或 :: 时才开放局域网。首次用访问密钥登录，之后访问会自动续期。",
  },
  "config.loopback": { en: "On this machine", zh: "本机" },
  "config.lan": { en: "On the LAN", zh: "局域网" },
  "config.privateLinks": {
    en: "Links that include the token are shown only in this machine's own browser.",
    zh: "带密钥的局域网链接只在本机浏览器中显示。",
  },
  "config.lanDisabled": {
    en: "LAN access is off. Only this machine can open the console.",
    zh: "局域网访问未开启，只有本机可以打开控制台。",
  },
  "config.rotate": { en: "Rotate token", zh: "更换密钥" },
  "config.summary": {
    en: "What this running instance loaded. Credential values and command arguments are hidden.",
    zh: "当前运行实例加载的配置，凭据值和命令参数已隐藏。",
  },
  "config.openFolder": { en: "Show in folder", zh: "在文件夹中显示" },
  "error.network": {
    en: "Cannot reach the server.",
    zh: "无法连接服务器。",
  },
  "error.unauthorized": {
    en: "Sign in again to continue.",
    zh: "请重新登录后继续。",
  },
  "error.invalidToken": {
    en: "The Web access key is not correct.",
    zh: "访问密钥不正确。",
  },
  "error.forbiddenOrigin": {
    en: "The request came from another site, so the server blocked it.",
    zh: "请求来自其他网站，已被服务器拦截。",
  },
  "error.missingActionHeader": {
    en: "The request did not come from this console, so the server blocked it.",
    zh: "请求不是由本控制台发出，已被服务器拦截。",
  },
  "error.loopbackOnly": {
    en: "Only a browser on the server machine can do this.",
    zh: "只有服务器本机的浏览器可以执行此操作。",
  },
  "error.invalidRequest": {
    en: "The server did not accept the request. Reload the page and try again.",
    zh: "服务器未接受该请求，请刷新页面后重试。",
  },
  "error.bodyTooLarge": {
    en: "The request is too large.",
    zh: "请求内容过大。",
  },
  "error.notFound": {
    en: "The server does not have this page or action. Reload the console.",
    zh: "服务器没有这个页面或操作，请刷新控制台。",
  },
  "error.callNotFound": {
    en: "This call is no longer in the audit.",
    zh: "审计中已没有这次调用。",
  },
  "error.mediaNotFound": {
    en: "This image is no longer kept.",
    zh: "这张图片已不再保留。",
  },
  "error.conversationNotFound": {
    en: "This conversation is not known yet, or its records expired.",
    zh: "尚未识别这个对话，或其记录已过期。",
  },
  "error.questionNotFound": {
    en: "This question no longer exists.",
    zh: "这个问题已不存在。",
  },
  "error.noteNotFound": {
    en: "This message no longer exists.",
    zh: "这条消息已不存在。",
  },
  "error.noteEmpty": { en: "The message is empty.", zh: "消息为空。" },
  "error.tooLong": { en: "The text is too long.", zh: "文本过长。" },
  "error.noteChanged": {
    en: "A message with this ID already has different text.",
    zh: "相同 ID 的消息已有不同内容。",
  },
  "error.noteAttached": {
    en: "ChatGPT already received this message, so you cannot withdraw it.",
    zh: "ChatGPT 已收到这条消息，无法撤回。",
  },
  "error.invalidOption": {
    en: "The selected option does not exist.",
    zh: "所选选项不存在。",
  },
  "error.answerRequired": {
    en: "Choose an option or write a note.",
    zh: "请选择一个选项或填写补充说明。",
  },
  "error.answerChanged": {
    en: "This question already has a different answer.",
    zh: "这个问题已有不同的回答。",
  },
  "error.questionAnswered": {
    en: "This question already has an answer.",
    zh: "这个问题已经回答过了。",
  },
  "error.notesFull": {
    en: "Message storage is full. Old records leave after 72 hours.",
    zh: "消息存储已满，旧记录会在 72 小时后清除。",
  },
  "error.webUnavailable": {
    en: "The Web console is not running.",
    zh: "Web 控制台未运行。",
  },
  "error.managementUnavailable": {
    en: "This instance cannot change its configuration from the console.",
    zh: "当前实例不能在控制台中修改配置。",
  },
  "error.restartInProgress": {
    en: "A restart is in progress. Try again when it finishes.",
    zh: "正在重启，请在完成后重试。",
  },
  "error.configConflict": {
    en: "Another change updated the configuration. Try again.",
    zh: "配置已被其他修改更新，请重试。",
  },
  "error.configUnreadable": {
    en: "Fix the configuration file, then try again. {0}",
    zh: "请修正配置文件后重试。{0}",
  },
  "error.configEntryMissing": {
    en: "This entry is no longer in the configuration. Refresh the list.",
    zh: "配置中已没有这一项，请刷新列表。",
  },
  "error.configUnsafeEdit": {
    en: "The console cannot change this entry safely. Edit the configuration file in a terminal.",
    zh: "控制台无法安全修改这一项，请在终端中编辑配置文件。",
  },
  "error.tooManyEventClients": {
    en: "Too many console tabs are open. Close some, then reload.",
    zh: "打开的控制台标签页过多，请关闭部分后刷新。",
  },
  "error.internal": {
    en: "The server had an internal error. Check the service log.",
    zh: "服务器内部出错，请查看服务日志。",
  },
} as const;
