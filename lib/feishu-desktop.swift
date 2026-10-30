// 操作本机已登录的飞书桌面客户端（Lark.app）发一条消息：外部会话（飞书不让程序以本人身份发）代发用。
// 用法：swift feishu-desktop.swift state                 当前会话名（从输入框的「发送给 xxx」读）和输入框内容
//       swift feishu-desktop.swift open <会话名>         ⌘K 搜这个名字、回车打开，核对输入框写着「发送给 <会话名>」
//       swift feishu-desktop.swift send <会话名> <正文文件>  核对当前就是这个会话、输入框是空的 → 粘贴 → 核对内容 → 回车一次
// 输出一行 JSON：{"ok":true,...} 或 {"ok":false,"why":"..."}。要「辅助功能」权限（调用它的那个程序）。剪贴板用完还原。
import Cocoa
import ApplicationServices

func out(_ o: [String: Any]) -> Never {
  let d = try! JSONSerialization.data(withJSONObject: o, options: [])
  print(String(data: d, encoding: .utf8)!)
  exit((o["ok"] as? Bool) == true ? 0 : 1)
}
func attr(_ e: AXUIElement, _ k: String) -> AnyObject? { var v: AnyObject?; return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil }
func str(_ e: AXUIElement, _ k: String) -> String { attr(e, k) as? String ?? "" }

guard AXIsProcessTrusted() else { out(["ok": false, "why": "没有辅助功能权限（系统设置 → 隐私与安全性 → 辅助功能，给调用它的程序打开）"]) }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.electron.lark").first else { out(["ok": false, "why": "飞书客户端没在运行"]) }
let root = AXUIElementCreateApplication(app.processIdentifier)

// 输入框：AXTextArea，空的时候值是「发送给 <会话名>」加几个零宽字符
func inputs() -> [AXUIElement] {
  var found: [AXUIElement] = []
  func walk(_ e: AXUIElement, _ d: Int) {
    if d > 40 { return }
    if str(e, kAXRoleAttribute) == "AXTextArea" { found.append(e) }
    for c in attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(c, d + 1) }
  }
  walk(root, 0)
  return found
}
let clean = { (s: String) in s.replacingOccurrences(of: "\u{200B}", with: "").trimmingCharacters(in: .whitespacesAndNewlines) }
// 比内容：去掉空白、零宽、[看] 这类表情码
func norm(_ s: String) -> String {
  var t = s.replacingOccurrences(of: "\u{200B}", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
  t = t.replacingOccurrences(of: "\\[[^\\]]{1,6}\\]", with: "", options: .regularExpression)
  return t
}
func state() -> (chat: String, text: String, el: AXUIElement?) {
  let all = inputs()
  let e = all.first { (attr($0, kAXFocusedAttribute) as? Bool) == true } ?? all.first
  guard let el = e else { return ("", "", nil) }
  let v = clean(str(el, kAXValueAttribute))
  if v.hasPrefix("发送给 ") && !v.dropFirst(4).contains("\n") { return (String(v.dropFirst(4)), "", el) }
  return ("?", v, el) // 输入框里有字：会话名看不到
}

func actions(_ e: AXUIElement) -> [String] { var x: CFArray?; AXUIElementCopyActionNames(e, &x); return x as? [String] ?? [] }
func role(_ e: AXUIElement) -> String { str(e, kAXRoleAttribute) }
func kids(_ e: AXUIElement) -> [AXUIElement] { attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func texts(_ e: AXUIElement, _ d: Int = 0) -> [String] { d > 12 ? [] : (role(e) == "AXStaticText" ? [str(e, kAXValueAttribute)] : []) + kids(e).flatMap { texts($0, d + 1) } }
func hasRole(_ e: AXUIElement, _ r: String, _ d: Int = 0) -> Bool { d <= 12 && (role(e) == r || kids(e).contains { hasRole($0, r, d + 1) }) }
// 搜索浮层（标题带 search-command-bar 的窗口）里标题正好是这个名字的结果行：标题 = 行里的文字拼起来、去掉末尾「(人数)」
func resultRows(_ name: String) -> [AXUIElement] {
  let wins = (attr(root, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter { str($0, kAXTitleAttribute).contains("search-command-bar") }
  var rows: [AXUIElement] = []
  func walk(_ e: AXUIElement, _ d: Int, _ anc: [AXUIElement]) {
    if d > 45 { return }
    if role(e) == "AXStaticText", str(e, kAXValueAttribute) == name || name.hasPrefix(str(e, kAXValueAttribute)) && !str(e, kAXValueAttribute).isEmpty,
       let row = anc.reversed().first(where: { role($0) == "AXGroup" && actions($0).contains("AXPress") }),
       !hasRole(row, "AXTextArea"), !rows.contains(where: { CFEqual($0, row) }) {
      let title = clean(texts(row).joined()).replacingOccurrences(of: "\\(\\d+\\)$", with: "", options: .regularExpression)
      if title == name { rows.append(row) }
    }
    for c in kids(e) { walk(c, d + 1, anc + [e]) }
  }
  for w in wins { walk(w, 0, []) }
  return rows
}

func activate() { app.activate(options: [.activateIgnoringOtherApps]); usleep(500_000) }
// 按键走 System Events（直接发 CGEvent 的回车，飞书的网页输入框收不到）
func key(_ code: Int, cmd: Bool = false) {
  var err: NSDictionary?
  NSAppleScript(source: "tell application \"System Events\" to key code \(code)\(cmd ? " using command down" : "")")?.executeAndReturnError(&err)
  usleep(80_000)
}
let pb = NSPasteboard.general
let saved = pb.string(forType: .string)
func paste(_ s: String) { pb.clearContents(); pb.setString(s, forType: .string); key(9, cmd: true); usleep(600_000) }
func restore() { if let s = saved { pb.clearContents(); pb.setString(s, forType: .string) } }
func until(_ secs: Double, _ ok: () -> Bool) -> Bool { let end = Date().addingTimeInterval(secs); while Date() < end { if ok() { return true }; usleep(250_000) }; return ok() }

let args = CommandLine.arguments.dropFirst()
switch args.first {
case "state":
  let s = state()
  out(["ok": true, "chat": s.chat, "text": s.text, "frontmost": app.isActive])
case "open":
  guard args.count == 2 else { out(["ok": false, "why": "用法：open <会话名>"]) }
  let name = args[args.startIndex + 1]
  activate()
  if state().chat == name { out(["ok": true, "chat": name]) }
  key(40, cmd: true); usleep(800_000) // ⌘K 打开搜索浮层
  key(0, cmd: true); key(51) // 搜索框里原来的字清掉
  paste(name); restore()
  var rows: [AXUIElement] = []
  _ = until(6, { rows = resultRows(name); return !rows.isEmpty })
  if rows.count != 1 { key(53); out(["ok": false, "why": rows.isEmpty ? "搜不到叫「\(name)」的会话" : "搜到 \(rows.count) 个都叫「\(name)」，不知道是哪个"]) }
  AXUIElementPerformAction(rows[0], kAXPressAction as CFString) // 点标题正好对上的那一行
  if until(4, { state().chat == name }) { out(["ok": true, "chat": name]) }
  let now = state().chat
  key(53)
  out(["ok": false, "why": "点了「\(name)」，打开的却是「\(now.isEmpty ? "看不到" : now)」"])
case "send":
  guard args.count == 3 else { out(["ok": false, "why": "用法：send <会话名> <正文文件>"]) }
  let name = args[args.startIndex + 1], file = args[args.startIndex + 2]
  guard let text = try? String(contentsOfFile: file, encoding: .utf8), !clean(text).isEmpty else { out(["ok": false, "why": "正文文件读不了或是空的"]) }
  activate()
  let s0 = state()
  guard let el = s0.el else { out(["ok": false, "why": "找不到输入框"]) }
  if s0.chat == "?" { out(["ok": false, "why": "输入框里有没发出的内容，没动它"]) }
  guard s0.chat == name else { out(["ok": false, "why": "当前会话是「\(s0.chat)」，不是「\(name)」"]) }
  AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  usleep(200_000)
  paste(text); restore()
  let typed = until(3, { norm(state().text) == norm(text) })
  if !typed { key(0, cmd: true); key(51); out(["ok": false, "why": "粘贴进输入框的内容对不上，已清掉"]) }
  key(36) // 回车发送，只按这一次
  let cleared = until(5, { state().chat == name })
  out(["ok": true, "pressed": true, "cleared": cleared])
default:
  out(["ok": false, "why": "用法：state | open <会话名> | send <会话名> <正文文件>"])
}
