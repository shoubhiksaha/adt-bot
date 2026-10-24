// ADT Bot Mac helper: reads apps' accessibility trees and acts on their elements, so bots can use
// apps by name ("press Send") instead of guessing coordinates from screenshots. It also types and
// clicks with CoreGraphics events, without the clipboard or a new process per action.
//
// The accessibility-first approach follows Ghost OS (github.com/ghostwright/ghost-os, MIT) and
// macOS Computer Use Kit (MIT): AX tree first, AXPress before clicking, AXManualAccessibility /
// AXEnhancedUserInterface so Electron and Chromium apps expose their web content.
//
// Protocol: one JSON request per line on stdin ({"id": 1, "cmd": "snapshot", ...}), one JSON reply
// per line on stdout ({"id": 1, "result": ...} or {"id": 1, "error": "...", "code": "..."}).
// Started by electron/features/70-mac-control.cjs; macOS attributes its permissions to ADT Bot.
import AppKit
import ApplicationServices
import CoreAudio
import Foundation
import Vision

setvbuf(stdout, nil, _IOLBF, 0)
let systemWide = AXUIElementCreateSystemWide()
// A hung app must not hang the helper: give up on any one accessibility call after 1.5 s.
AXUIElementSetMessagingTimeout(systemWide, 1.5)

struct Failure: Error {
  let message: String
  var code: String? = nil
}

// Elements from the last two snapshots, by id, so "press 12" works after the model looks again.
var current: [Int: AXUIElement] = [:]
var previous: [Int: AXUIElement] = [:]
// Ids start somewhere random for each run of the helper: an id from before a restart (Stop all, a
// timeout) can't land on a different element in this run.
var nextId = Int.random(in: 1...900) * 1000
var exposed = Set<pid_t>()

let CHROMIUM: Set<String> = [
  "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "com.brave.Browser",
  "com.microsoft.edgemac", "com.vivaldi.Vivaldi", "company.thebrowser.Browser", "org.chromium.Chromium", "com.operasoftware.Opera",
]

// MARK: Attribute helpers

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

let ATTRS = [
  "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXEnabled", "AXFocused", "AXSelected",
  "AXPosition", "AXSize", "AXChildren", "AXHelp",
]

/** Several attributes in one round trip to the app; missing ones are left out. */
func attrs(_ el: AXUIElement) -> [String: CFTypeRef] {
  var values: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(el, ATTRS as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
    let list = values as [AnyObject]?
  else { return [:] }
  var out: [String: CFTypeRef] = [:]
  for (i, value) in list.enumerated() where i < ATTRS.count {
    let ref = value as CFTypeRef
    if CFGetTypeID(ref) == AXValueGetTypeID() && AXValueGetType(ref as! AXValue) == .axError { continue }
    out[ATTRS[i]] = ref
  }
  return out
}

func string(_ v: CFTypeRef?) -> String? {
  guard let v else { return nil }
  if let s = v as? String { return s.isEmpty ? nil : s }
  if CFGetTypeID(v) == CFBooleanGetTypeID() { return nil }
  if let n = v as? NSNumber { return n.stringValue }
  if let a = v as? NSAttributedString { return a.string.isEmpty ? nil : a.string }
  return nil
}

func bool(_ v: CFTypeRef?) -> Bool? {
  guard let v else { return nil }
  if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
  return (v as? NSNumber)?.boolValue
}

func point(_ v: CFTypeRef?) -> CGPoint? {
  guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var p = CGPoint.zero
  return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func size(_ v: CFTypeRef?) -> CGSize? {
  guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var s = CGSize.zero
  return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func frameOf(_ el: AXUIElement) -> CGRect? {
  guard let p = point(attr(el, "AXPosition")), let s = size(attr(el, "AXSize")) else { return nil }
  return CGRect(origin: p, size: s)
}

func children(_ v: CFTypeRef?) -> [AXUIElement] {
  guard let v, let list = v as? [AnyObject] else { return [] }
  return list.map { $0 as! AXUIElement }
}

func actions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
  return list
}

/** Invisible text-direction marks (WhatsApp puts them in every name) only get in the way of matching. */
let BIDI = CharacterSet(charactersIn: "\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}\u{FEFF}")

func clip(_ s: String, _ n: Int) -> String {
  let flat = String(s.unicodeScalars.filter { !BIDI.contains($0) }).replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
  return flat.count > n ? String(flat.prefix(n - 1)) + "…" : flat
}

func json(_ r: CGRect) -> [String: Int] {
  // Apps sometimes report NaN or infinite frames; Int() would crash on them.
  let n = { (v: CGFloat) -> Int in v.isFinite ? Int(max(-1e9, min(1e9, v)).rounded()) : 0 }
  return ["x": n(r.origin.x), "y": n(r.origin.y), "w": n(r.width), "h": n(r.height)]
}

// MARK: Apps

func pidOf(_ el: AXUIElement) -> pid_t {
  var pid: pid_t = 0
  AXUIElementGetPid(el, &pid)
  return pid
}

func appInfo(_ pid: pid_t) -> [String: Any] {
  let app = NSRunningApplication(processIdentifier: pid)
  return ["name": clip(app?.localizedName ?? "pid \(pid)", 80), "bundleId": app?.bundleIdentifier ?? "", "pid": Int(pid)]
}

/**
 * ADT Bot itself (the app that started this helper; tests set ADT_SELF_PID). Bots may not read or
 * operate its window: its settings and approval buttons are the user's.
 */
let selfPid: pid_t = pid_t(ProcessInfo.processInfo.environment["ADT_SELF_PID"] ?? "") ?? getppid()
let selfBundle = NSRunningApplication(processIdentifier: selfPid)?.bundleIdentifier
func isSelf(_ pid: pid_t) -> Bool {
  if pid == selfPid || pid == getpid() { return true }
  guard let mine = selfBundle, let theirs = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier else { return false }
  return theirs == mine || theirs.hasPrefix(mine + ".")
}
let SELF_REFUSAL = "That's ADT Bot itself: bots can't operate its window (its settings and approval buttons are the user's). Name another app."

/** Refuses input aimed at whatever is in front when that's ADT Bot (the user is talking to it). */
func requireOtherAppInFront(_ what: String) throws {
  if let front = NSWorkspace.shared.frontmostApplication, isSelf(front.processIdentifier) {
    throw Failure(message: "\(what) would go to ADT Bot, which is in front. Name the app to send it to (app: \"WhatsApp\"), or open it first.", code: "self")
  }
}

/** The app in front, skipping ADT Bot itself (it's in front while the user talks to it). */
func frontApp() -> pid_t? {
  let me = selfPid
  if let focused = attr(systemWide, "AXFocusedApplication") {
    let pid = pidOf(focused as! AXUIElement)
    if pid != me && pid != getpid() && pid > 0 { return pid }
  }
  // Next app down in the window stack.
  let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  for w in windows {
    guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != me, pid != getpid() else { continue }
    if NSRunningApplication(processIdentifier: pid)?.activationPolicy == .regular { return pid }
  }
  return nil
}

func findApp(_ name: String?) throws -> pid_t {
  guard let name, !name.trimmingCharacters(in: .whitespaces).isEmpty else {
    if let pid = frontApp() { return pid }
    throw Failure(message: "No app is in front. Say which app, e.g. \"WhatsApp\".")
  }
  let want = clip(name, 200).lowercased()
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }
  // Some apps put invisible marks in their names (WhatsApp): compare without them.
  let nameOf = { (a: NSRunningApplication) in clip(a.localizedName ?? "", 200).lowercased() }
  let match =
    apps.first { nameOf($0) == want || ($0.bundleIdentifier ?? "").lowercased() == want }
    ?? apps.first { nameOf($0).hasPrefix(want) }
    ?? apps.first { nameOf($0).contains(want) }
  guard let app = match else { throw Failure(message: "\"\(name)\" isn't running. Open it first (mac_open_app).", code: "not-running") }
  if isSelf(app.processIdentifier) { throw Failure(message: SELF_REFUSAL, code: "self") }
  return app.processIdentifier
}

/**
 * Electron and Chromium apps only build their accessibility tree for assistive apps that ask.
 * Returns true when it was just switched on (the tree needs a moment to appear).
 */
func expose(_ appEl: AXUIElement, pid: pid_t) -> Bool {
  if exposed.contains(pid) { return false }
  exposed.insert(pid)
  let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
  var changed = AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
  if CHROMIUM.contains(bundle) {
    changed = AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success || changed
  }
  return changed
}

// MARK: Snapshot

let ROLE: [String: String] = [
  "AXButton": "button", "AXCheckBox": "checkbox", "AXRadioButton": "radio button", "AXPopUpButton": "pop-up menu",
  "AXMenuButton": "menu button", "AXComboBox": "combo box", "AXTextField": "text field", "AXTextArea": "text area",
  "AXLink": "link", "AXMenuItem": "menu item", "AXMenuBarItem": "menu", "AXSlider": "slider", "AXDisclosureTriangle": "disclosure",
  "AXIncrementor": "stepper", "AXColorWell": "color well", "AXDateField": "date field", "AXRow": "row", "AXStaticText": "text",
  "AXHeading": "heading", "AXImage": "image", "AXSegmentedControl": "segmented control", "AXDockItem": "dock item",
]
let SUBROLE: [String: String] = [
  "AXSearchField": "search field", "AXSecureTextField": "password field", "AXTabButton": "tab", "AXSwitch": "switch",
  "AXToggle": "toggle", "AXCloseButton": "close button", "AXMinimizeButton": "minimize button", "AXFullScreenButton": "full screen button",
]
/** Things you can act on: their text children become their label instead of separate lines. */
let ACTIONABLE: Set<String> = [
  "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXTextField", "AXTextArea", "AXLink",
  "AXMenuItem", "AXMenuBarItem", "AXSlider", "AXDisclosureTriangle", "AXIncrementor", "AXColorWell", "AXDateField", "AXRow", "AXDockItem",
]
let TEXT_INPUT: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXDateField"]

final class Walk {
  var nodes: [[String: Any]] = []
  var elements: [(Int, AXUIElement)] = []
  var visited = 0
  var truncated = false
  let maxNodes: Int
  let query: [String]
  let deadline: Date
  init(maxNodes: Int, query: String?, seconds: Double) {
    self.maxNodes = maxNodes
    self.query = (query ?? "").lowercased().split(separator: " ").map(String.init).filter { !$0.isEmpty }
    deadline = Date().addingTimeInterval(seconds)
  }
  func matches(_ text: String) -> Bool {
    if query.isEmpty { return true }
    let t = text.lowercased()
    return query.allSatisfy { t.contains($0) }
  }
}

/**
 * Depth-first, in reading order. Skips parts of the window that are scrolled out of view, and
 * folds text inside a button or row into that button's label.
 */
func walk(_ el: AXUIElement, depth: Int, visible: CGRect, inWeb: Bool, labelOwner: Int?, _ w: Walk) {
  if w.visited >= 6000 || Date() > w.deadline {
    w.truncated = true
    return
  }
  w.visited += 1
  let a = attrs(el)
  let role = string(a["AXRole"]) ?? ""
  let subrole = string(a["AXSubrole"]) ?? ""
  var frame: CGRect? = nil
  if let p = point(a["AXPosition"]), let s = size(a["AXSize"]) { frame = CGRect(origin: p, size: s) }
  // Scrolled out of view: nothing inside can be seen (menus and the menu bar are outside windows).
  if let f = frame, f.width > 0, f.height > 0, !visible.isNull, !f.intersects(visible), role != "AXMenu", role != "AXMenuItem" { return }
  let web = inWeb || role == "AXWebArea"

  let title = string(a["AXTitle"])
  let desc = string(a["AXDescription"])
  let value = string(a["AXValue"])
  var owner = labelOwner

  // Text inside a button/row: becomes (part of) its label.
  if let o = labelOwner, role == "AXStaticText" || role == "AXImage" {
    if let text = role == "AXStaticText" ? (value ?? title ?? desc) : desc, var node = w.nodes.first(where: { ($0["id"] as? Int) == o }) {
      let label = (node["label"] as? String) ?? ""
      if label.count < 90 && !label.contains(text) {
        node["label"] = clip(label.isEmpty ? text : "\(label) · \(text)", 120)
        if let i = w.nodes.firstIndex(where: { ($0["id"] as? Int) == o }) { w.nodes[i] = node }
      }
    }
  } else {
    var kind = SUBROLE[subrole] ?? ROLE[role]
    var label = title ?? desc
    if kind == nil, role == "AXGroup" || role == "AXCell", !web, let d = desc, actions(el).contains("AXPress") {
      kind = "button"
      label = d
    }
    if role == "AXImage" && desc == nil { kind = nil }
    if role == "AXStaticText" && value == nil && title == nil { kind = nil }
    if role == "AXRow" && (bool(a["AXSelected"]) == nil) && frame == nil { kind = nil }
    if let kind, frame.map({ $0.width > 0 && $0.height > 0 }) ?? false {
      if TEXT_INPUT.contains(role) && label == nil { label = string(a["AXPlaceholderValue"]) ?? string(a["AXHelp"]) }
      let id = nextId
      nextId += 1
      var node: [String: Any] = ["id": id, "role": kind]
      if role == "AXStaticText" {
        node["label"] = clip(value ?? title ?? desc ?? "", 200)
      } else if let label { node["label"] = clip(label, 120) }
      // A heading's value is its level.
      if role != "AXStaticText", role != "AXHeading", let value, subrole != "AXSecureTextField", value != label {
        node["value"] = clip(value, TEXT_INPUT.contains(role) ? 300 : 80)
      }
      if let f = frame { node["frame"] = json(f) }
      if bool(a["AXEnabled"]) == false { node["disabled"] = true }
      if bool(a["AXFocused"]) == true { node["focused"] = true }
      if bool(a["AXSelected"]) == true { node["selected"] = true }
      if web { node["web"] = true }
      if TEXT_INPUT.contains(role) { node["input"] = true }
      w.nodes.append(node)
      w.elements.append((id, el))
      if ACTIONABLE.contains(role) || kind == "button" || role == "AXHeading" { owner = id }
      if w.nodes.count >= w.maxNodes * 4 {
        w.truncated = true
        return
      }
    }
  }
  for child in children(a["AXChildren"]) {
    if w.truncated { return }
    let inner = role == "AXScrollArea" || role == "AXWebArea" ? (frame.map { visible.isNull ? $0 : visible.intersection($0) } ?? visible) : visible
    walk(child, depth: depth + 1, visible: inner, inWeb: web, labelOwner: owner, w)
  }
}

func windowsOf(_ appEl: AXUIElement) -> [AXUIElement] { children(attr(appEl, "AXWindows")) }

func snapshot(_ req: [String: Any]) throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw Failure(message: "Accessibility permission is off.", code: "accessibility") }
  let pid = try findApp(req["app"] as? String)
  let appEl = AXUIElementCreateApplication(pid)
  if expose(appEl, pid: pid) { Thread.sleep(forTimeInterval: 0.35) }
  let windows = windowsOf(appEl)
  let titles = windows.map { clip(string(attr($0, "AXTitle")) ?? "", 120) }
  var target: AXUIElement? = nil
  if let want = (req["window"] as? String)?.lowercased(), !want.isEmpty {
    target = zip(windows, titles).first { $0.1.lowercased().contains(want) }?.0
  }
  if target == nil, let f = attr(appEl, "AXFocusedWindow") { target = (f as! AXUIElement) }
  if target == nil, let m = attr(appEl, "AXMainWindow") { target = (m as! AXUIElement) }
  if target == nil { target = windows.first }

  let maxNodes = max(20, min(600, req["max"] as? Int ?? 200))
  let w = Walk(maxNodes: maxNodes, query: req["query"] as? String, seconds: req["menus"] as? Bool == true ? 8 : 4)
  previous = current
  current = [:]
  var windowTitle: String? = nil
  var windowFrame: CGRect? = nil
  if let win = target {
    windowTitle = string(attr(win, "AXTitle"))
    windowFrame = frameOf(win)
    walk(win, depth: 0, visible: windowFrame ?? .null, inWeb: false, labelOwner: nil, w)
  }
  if req["menus"] as? Bool == true, let bar = attr(appEl, "AXMenuBar") {
    // Each top-level menu gets its own budget: History or Bookmarks (thousands of entries) must
    // not starve the menus after them.
    for menu in children(attr(bar as! AXUIElement, "AXChildren")) {
      w.visited = 0
      w.truncated = false
      walk(menu, depth: 1, visible: .null, inWeb: false, labelOwner: nil, w)
      if w.visited >= 6000 || Date() > w.deadline { break }
    }
    w.truncated = false
  }
  // Pop-up menus that are open right now (they're outside the window).
  if target != nil, req["menus"] as? Bool != true, let focused = attr(appEl, "AXFocusedUIElement"), string(attr(focused as! AXUIElement, "AXRole")) == "AXMenuItem" {
    if let menu = attr(focused as! AXUIElement, "AXParent") { walk(menu as! AXUIElement, depth: 0, visible: .null, inWeb: false, labelOwner: nil, w) }
  }

  for (id, el) in w.elements { current[id] = el }
  // Filter after the walk, so labels gathered from children count.
  var nodes = w.nodes.filter { w.matches("\($0["role"] ?? "") \($0["label"] ?? "") \($0["value"] ?? "")") }
  let matched = nodes.count
  if nodes.count > maxNodes {
    nodes = Array(nodes.prefix(maxNodes))
    w.truncated = true
  }
  var focusedId: Int? = nil
  if let f = attr(appEl, "AXFocusedUIElement") {
    let fe = f as! AXUIElement
    focusedId = w.elements.first { CFEqual($0.1, fe) }?.0
  }
  var out = appInfo(pid)
  out["window"] = clip(windowTitle ?? "", 120)
  if let wf = windowFrame { out["windowFrame"] = json(wf) }
  out["windows"] = titles
  out["elements"] = nodes
  out["matched"] = matched
  out["truncated"] = w.truncated
  if let focusedId { out["focusedId"] = focusedId }
  out["frontmost"] = bool(attr(appEl, "AXFrontmost")) ?? false
  if target == nil { out["note"] = windows.isEmpty ? "The app has no open windows." : "No window could be read." }
  return out
}

// MARK: User activity

/** When this helper last posted an input event itself (those count as activity to macOS too). */
var lastPosted = Date.distantPast
var lastUser = Date.distantPast
let ANY_INPUT = CGEventType(rawValue: ~0)!

/** Seconds since the user last touched the keyboard or mouse, not counting what this helper sent. */
func userIdleSeconds() -> Double {
  let now = Date()
  let lastEvent = now.addingTimeInterval(-CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: ANY_INPUT))
  if lastEvent > lastPosted.addingTimeInterval(0.3) { lastUser = max(lastUser, lastEvent) }
  return now.timeIntervalSince(lastUser)
}

/** One Core Audio property of an audio object, or nil. */
func audioProperty<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
  return status == noErr ? value : nil
}

/**
 * The apps playing sound right now (Core Audio's process objects, macOS 14.2+; no permission
 * needed to list them). Voice mode uses it to tell a video or music on this Mac from the user.
 */
func audioOutputs() -> [String: Any] {
  guard #available(macOS 14.2, *) else { return ["supported": false, "apps": [[String: Any]]()] }
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return ["supported": true, "apps": [[String: Any]]()] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return ["supported": true, "apps": [[String: Any]]()] }
  var apps: [[String: Any]] = []
  for id in ids {
    guard let running: UInt32 = audioProperty(id, kAudioProcessPropertyIsRunningOutput, UInt32(0)), running != 0 else { continue }
    let pid: pid_t = audioProperty(id, kAudioProcessPropertyPID, pid_t(0)) ?? 0
    let bundle: CFString = audioProperty(id, kAudioProcessPropertyBundleID, "" as CFString) ?? ("" as CFString)
    let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
    apps.append(["pid": Int(pid), "bundleId": bundle as String, "name": name])
  }
  return ["supported": true, "apps": apps]
}

/**
 * Anything that goes to the app in front (bringing it forward, global keys, clicks) collides with
 * what the user is doing. Wait for a pause; if there's none, refuse.
 */
func requireUserPause(_ what: String) throws {
  let deadline = Date().addingTimeInterval(4)
  while userIdleSeconds() < 1.2 {
    if Date() > deadline {
      throw Failure(message: "\(what): the user is using this Mac right now (keyboard or mouse used \(String(format: "%.1f", userIdleSeconds())) s ago). Wait for them to pause and try again, or work in the background (mac_ui, mac_press, mac_set_text with the app named).", code: "busy")
    }
    Thread.sleep(forTimeInterval: 0.25)
  }
}

// MARK: Actions

func element(_ req: [String: Any]) throws -> AXUIElement {
  guard let id = req["element"] as? Int, let el = current[id] ?? previous[id] else {
    throw Failure(message: "Element \(req["element"] ?? "?") isn't in the latest UI list. List the UI again (mac_ui).", code: "stale")
  }
  if attr(el, "AXRole") == nil { throw Failure(message: "That element is gone (the window changed). List the UI again (mac_ui).", code: "stale") }
  return el
}

func isFrontmost(_ pid: pid_t) -> Bool { bool(attr(AXUIElementCreateApplication(pid), "AXFrontmost")) == true }

/** Brings the element's app and window to the front, so clicks and typing land there. Throws if it didn't. */
func bringForward(_ el: AXUIElement, what: String) throws {
  let pid = pidOf(el)
  let appEl = AXUIElementCreateApplication(pid)
  if let win = attr(el, "AXWindow") {
    AXUIElementPerformAction(win as! AXUIElement, "AXRaise" as CFString)
    AXUIElementSetAttributeValue(appEl, "AXFocusedWindow" as CFString, win)
  }
  if !isFrontmost(pid) {
    try requireUserPause(what)
    AXUIElementSetAttributeValue(appEl, "AXFrontmost" as CFString, kCFBooleanTrue)
    NSRunningApplication(processIdentifier: pid)?.activate()
    for _ in 0..<20 {
      if isFrontmost(pid) { break }
      Thread.sleep(forTimeInterval: 0.05)
    }
    if !isFrontmost(pid) { throw Failure(message: "\(what): the app didn't come to the front (the user may have switched apps). Nothing was done.", code: "not-front") }
  }
}

func postClick(_ p: CGPoint, button: CGMouseButton = .left, clicks: Int = 1) {
  let (down, up): (CGEventType, CGEventType) =
    button == .right ? (.rightMouseDown, .rightMouseUp) : button == .center ? (.otherMouseDown, .otherMouseUp) : (.leftMouseDown, .leftMouseUp)
  lastPosted = Date()
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: button)?.post(tap: .cghidEventTap)
  usleep(30_000)
  for i in 1...max(1, min(3, clicks)) {
    let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: button)
    d?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
    d?.post(tap: .cghidEventTap)
    usleep(12_000)
    let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: button)
    u?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
    u?.post(tap: .cghidEventTap)
    if i < clicks { usleep(60_000) }
  }
  lastPosted = Date()
}

/** Where the pointer is now (top-left origin, like every other coordinate here). */
func pointerLocation() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

/** Clicks for the user's sake: the pointer goes back where it was, so they can keep working. */
func clickAndReturn(_ p: CGPoint, button: CGMouseButton = .left, clicks: Int = 1) {
  let was = pointerLocation()
  postClick(p, button: button, clicks: clicks)
  usleep(40_000)
  CGWarpMouseCursorPosition(was)
  // Warping briefly decouples the mouse from the pointer; reconnect so the user's next move isn't ignored.
  CGAssociateMouseAndMouseCursorPosition(1)
  lastPosted = Date()
}

func center(_ el: AXUIElement) throws -> CGPoint {
  guard let f = frameOf(el), f.width > 0, f.height > 0 else { throw Failure(message: "That element has no position on screen.") }
  return CGPoint(x: f.midX, y: f.midY)
}

/**
 * Rows scrolled out of a list (a chat further down WhatsApp's list) often ignore a press, and
 * can't be clicked: scroll them into the window first, the way a person would.
 */
func scrollIntoView(_ el: AXUIElement) {
  guard let f = frameOf(el), let win = attr(el, "AXWindow"), let wf = frameOf(win as! AXUIElement) else { return }
  if wf.contains(f) || !actions(el).contains("AXScrollToVisible") { return }
  AXUIElementPerformAction(el, "AXScrollToVisible" as CFString)
  usleep(200_000)
}

/** Presses with the accessibility action when there is one (works even behind other windows); clicks otherwise. */
func press(_ req: [String: Any]) throws -> [String: Any] {
  let el = try element(req)
  let how = req["action"] as? String ?? "press"
  scrollIntoView(el)
  if how == "press" {
    let available = actions(el)
    for action in ["AXPress", "AXConfirm", "AXPick", "AXOpen"] where available.contains(action) {
      let result = AXUIElementPerformAction(el, action as CFString)
      if result == .success { return ["method": action] }
      // A press that opens a menu or dialog often doesn't return before the time limit, but it did
      // happen: trying another way would press twice.
      if result == .cannotComplete { return ["method": action, "slow": true] }
    }
    // Rows in lists (chats, files) select instead of pressing.
    if string(attr(el, "AXRole")) == "AXRow", AXUIElementSetAttributeValue(el, "AXSelected" as CFString, kCFBooleanTrue) == .success {
      return ["method": "select"]
    }
  }
  if how == "focus" {
    try bringForward(el, what: "Focusing")
    let r = AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
    return ["method": "focus", "ok": r == .success]
  }
  let p = try center(el)
  try bringForward(el, what: "Clicking")
  try requireUserPause("Clicking")
  usleep(80_000)
  clickAndReturn(p, button: how == "right_click" ? .right : .left, clicks: how == "double_click" ? 2 : 1)
  return ["method": "click", "x": Int(p.x), "y": Int(p.y)]
}

// Menu settings ------------------------------------------------------------------------------

/** Menus whose items are pages and windows, not settings (a bookmark titled like a setting mustn't be pressed). */
let CONTENT_MENUS: Set<String> = ["history", "bookmarks", "favorites", "window", "help", "profiles", "people", "tab", "tabs"]

/**
 * A menu item in an app's menu bar, found by words in its title (a few levels deep; not the Apple menu
 * or CONTENT_MENUS), e.g. a browser's View → Developer → "Allow JavaScript from Apple Events". `press`: press it once,
 * whatever its tick says (Chromium updates ticks only when the menu opens, so the caller checks the
 * result another way). `on`: press only if its tick differs (apps whose ticks are current).
 */
func menuSetting(_ req: [String: Any]) throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw Failure(message: "Accessibility permission is off.", code: "accessibility") }
  let pid = try findApp(req["app"] as? String)
  let words = ((req["words"] as? [String]) ?? []).map { $0.lowercased() }.filter { !$0.isEmpty }
  guard !words.isEmpty else { throw Failure(message: "Say which menu item.") }
  let appEl = AXUIElementCreateApplication(pid)
  guard let bar = attr(appEl, "AXMenuBar") else { return ["found": false] }
  func ticked(_ el: AXUIElement) -> Bool { !(string(attr(el, "AXMenuItemMarkChar")) ?? "").isEmpty }
  var budget = 0
  func find(_ el: AXUIElement, depth: Int) -> AXUIElement? {
    if depth > 5 { return nil }
    for child in children(attr(el, "AXChildren")) {
      budget -= 1
      if budget < 0 { return nil }
      let a = attrs(child)
      let title = (string(a["AXTitle"]) ?? "").lowercased()
      let sub = children(a["AXChildren"])
      // A setting is a plain item; one with a submenu is a folder (or the Developer menu itself).
      if string(a["AXRole"]) == "AXMenuItem", sub.isEmpty, words.allSatisfy({ title.contains($0) }) { return child }
      if let hit = find(child, depth: depth + 1) { return hit }
    }
    return nil
  }
  var item: AXUIElement?
  for (i, top) in children(attr(bar as! AXUIElement, "AXChildren")).enumerated() where i > 0 {
    if CONTENT_MENUS.contains((string(attr(top, "AXTitle")) ?? "").lowercased()) { continue }
    budget = 800
    if let hit = find(top, depth: 1) { item = hit; break }
  }
  guard let item else { return ["found": false] }
  let title = string(attr(item, "AXTitle")) ?? ""
  let was = ticked(item)
  let pressOnce = req["press"] as? Bool == true
  if !pressOnce {
    guard let want = req["on"] as? Bool, want != was else { return ["found": true, "title": title, "was": was, "now": was] }
  }
  if bool(attr(item, "AXEnabled")) == false { throw Failure(message: "\(title) can't be changed right now (it's greyed out).") }
  let result = AXUIElementPerformAction(item, "AXPress" as CFString)
  if result != .success && result != .cannotComplete { throw Failure(message: "Couldn't press \(title).") }
  usleep(300_000)
  return ["found": true, "title": title, "was": was, "now": ticked(item)]
}

// Typing --------------------------------------------------------------------------------------

/** To the app in front (like a real keyboard), or straight to one app's queue when `pid` is given. */
func send(_ e: CGEvent?, to pid: pid_t?) {
  guard let e else { return }
  lastPosted = Date()
  if let pid { e.postToPid(pid) } else { e.post(tap: .cghidEventTap) }
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags = [], to pid: pid_t? = nil) {
  let d = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
  d?.flags = flags
  send(d, to: pid)
  let u = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
  u?.flags = flags
  send(u, to: pid)
}

/** A character key with modifiers (cmd+c): the character goes as the key's unicode string. */
func postChar(_ ch: String, flags: CGEventFlags, to pid: pid_t?) {
  let units = Array(ch.utf16)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
    e?.flags = flags
    units.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
    send(e, to: pid)
  }
}

/** Types any text (accents, emoji, other scripts) as keyboard events, one character at a time. */
/**
 * Types character by character. Into the app in front (no pid), it stops if another app comes to
 * the front partway (the user switched): the rest would land somewhere else.
 */
func typeText(_ text: String, to pid: pid_t? = nil) throws {
  let front = pid == nil ? NSWorkspace.shared.frontmostApplication?.processIdentifier : nil
  for (i, ch) in text.enumerated() {
    if let front, i % 40 == 39, NSWorkspace.shared.frontmostApplication?.processIdentifier != front {
      throw Failure(message: "Stopped typing after \(i) characters: another app came to the front. Check what was typed, then continue.", code: "moved")
    }
    if ch == "\n" || ch == "\r\n" {
      postKey(36, to: pid)
    } else if ch == "\t" {
      postKey(48, to: pid)
    } else {
      postChar(String(ch), flags: [], to: pid)
    }
    usleep(6_000)
  }
}

func isFocused(_ el: AXUIElement) -> Bool {
  if bool(attr(el, "AXFocused")) == true { return true }
  guard let f = attr(AXUIElementCreateApplication(pidOf(el)), "AXFocusedUIElement") else { return false }
  return CFEqual(f, el)
}

func valueOf(_ el: AXUIElement) -> String { string(attr(el, "AXValue")) ?? "" }

/** How many characters a field holds, when it says (AXValue is sometimes cut short, e.g. WhatsApp). */
func charCount(_ el: AXUIElement) -> Int? { (attr(el, "AXNumberOfCharacters") as? NSNumber)?.intValue }

/** Same text, ignoring invisible marks, spacing and case (apps reformat what they're given). */
func loosely(_ s: String) -> String {
  String(s.unicodeScalars.filter { !BIDI.contains($0) && !CharacterSet.whitespacesAndNewlines.contains($0) }).lowercased()
}

/** Whether the field now holds `expected`: by its value, or by its character count when the value is cut short. */
func holds(_ el: AXUIElement, _ expected: String) -> Bool {
  let now = valueOf(el)
  if loosely(now) == loosely(expected) { return true }
  // Apps show emoji and some symbols as placeholders in AXValue (or no value at all): then a matching
  // length is good evidence. Readable text that differs is a different text, whatever its length.
  guard now.isEmpty || now.contains("\u{FFFC}") else { return false }
  if let n = charCount(el), n == (expected as NSString).length || n == expected.count { return true }
  return false
}

func selectAll(_ el: AXUIElement, length: Int) -> Bool {
  var range = CFRange(location: 0, length: length)
  return AXValueCreate(.cfRange, &range).map { AXUIElementSetAttributeValue(el, "AXSelectedTextRange" as CFString, $0) == .success } ?? false
}

func caretAtEnd(_ el: AXUIElement, length: Int) {
  var range = CFRange(location: length, length: 0)
  if let v = AXValueCreate(.cfRange, &range) { AXUIElementSetAttributeValue(el, "AXSelectedTextRange" as CFString, v) }
}

/**
 * Without bringing the app forward (so the user can keep working): put the text in through
 * accessibility (an insert, like dictation; or the whole value, which WhatsApp and other UIKit
 * apps accept), or as key events sent only to that app. Returns how, or nil when nothing took
 * (the field is then exactly as it was).
 */
func setTextInBackground(_ el: AXUIElement, text: String, replace: Bool, old: String) -> String? {
  let pid = pidOf(el)
  AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
  usleep(60_000)
  let length = (old as NSString).length
  let expected = replace ? text : old + text
  func place() -> Bool {
    if replace { return length == 0 || selectAll(el, length: length) }
    caretAtEnd(el, length: length)
    return true
  }
  // 1. Accessibility insert: what a dictation app does. Native apps treat it as typing.
  if place(), AXUIElementSetAttributeValue(el, "AXSelectedText" as CFString, text as CFString) == .success {
    usleep(80_000)
    if holds(el, expected) { return "accessibility" }
  }
  if valueOf(el) != old && !valueOf(el).isEmpty { return nil }
  // 2. The whole value at once.
  if AXUIElementSetAttributeValue(el, "AXValue" as CFString, expected as CFString) == .success {
    usleep(80_000)
    if holds(el, expected) { return "value" }
  }
  if valueOf(el) != old && !valueOf(el).isEmpty { return nil }
  // 3. Key events to that app only.
  if place() {
    try? typeText(text, to: pid)
    usleep(150_000)
    if holds(el, expected) { return "keys" }
  }
  return nil
}

/** A button called Send (or similar) in the field's window, for apps whose Return key can't be sent from behind. */
/**
 * The Send button that belongs to this field: looked for in the field's own container first, then
 * one level out at a time, so a Send button of another thread or form in the window isn't pressed.
 */
func sendButton(near el: AXUIElement) -> AXUIElement? {
  let names: Set<String> = ["send", "send message", "submit", "post", "reply"]
  var container = el
  for _ in 0..<8 {
    guard let up = attr(container, "AXParent"), string(attr(up as! AXUIElement, "AXRole")) != "AXApplication" else { break }
    container = up as! AXUIElement
    let w = Walk(maxNodes: 300, query: nil, seconds: 1)
    walk(container, depth: 0, visible: frameOf(container) ?? .null, inWeb: false, labelOwner: nil, w)
    for (id, cand) in w.elements {
      guard let node = w.nodes.first(where: { ($0["id"] as? Int) == id }), node["role"] as? String == "button", node["disabled"] == nil else { continue }
      if names.contains(loosely((node["label"] as? String) ?? "")) { return cand }
    }
  }
  return nil
}

/**
 * Presses Return for a field in the background, or its Send button. Returns how, or nil when it
 * can't tell whether anything happened (the text is still there).
 */
func submitInBackground(_ el: AXUIElement, pid: pid_t, expected: String) -> String? {
  // Return goes to whatever has focus in that app: only press it when that's this field, still
  // holding our text, and the app is still behind (if the user brought it forward, they may be typing).
  if isFrontmost(pid) || !holds(el, expected) { return nil }
  if !isFocused(el) {
    AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
    usleep(60_000)
  }
  if !isFocused(el) {
    if let button = sendButton(near: el), AXUIElementPerformAction(button, "AXPress" as CFString) == .success {
      usleep(300_000)
      return holds(el, expected) ? nil : "send-button"
    }
    return nil
  }
  postKey(36, to: pid)
  usleep(300_000)
  // A sent message empties the box; a search keeps its text, so "still there" isn't proof of failure.
  if !holds(el, expected) { return "keys" }
  if let button = sendButton(near: el), AXUIElementPerformAction(button, "AXPress" as CFString) == .success {
    usleep(300_000)
    return holds(el, expected) ? nil : "send-button"
  }
  return nil
}

/**
 * Puts text in a field. Apps in the background are typed into without being brought forward when
 * they allow it; otherwise (and for apps in front) the field is focused (clicked if focusing doesn't
 * take), its text replaced or appended to, and typed like a person, so the app sees normal input.
 * Return (submit) is only pressed when the field still holds the text and the app is still where
 * it was: a chat the user switched meanwhile never gets it.
 */
func setText(_ req: [String: Any]) throws -> [String: Any] {
  let el = try element(req)
  let text = req["text"] as? String ?? ""
  let replace = req["replace"] as? Bool ?? true
  let submit = req["submit"] as? Bool == true
  let old = valueOf(el)
  let pid = pidOf(el)
  let expected = replace ? text : old + text
  var out: [String: Any] = ["typed": text.count]

  // Password fields can't be read back, so there'd be no telling whether a background insert worked.
  let secure = string(attr(el, "AXSubrole")) == "AXSecureTextField"
  if !isFrontmost(pid), !secure, req["background"] as? Bool != false, !text.isEmpty, let how = setTextInBackground(el, text: text, replace: replace, old: old) {
    out["background"] = how
    if submit {
      if let via = submitInBackground(el, pid: pid, expected: expected) {
        out["submitted"] = via
      } else {
        out["submitted"] = "unconfirmed"
        out["value"] = clip(valueOf(el), 300)
      }
    } else {
      out["value"] = clip(valueOf(el), 300)
    }
    return out
  }
  if valueOf(el) != old {
    // Something got in but not all of it: don't type it twice.
    out["value"] = clip(valueOf(el), 300)
    out["partial"] = true
    return out
  }

  try bringForward(el, what: "Typing")
  AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
  usleep(120_000)
  if !isFocused(el) {
    try requireUserPause("Typing")
    clickAndReturn(try center(el))
    usleep(150_000)
  }
  try requireUserPause("Typing")
  if !isFrontmost(pid) { throw Failure(message: "Typing: the app isn't in front any more (the user switched apps). Nothing was typed.", code: "not-front") }
  if replace && !old.isEmpty {
    if !selectAll(el, length: (old as NSString).length) { postKey(0, flags: .maskCommand) }  // Select all.
    usleep(50_000)
    if text.isEmpty { postKey(51) }  // Delete.
  } else if !replace {
    postKey(119, flags: [])  // End: append after what's there.
  }
  try typeText(text)
  usleep(150_000)
  if submit {
    // The same field, with our text, in the app that's still in front: otherwise Return could send
    // something else (the user's half-typed message in another chat).
    if !isFrontmost(pid) || !isFocused(el) || !holds(el, expected) {
      out["submitted"] = "skipped"
      out["value"] = clip(valueOf(el), 300)
      return out
    }
    if userIdleSeconds() < 1.0 {
      out["submitted"] = "skipped"
      out["reason"] = "busy"
      out["value"] = clip(valueOf(el), 300)
      return out
    }
    postKey(36)
    usleep(100_000)
    out["submitted"] = "keys"
  }
  let now = string(attr(el, "AXValue"))
  if let now, !submit { out["value"] = clip(now, 300) }
  return out
}

func click(_ req: [String: Any]) throws -> [String: Any] {
  guard let x = (req["x"] as? NSNumber)?.doubleValue, let y = (req["y"] as? NSNumber)?.doubleValue else { throw Failure(message: "x and y are required.") }
  // A click on ADT Bot's own window (an Allow button, a setting) is refused.
  var hit: AXUIElement?
  if AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &hit) == .success, let hit, isSelf(pidOf(hit)) {
    throw Failure(message: SELF_REFUSAL, code: "self")
  }
  try requireUserPause("Clicking")
  let b = req["button"] as? String
  postClick(CGPoint(x: x, y: y), button: b == "right" ? .right : b == "middle" ? .center : .left, clicks: req["clicks"] as? Int ?? 1)
  return ["ok": true]
}

/** The app named in a request, when it's running and not in front: input can go to it alone. */
func backgroundTarget(_ req: [String: Any]) throws -> pid_t? {
  guard let name = req["app"] as? String, !name.isEmpty else { return nil }
  let pid = try findApp(name)
  return isFrontmost(pid) ? nil : pid
}

/** Types text: into the named app from behind when it isn't in front, else into the app in front. */
func typeCommand(_ req: [String: Any]) throws -> [String: Any] {
  let text = req["text"] as? String ?? ""
  if let pid = try backgroundTarget(req) {
    try typeText(text, to: pid)
    return ["typed": text.count, "to": "app"]
  }
  try requireOtherAppInFront("Typing")
  try requireUserPause("Typing")
  try typeText(text)
  return ["typed": text.count, "to": "front"]
}

let FLAGS: [String: CGEventFlags] = ["command": .maskCommand, "shift": .maskShift, "option": .maskAlternate, "control": .maskControl]

/** A key or shortcut: {code} or {char}, with modifiers; to the named app from behind, or to the front. */
func keyCommand(_ req: [String: Any]) throws -> [String: Any] {
  var flags: CGEventFlags = []
  for m in (req["modifiers"] as? [String]) ?? [] {
    guard let f = FLAGS[m] else { throw Failure(message: "Unknown modifier \(m).") }
    flags.insert(f)
  }
  let pid = try backgroundTarget(req)
  if pid == nil {
    try requireOtherAppInFront("The key")
    try requireUserPause("Pressing the key")
  }
  if let code = req["code"] as? Int {
    postKey(CGKeyCode(code), flags: flags, to: pid)
  } else if let ch = req["char"] as? String, !ch.isEmpty {
    postChar(ch, flags: flags, to: pid)
  } else {
    throw Failure(message: "Give a key code or a character.")
  }
  return ["ok": true, "to": pid == nil ? "front" : "app"]
}

// MARK: Reading text on screen

/**
 * Text in an image (a screenshot) with Apple's on-device text recognition, for what accessibility
 * can't describe: canvases, games, remote desktops, images, apps without accessibility support.
 * Boxes are fractions of the image, top-left origin.
 */
func ocr(_ req: [String: Any]) throws -> [String: Any] {
  guard let path = req["path"] as? String, let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { throw Failure(message: "Couldn't read the screenshot.") }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = req["fast"] as? Bool == true ? .fast : .accurate
  request.usesLanguageCorrection = true
  if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  let lines: [[String: Any]] = (request.results ?? []).compactMap { obs in
    guard let best = obs.topCandidates(1).first else { return nil }
    let b = obs.boundingBox
    return ["text": clip(best.string, 300), "confidence": (Double(best.confidence) * 100).rounded() / 100, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height]
  }
  return ["lines": lines, "width": image.width, "height": image.height]
}

// MARK: Main loop

/** While the Mac is locked, apps report empty windows and input goes to the lock screen. */
func screenLocked() -> Bool {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
  return (session["CGSSessionScreenIsLocked"] as? Bool) == true || (session["CGSSessionScreenIsLocked"] as? Int) == 1
}

// MARK: Teach a task
//
// Records what the user does once, so the app can turn it into a recipe the bots replay: what they
// click (the control's kind and label, the app), what they type into which field, keys and shortcuts,
// and app switches. Listen-only: nothing is changed or blocked. Typing in password fields is never
// recorded (only that something was typed there), ADT Bot's own window is ignored, and recording
// stops by itself after the time limit (10 minutes at most).

final class Recorder {
  var tap: CFMachPort?
  var source: CFRunLoopSource?
  var observer: NSObjectProtocol?
  let started = Date()
  var limit: TimeInterval = 600
  var steps: [[String: Any]] = []
  var stopped = false
  /** The field the latest typing went into (its app and label), to add on to the same step. */
  var typingKey: String?
}
var recorder: Recorder?
let MAX_RECORDED_STEPS = 400

let KEY_NAMES: [Int64: String] = [
  36: "return", 76: "enter", 48: "tab", 53: "escape", 51: "delete", 117: "forward delete",
  123: "left", 124: "right", 125: "down", 126: "up", 115: "home", 119: "end", 116: "page up", 121: "page down",
]

/** The first piece of text inside an element (a button's caption), for unlabeled controls. */
func firstText(_ el: AXUIElement, depth: Int = 0) -> String? {
  if depth > 3 { return nil }
  for child in children(attr(el, "AXChildren")).prefix(8) {
    let role = string(attr(child, "AXRole")) ?? ""
    if role == "AXStaticText", let v = string(attr(child, "AXValue")) ?? string(attr(child, "AXTitle")), !v.isEmpty { return v }
    if let t = firstText(child, depth: depth + 1) { return t }
  }
  return nil
}

/** What a control is, by name: its kind and label, and its app. A caption or icon inside a button counts as the button. */
func describeElement(_ start: AXUIElement) -> [String: Any] {
  var el = start
  for _ in 0..<4 {
    let role = string(attr(el, "AXRole")) ?? ""
    guard role == "AXStaticText" || role == "AXImage", let parent = attr(el, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
    let up = parent as! AXUIElement
    let parentRole = string(attr(up, "AXRole")) ?? ""
    if !ACTIONABLE.contains(parentRole) && parentRole != "AXCell" && parentRole != "AXGroup" { break }
    el = up
  }
  let a = attrs(el)
  let role = string(a["AXRole"]) ?? ""
  let subrole = string(a["AXSubrole"]) ?? ""
  var label = string(a["AXTitle"]) ?? string(a["AXDescription"])
  if label?.isEmpty ?? true {
    if TEXT_INPUT.contains(role) { label = string(a["AXPlaceholderValue"]) ?? string(a["AXHelp"]) }
    else if role == "AXStaticText" { label = string(a["AXValue"]) }
    else { label = firstText(el) }
  }
  let pid = pidOf(el)
  var out: [String: Any] = ["role": SUBROLE[subrole] ?? ROLE[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased(), "app": appInfo(pid)["name"] ?? "", "pid": Int(pid)]
  if let label, !label.isEmpty { out["label"] = clip(label, 80) }
  if subrole == "AXSecureTextField" { out["secure"] = true }
  if TEXT_INPUT.contains(role) || subrole == "AXSearchField" { out["field"] = true }
  return out
}

func recordStep(_ step: [String: Any]) {
  guard let r = recorder, !r.stopped else { return }
  if Date().timeIntervalSince(r.started) > r.limit {
    stopRecording()
    return
  }
  if r.steps.count >= MAX_RECORDED_STEPS { return }
  var s = step
  s["at"] = Int(Date().timeIntervalSince(r.started) * 1000)
  r.steps.append(s)
}

/** A click: the control under the pointer, unless it's ADT Bot's own window. */
func recordClick(_ info: [String: Any], button: String, clicks: Int) {
  guard let pid = info["pid"] as? Int, !isSelf(pid_t(pid)) else { return }
  recorder?.typingKey = nil
  var step = info
  step["kind"] = "click"
  step.removeValue(forKey: "pid")
  if button != "left" { step["button"] = button }
  if clicks > 1 { step["clicks"] = clicks }
  recordStep(step)
}

/**
 * A key: shortcuts and named keys become key steps; characters add on to the typing in the focused
 * field (only "something was typed" for a password field); delete takes back the last character.
 */
func recordKey(code: Int64, chars: String, flags: CGEventFlags, focused: [String: Any]?) {
  guard let r = recorder, !r.stopped else { return }
  if let pid = focused?["pid"] as? Int, isSelf(pid_t(pid)) { return }
  if let front = NSWorkspace.shared.frontmostApplication, isSelf(front.processIdentifier) { return }
  let app = (focused?["app"] as? String) ?? NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
  var mods: [String] = []
  if flags.contains(.maskControl) { mods.append("ctrl") }
  if flags.contains(.maskAlternate) { mods.append("option") }
  if flags.contains(.maskShift) { mods.append("shift") }
  if flags.contains(.maskCommand) { mods.append("cmd") }
  let named = KEY_NAMES[code]
  let shortcut = flags.contains(.maskCommand) || flags.contains(.maskControl)
  if shortcut || (named != nil && named != "delete") {
    r.typingKey = nil
    let key = named ?? chars.lowercased()
    if key.isEmpty { return }
    let combo = (mods.filter { $0 != "shift" || named != nil } + [key]).joined(separator: "+")
    // A password field's shortcuts (paste) aren't news either.
    if focused?["secure"] as? Bool == true, shortcut { return }
    recordStep(["kind": "key", "combo": combo, "app": app])
    return
  }
  let field = (focused?["label"] as? String) ?? ""
  let key = "\(app)|\(field)"
  // Typing whose field can't be identified, or in a terminal (sudo prompts aren't password fields),
  // is never recorded: only that something was typed there.
  let terminal = app.range(of: "^(Terminal|iTerm2?|Warp|kitty|Alacritty|WezTerm|Ghostty|Hyper|Tabby)$", options: .regularExpression) != nil
  if (focused == nil || terminal), named == nil {
    if r.typingKey != key { recordStep(["kind": "type", "app": app, "field": field, "secure": true, "unknown": true]) }
    r.typingKey = key
    return
  }
  if named == "delete" {
    if r.typingKey == key, var last = r.steps.last, last["kind"] as? String == "type", var text = last["text"] as? String, !text.isEmpty {
      text.removeLast()
      last["text"] = text
      r.steps[r.steps.count - 1] = last
    } else {
      recordStep(["kind": "key", "combo": "delete", "app": app])
    }
    return
  }
  if chars.isEmpty || chars.unicodeScalars.allSatisfy({ CharacterSet.controlCharacters.contains($0) }) { return }
  if focused?["secure"] as? Bool == true {
    if r.typingKey != key { recordStep(["kind": "type", "app": app, "field": field, "secure": true]) }
    r.typingKey = key
    return
  }
  if r.typingKey == key, var last = r.steps.last, last["kind"] as? String == "type", last["secure"] == nil {
    last["text"] = ((last["text"] as? String) ?? "") + chars
    r.steps[r.steps.count - 1] = last
  } else {
    recordStep(["kind": "type", "app": app, "field": field, "text": chars])
  }
  r.typingKey = key
}

func recordApp(_ app: NSRunningApplication) {
  if isSelf(app.processIdentifier) { return }
  recorder?.typingKey = nil
  let name = app.localizedName ?? ""
  if let last = recorder?.steps.last, last["kind"] as? String == "app", last["app"] as? String == name { return }
  recordStep(["kind": "app", "app": name, "bundleId": app.bundleIdentifier ?? ""])
}

func recordEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
  // macOS switches a slow tap off; switch it back on.
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap = recorder?.tap { CGEvent.tapEnable(tap: tap, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  switch type {
  case .leftMouseDown, .rightMouseDown:
    let p = event.location
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(systemWide, Float(p.x), Float(p.y), &hit) == .success, let hit {
      var info = describeElement(hit)
      info["x"] = Int(p.x)
      info["y"] = Int(p.y)
      recordClick(info, button: type == .rightMouseDown ? "right" : "left", clicks: Int(event.getIntegerValueField(.mouseEventClickState)))
    }
  case .keyDown:
    var length = 0
    var buffer = [UniChar](repeating: 0, count: 8)
    event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &buffer)
    let chars = String(utf16CodeUnits: buffer, count: length)
    let focused = attr(systemWide, "AXFocusedUIElement").flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? describeElement($0 as! AXUIElement) : nil }
    recordKey(code: event.getIntegerValueField(.keyboardEventKeycode), chars: chars, flags: event.flags, focused: focused)
  default:
    break
  }
  return Unmanaged.passUnretained(event)
}

func startRecording(_ req: [String: Any]) throws -> [String: Any] {
  if recorder != nil, recorder?.stopped == false { throw Failure(message: "Already recording.") }
  guard AXIsProcessTrusted() else { throw Failure(message: "Allow ADT Bot under Accessibility in System Settings → Privacy & Security first.", code: "untrusted") }
  let r = Recorder()
  r.limit = min(max((req["seconds"] as? Double) ?? 600, 10), 600)
  let mask = (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) | (1 << CGEventType.keyDown.rawValue)
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: CGEventMask(mask), callback: recordEvent, userInfo: nil) else {
    throw Failure(message: "macOS didn't let ADT Bot watch the keyboard and mouse. Allow it under Input Monitoring in System Settings → Privacy & Security, then try again.", code: "input-monitoring")
  }
  r.tap = tap
  r.source = CFMachPortCreateRunLoopSource(nil, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), r.source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  r.observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { recordApp(app) }
  }
  recorder = r
  if let front = NSWorkspace.shared.frontmostApplication { recordApp(front) }
  DispatchQueue.main.asyncAfter(deadline: .now() + r.limit) { if recorder === r { stopRecording() } }
  return ["recording": true, "seconds": Int(r.limit)]
}

@discardableResult
func stopRecording() -> [[String: Any]] {
  guard let r = recorder else { return [] }
  if !r.stopped {
    r.stopped = true
    if let tap = r.tap { CGEvent.tapEnable(tap: tap, enable: false) }
    if let source = r.source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    if let observer = r.observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
  }
  return r.steps
}

func recordingStatus() -> [String: Any] {
  guard let r = recorder else { return ["recording": false, "steps": 0] }
  return ["recording": !r.stopped, "steps": r.steps.count, "seconds": Int(Date().timeIntervalSince(r.started))]
}

/**
 * Tests only (ADT_HELPER_TEST=1): feeds made-up clicks, keys and app switches through the same code
 * as real ones, without touching the keyboard or mouse.
 */
func recordInject(_ req: [String: Any]) throws -> [String: Any] {
  guard ProcessInfo.processInfo.environment["ADT_HELPER_TEST"] == "1" else { throw Failure(message: "Unknown command.") }
  if recorder == nil || recorder?.stopped == true {
    let r = Recorder()
    recorder = r
  }
  for e in (req["events"] as? [[String: Any]]) ?? [] {
    switch e["type"] as? String {
    case "click": recordClick(e["element"] as? [String: Any] ?? [:], button: (e["button"] as? String) ?? "left", clicks: (e["clicks"] as? Int) ?? 1)
    case "key":
      var flags: CGEventFlags = []
      for m in (e["modifiers"] as? [String]) ?? [] { if let f = FLAGS[m] { flags.insert(f) } }
      recordKey(code: Int64((e["code"] as? Int) ?? -1), chars: (e["chars"] as? String) ?? "", flags: flags, focused: e["focused"] as? [String: Any])
    case "app":
      recordStep(["kind": "app", "app": (e["app"] as? String) ?? "", "bundleId": ""])
      recorder?.typingKey = nil
    default: break
    }
  }
  return ["steps": recorder?.steps ?? []]
}

let NEEDS_UNLOCKED: Set<String> = ["snapshot", "press", "menuSetting", "setText", "type", "key", "click"]

func handle(_ req: [String: Any]) throws -> Any {
  if let cmd = req["cmd"] as? String, NEEDS_UNLOCKED.contains(cmd), screenLocked() {
    throw Failure(message: "This Mac's screen is locked, so apps can't be seen or used. Ask the user to unlock it, then try again.", code: "locked")
  }
  switch req["cmd"] as? String {
  case "ping": return ["trusted": AXIsProcessTrusted(), "pid": Int(getpid()), "locked": screenLocked(), "idle": userIdleSeconds()]
  case "snapshot": return try snapshot(req)
  case "press": return try press(req)
  case "menuSetting": return try menuSetting(req)
  case "setText": return try setText(req)
  case "type": return try typeCommand(req)
  case "key": return try keyCommand(req)
  case "idle": return ["idle": userIdleSeconds()]
  case "audioOutputs": return audioOutputs()
  case "click": return try click(req)
  case "ocr": return try ocr(req)
  case "front":
    guard let pid = frontApp() else { return NSNull() }
    return appInfo(pid)
  case "recordStart": return try startRecording(req)
  case "recordStop": return ["steps": stopRecording(), "seconds": recordingStatus()["seconds"] ?? 0]
  case "recordStatus": return recordingStatus()
  case "recordInject": return try recordInject(req)
  default: throw Failure(message: "Unknown command.")
  }
}

func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

// Requests are read on a background thread and handled on the main thread, whose run loop keeps
// AppKit's view of running apps current.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    DispatchQueue.main.sync {
      let id = req["id"] ?? NSNull()
      do {
        reply(["id": id, "result": try handle(req)])
      } catch let f as Failure {
        reply(["id": id, "error": f.message, "code": f.code ?? NSNull()])
      } catch {
        reply(["id": id, "error": String(describing: error)])
      }
    }
  }
  exit(0)
}
RunLoop.main.run()
