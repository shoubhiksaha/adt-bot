#!/usr/bin/env python3
# "Control this PC" on Linux: the helper behind electron/features/76-linux-control.cjs. It speaks
# the same JSON-lines protocol as the Windows helper (win-helper.ps1): one request {id, cmd, ...} per
# line on stdin, one reply {id, result} or {id, error, code} per line on stdout. Every user value
# arrives as JSON, never as part of a command line.
#
# What it uses, all already on a normal Linux desktop:
#   - AT-SPI (python3-gi + gir1.2-atspi-2.0) to read apps' controls, press them and fill in fields,
#     on X11 and Wayland alike: the Linux counterpart of macOS accessibility and Windows UI Automation.
#   - X11: libX11/libXtst through ctypes for screenshots, the pointer and the keyboard (the same
#     libraries ADT Bot itself needs), and the window manager's EWMH hints to find windows.
#   - Wayland: the desktop's portals. Screenshots through org.freedesktop.portal.Screenshot, and the
#     pointer and keyboard through org.freedesktop.portal.RemoteDesktop, which asks the person once
#     (the permission is remembered with a restore token in ADT_STATE_DIR).
# It refuses to act on ADT Bot's own windows (ADT_PARENT_PID) and waits for the person to pause
# before it moves the pointer or types (code "busy" if they don't).
import ctypes
import ctypes.util
import json
import os
import re
import shlex
import subprocess
import sys
import time
from configparser import ConfigParser
from ctypes import CFUNCTYPE, POINTER, Structure, Union, byref, c_char_p, c_int, c_long, c_uint, c_ubyte, c_ulong, c_void_p

try:
    import gi

    gi.require_version("GLib", "2.0")
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except Exception:  # noqa: BLE001 - PyGObject missing or broken: AT-SPI and portals are unavailable
    gi = Gio = GLib = None
try:
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception:  # noqa: BLE001
    Atspi = None

PARENT_PID = int(os.environ.get("ADT_PARENT_PID") or 0)
# Inherited from Chromium (ADT Bot): apps opened from here would hide their controls from AT-SPI.
os.environ.pop("NO_AT_BRIDGE", None)
STATE_DIR = os.environ.get("ADT_STATE_DIR") or os.path.join(os.path.expanduser("~"), ".config", "adt-bot", "linux-control")
MISSING_GI = "Reading apps needs AT-SPI for Python: sudo apt install python3-gi gir1.2-atspi-2.0 (Fedora: sudo dnf install python3-gobject at-spi2-core), then restart ADT Bot."
SELF_REFUSAL = "That's ADT Bot itself: bots can't operate its window (its settings and approval buttons are the user's). Name another app."


class Fail(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def clip(value, size):
    text = "" if value is None else str(value)
    return text if len(text) <= size else text[:size]


def session_type():
    forced = os.environ.get("ADT_LINUX_SESSION")
    if forced in ("x11", "wayland"):
        return forced
    if os.environ.get("WAYLAND_DISPLAY") or (os.environ.get("XDG_SESSION_TYPE") or "").lower() == "wayland":
        return "wayland"
    return "x11" if os.environ.get("DISPLAY") else "none"


SESSION = session_type()


def proc_name(pid):
    """The program's name (from its command line: /proc/<pid>/comm stops at 15 characters)."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv0 = f.read().split(b"\0")[0].decode("utf-8", "replace")
        if " " in argv0 and not os.path.exists(argv0):
            # Chromium-based apps (Chrome, VS Code, ADT Bot) rewrite their command line as one
            # string: "/opt/App Name/app --flag …". Keep the longest leading part that is a file.
            cuts = [i for i, ch in enumerate(argv0) if ch == " "]
            argv0 = next((argv0[:i] for i in reversed(cuts) if os.path.isfile(argv0[:i])), argv0.split(" ")[0])
        if argv0:
            return os.path.basename(argv0)
        with open(f"/proc/{pid}/comm", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return f"pid {pid}"


def is_self(pid):
    return bool(pid) and (pid == os.getpid() or (PARENT_PID and pid == PARENT_PID))


# The desktop's own permission and password dialogs (screen sharing, screenshots, remote control,
# administrator passwords). On Linux they are ordinary windows, unlike macOS's and Windows' own: a
# bot must never answer them for the user, least of all its own request for control.
GUARDED = {
    "xdg-desktop-portal", "xdg-desktop-portal-gnome", "xdg-desktop-portal-gtk", "xdg-desktop-portal-kde",
    "xdg-desktop-portal-wlr", "xdg-desktop-portal-hyprland", "xdg-desktop-portal-lxqt", "xdg-desktop-portal-cosmic",
    "polkit-gnome-authentication-agent-1", "polkit-kde-authentication-agent-1", "polkit-mate-authentication-agent-1",
    "lxpolkit", "lxqt-policykit-agent", "xfce-polkit", "mate-polkit", "pinentry", "pinentry-gnome3", "pinentry-qt", "gcr-prompter",
}
GUARDED_REFUSAL = "That's the desktop's own permission or password dialog: only the user can answer it. Ask them to, then carry on."


# Desktop shells draw some of those dialogs themselves (GNOME's "Allow screenshots?", its password
# prompts): guarded while one shows, an ordinary part of the desktop otherwise.
SHELLS = {"gnome-shell"}
_shell_dialog = {}


def shell_dialog_up(pid):
    hit = _shell_dialog.get(pid)
    if hit and time.monotonic() - hit[0] < 0.5:
        return hit[1]
    found, budget = False, [600]

    def walk(acc, depth):
        nonlocal found
        if found or acc is None or depth > 10 or budget[0] <= 0:
            return
        budget[0] -= 1
        has = states_of(acc)
        if depth > 0 and not has(Atspi.StateType.SHOWING):
            return
        if role_of(acc) in ("dialog", "alert", "password text"):
            found = True
            return
        for child in children(acc):
            walk(child, depth + 1)

    if Atspi is not None:
        for app, _name, app_pid, _windows in apps_and_windows():
            if app_pid == pid:
                walk(app, 0)
                break
    _shell_dialog[pid] = (time.monotonic(), found)
    return found


def is_guarded(pid):
    if not pid:
        return False
    name = proc_name(pid).lower()
    return name in GUARDED or (name in SHELLS and shell_dialog_up(pid))


def refusal_for(pid):
    """Why a bot can't operate this app's windows (ADT Bot itself, a system dialog), or None."""
    if is_self(pid):
        return SELF_REFUSAL, "self"
    if is_guarded(pid):
        return GUARDED_REFUSAL, "guarded"
    return None


# ---- X11 through ctypes ------------------------------------------------------------------------


class XImage(Structure):
    _fields_ = [
        ("width", c_int), ("height", c_int), ("xoffset", c_int), ("format", c_int), ("data", c_void_p),
        ("byte_order", c_int), ("bitmap_unit", c_int), ("bitmap_bit_order", c_int), ("bitmap_pad", c_int),
        ("depth", c_int), ("bytes_per_line", c_int), ("bits_per_pixel", c_int),
        ("red_mask", c_ulong), ("green_mask", c_ulong), ("blue_mask", c_ulong), ("obdata", c_void_p),
        ("create_image", c_void_p), ("destroy_image", c_void_p), ("get_pixel", c_void_p),
        ("put_pixel", c_void_p), ("sub_image", c_void_p), ("add_pixel", c_void_p),
    ]


class XClientMessageEvent(Structure):
    _fields_ = [
        ("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", c_void_p), ("window", c_ulong),
        ("message_type", c_ulong), ("format", c_int), ("l", c_long * 5),
    ]


class XEvent(Union):
    _fields_ = [("xclient", XClientMessageEvent), ("pad", c_long * 24)]


class XScreenSaverInfo(Structure):
    _fields_ = [("window", c_ulong), ("state", c_int), ("kind", c_int), ("til_or_since", c_ulong), ("idle", c_ulong), ("eventMask", c_ulong)]


class XRRMonitorInfo(Structure):
    _fields_ = [
        ("name", c_ulong), ("primary", c_int), ("automatic", c_int), ("noutput", c_int),
        ("x", c_int), ("y", c_int), ("width", c_int), ("height", c_int), ("mwidth", c_int), ("mheight", c_int), ("outputs", c_void_p),
    ]


def _lib(name, soname):
    try:
        return ctypes.CDLL(ctypes.util.find_library(name) or soname)
    except OSError:
        return None


# Windows vanish between listing and asking about them: X errors are expected and ignored (the
# default handler would end the process).
_X_ERROR_HANDLER = CFUNCTYPE(c_int, c_void_p, c_void_p)(lambda _d, _e: 0)


class X11:
    def __init__(self):
        x = _lib("X11", "libX11.so.6")
        if x is None:
            raise Fail("libX11 isn't installed.", "missing")
        self.x = x
        x.XOpenDisplay.argtypes = [c_char_p]
        x.XOpenDisplay.restype = c_void_p
        x.XSetErrorHandler.argtypes = [c_void_p]
        x.XSetErrorHandler(ctypes.cast(_X_ERROR_HANDLER, c_void_p))
        self.d = x.XOpenDisplay(None)
        if not self.d:
            raise Fail("Couldn't open the X display.", "missing")
        sig = {
            "XDefaultRootWindow": ([c_void_p], c_ulong),
            "XDefaultScreen": ([c_void_p], c_int),
            "XDisplayWidth": ([c_void_p, c_int], c_int),
            "XDisplayHeight": ([c_void_p, c_int], c_int),
            "XFlush": ([c_void_p], c_int),
            "XSync": ([c_void_p, c_int], c_int),
            "XFree": ([c_void_p], c_int),
            "XInternAtom": ([c_void_p, c_char_p, c_int], c_ulong),
            "XGetWindowProperty": ([c_void_p, c_ulong, c_ulong, c_long, c_long, c_int, c_ulong, POINTER(c_ulong), POINTER(c_int), POINTER(c_ulong), POINTER(c_ulong), POINTER(c_void_p)], c_int),
            "XQueryPointer": ([c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_ulong), POINTER(c_int), POINTER(c_int), POINTER(c_int), POINTER(c_int), POINTER(c_uint)], c_int),
            "XTranslateCoordinates": ([c_void_p, c_ulong, c_ulong, c_int, c_int, POINTER(c_int), POINTER(c_int), POINTER(c_ulong)], c_int),
            "XGetGeometry": ([c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_int), POINTER(c_int), POINTER(c_uint), POINTER(c_uint), POINTER(c_uint), POINTER(c_uint)], c_int),
            "XGetImage": ([c_void_p, c_ulong, c_int, c_int, c_uint, c_uint, c_ulong, c_int], POINTER(XImage)),
            "XKeysymToKeycode": ([c_void_p, c_ulong], c_ubyte),
            "XStringToKeysym": ([c_char_p], c_ulong),
            "XGetKeyboardMapping": ([c_void_p, c_ubyte, c_int, POINTER(c_int)], POINTER(c_ulong)),
            "XChangeKeyboardMapping": ([c_void_p, c_int, c_int, POINTER(c_ulong), c_int], c_int),
            "XDisplayKeycodes": ([c_void_p, POINTER(c_int), POINTER(c_int)], c_int),
            "XSendEvent": ([c_void_p, c_ulong, c_int, c_long, c_void_p], c_int),
        }
        for name, (args, res) in sig.items():
            fn = getattr(x, name)
            fn.argtypes = args
            fn.restype = res
        self.root = x.XDefaultRootWindow(self.d)
        self.screen = x.XDefaultScreen(self.d)
        self.atoms = {}
        self.tst = _lib("Xtst", "libXtst.so.6")
        if self.tst is not None:
            self.tst.XTestFakeMotionEvent.argtypes = [c_void_p, c_int, c_int, c_int, c_ulong]
            self.tst.XTestFakeButtonEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
            self.tst.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
        self.xss = _lib("Xss", "libXss.so.1")
        if self.xss is not None:
            self.xss.XScreenSaverQueryInfo.argtypes = [c_void_p, c_ulong, POINTER(XScreenSaverInfo)]
            self.xss.XScreenSaverQueryExtension.argtypes = [c_void_p, POINTER(c_int), POINTER(c_int)]
            a, b = c_int(), c_int()
            if not self.xss.XScreenSaverQueryExtension(self.d, byref(a), byref(b)):
                self.xss = None
        self.rr = _lib("Xrandr", "libXrandr.so.2")
        if self.rr is not None:
            self.rr.XRRGetMonitors.argtypes = [c_void_p, c_ulong, c_int, POINTER(c_int)]
            self.rr.XRRGetMonitors.restype = POINTER(XRRMonitorInfo)
            self.rr.XRRFreeMonitors.argtypes = [POINTER(XRRMonitorInfo)]
        self.scratch = None

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = self.x.XInternAtom(self.d, name.encode(), 0)
        return self.atoms[name]

    def prop(self, window, name, size=4096):
        kind, fmt, count, after, data = c_ulong(), c_int(), c_ulong(), c_ulong(), c_void_p()
        status = self.x.XGetWindowProperty(self.d, window, self.atom(name), 0, size, 0, 0, byref(kind), byref(fmt), byref(count), byref(after), byref(data))
        if status != 0 or not data.value:
            return None
        try:
            if fmt.value == 32:
                return list((c_ulong * count.value).from_address(data.value))
            if fmt.value == 8:
                return ctypes.string_at(data.value, count.value)
            return None
        finally:
            self.x.XFree(data)

    # Screens, windows and the pointer.

    def geometry(self):
        """The main monitor (or the whole screen), in the screen's pixels."""
        if self.rr is not None:
            count = c_int()
            monitors = self.rr.XRRGetMonitors(self.d, self.root, 1, byref(count))
            if monitors and count.value > 0:
                try:
                    items = [monitors[i] for i in range(count.value)]
                    main = next((m for m in items if m.primary), items[0])
                    return {"x": main.x, "y": main.y, "width": main.width, "height": main.height, "backing": 1}
                finally:
                    self.rr.XRRFreeMonitors(monitors)
        return {"x": 0, "y": 0, "width": self.x.XDisplayWidth(self.d, self.screen), "height": self.x.XDisplayHeight(self.d, self.screen), "backing": 1}

    def window_rect(self, window):
        root, gx, gy, w, h, border, depth = c_ulong(), c_int(), c_int(), c_uint(), c_uint(), c_uint(), c_uint()
        if not self.x.XGetGeometry(self.d, window, byref(root), byref(gx), byref(gy), byref(w), byref(h), byref(border), byref(depth)):
            return None
        x, y, child = c_int(), c_int(), c_ulong()
        if not self.x.XTranslateCoordinates(self.d, window, self.root, 0, 0, byref(x), byref(y), byref(child)):
            return None
        return {"x": x.value, "y": y.value, "width": int(w.value), "height": int(h.value)}

    def windows(self):
        """Managed top-level windows, bottom to top: id, pid, title, bounds (with the frame), hidden."""
        ids = self.prop(self.root, "_NET_CLIENT_LIST_STACKING") or self.prop(self.root, "_NET_CLIENT_LIST") or []
        hidden_atom = self.atom("_NET_WM_STATE_HIDDEN")
        out = []
        for wid in ids:
            rect = self.window_rect(wid)
            if not rect:
                continue
            frame = self.prop(wid, "_NET_FRAME_EXTENTS") or [0, 0, 0, 0]
            if len(frame) == 4:
                rect = {"x": rect["x"] - frame[0], "y": rect["y"] - frame[2], "width": rect["width"] + frame[0] + frame[1], "height": rect["height"] + frame[2] + frame[3]}
            pid = (self.prop(wid, "_NET_WM_PID") or [0])[0]
            title = self.prop(wid, "_NET_WM_NAME") or self.prop(wid, "WM_NAME") or b""
            out.append({"id": wid, "pid": int(pid), "title": clip(title.decode("utf-8", "replace"), 200), "bounds": rect, "hidden": hidden_atom in (self.prop(wid, "_NET_WM_STATE") or [])})
        return out

    def active(self):
        wid = (self.prop(self.root, "_NET_ACTIVE_WINDOW") or [0])[0]
        if not wid:
            return None
        return next((w for w in self.windows() if w["id"] == wid), None)

    def window_at(self, x, y):
        for w in reversed(self.windows()):
            b = w["bounds"]
            if not w["hidden"] and b["x"] <= x < b["x"] + b["width"] and b["y"] <= y < b["y"] + b["height"]:
                return w
        return None

    def activate(self, window):
        event = XEvent()
        event.xclient.type = 33  # ClientMessage
        event.xclient.send_event = 1
        event.xclient.display = self.d
        event.xclient.window = window
        event.xclient.message_type = self.atom("_NET_ACTIVE_WINDOW")
        event.xclient.format = 32
        event.xclient.l[0] = 2  # from a pager or taskbar: window managers honour it
        self.x.XSendEvent(self.d, self.root, 0, (1 << 20) | (1 << 19), byref(event))
        self.x.XFlush(self.d)

    def cursor(self):
        root, child, rx, ry, wx, wy, mask = c_ulong(), c_ulong(), c_int(), c_int(), c_int(), c_int(), c_uint()
        self.x.XQueryPointer(self.d, self.root, byref(root), byref(child), byref(rx), byref(ry), byref(wx), byref(wy), byref(mask))
        return {"x": rx.value, "y": ry.value}

    def idle_ms(self):
        if self.xss is None:
            return None
        info = XScreenSaverInfo()
        if not self.xss.XScreenSaverQueryInfo(self.d, self.root, byref(info)):
            return None
        return int(info.idle)

    def screenshot(self, rect, path):
        """Raw BGRA pixels of a part of the screen, written to path."""
        image = self.x.XGetImage(self.d, self.root, rect["x"], rect["y"], rect["width"], rect["height"], ~0 & 0xFFFFFFFFFFFFFFFF, 2)
        if not image:
            raise Fail("Taking a screenshot: the X server didn't return the screen.")
        try:
            img = image.contents
            if img.bits_per_pixel != 32:
                raise Fail(f"Taking a screenshot: a {img.bits_per_pixel}-bit screen isn't supported.")
            rows = ctypes.string_at(img.data, img.bytes_per_line * img.height)
            width = img.width * 4
            data = bytearray(rows) if img.bytes_per_line == width else bytearray(b"".join(rows[i * img.bytes_per_line : i * img.bytes_per_line + width] for i in range(img.height)))
            if img.red_mask == 0xFF:  # RGBX: make it BGRX
                data[0::4], data[2::4] = data[2::4], data[0::4]
            data[3::4] = b"\xff" * (img.width * img.height)
            with open(path, "wb") as f:
                f.write(data)
            return {"width": img.width, "height": img.height, "format": "bgra"}
        finally:
            ctypes.CFUNCTYPE(c_int, c_void_p)(image.contents.destroy_image)(ctypes.cast(image, c_void_p))

    # Input (XTest).

    def need_xtest(self):
        if self.tst is None:
            raise Fail("Clicking and typing need libXtst (sudo apt install libxtst6).", "missing")

    def move(self, x, y):
        self.need_xtest()
        self.tst.XTestFakeMotionEvent(self.d, -1, int(x), int(y), 0)
        self.x.XFlush(self.d)

    def button(self, number, down):
        self.tst.XTestFakeButtonEvent(self.d, number, 1 if down else 0, 0)
        self.x.XFlush(self.d)

    def click(self, x, y, button, clicks):
        self.move(x, y)
        time.sleep(0.03)
        for i in range(clicks):
            self.button(button, True)
            time.sleep(0.02)
            self.button(button, False)
            if i + 1 < clicks:
                time.sleep(0.06)

    def scroll(self, x, y, dx, dy):
        self.move(x, y)
        for amount, back, forward in ((dy, 4, 5), (dx, 6, 7)):
            for _ in range(min(100, max(1, round(abs(amount) / 50))) if amount else 0):
                self.button(forward if amount > 0 else back, True)
                self.button(forward if amount > 0 else back, False)
                time.sleep(0.01)

    def drag(self, x, y, to_x, to_y):
        self.move(x, y)
        time.sleep(0.05)
        self.button(1, True)
        for i in range(1, 11):
            time.sleep(0.02)
            self.move(x + (to_x - x) * i / 10, y + (to_y - y) * i / 10)
        time.sleep(0.05)
        self.button(1, False)

    def keysym(self, name):
        return self.x.XStringToKeysym(name.encode())

    def _key(self, code, down):
        self.tst.XTestFakeKeyEvent(self.d, code, 1 if down else 0, 0)

    def _scratch(self):
        """A key code with nothing on it, borrowed for characters the keyboard layout doesn't have."""
        if self.scratch is None:
            low, high = c_int(), c_int()
            self.x.XDisplayKeycodes(self.d, byref(low), byref(high))
            per = c_int()
            syms = self.x.XGetKeyboardMapping(self.d, low.value, high.value - low.value + 1, byref(per))
            try:
                for i in range(high.value - low.value, -1, -1):
                    if all(syms[i * per.value + j] == 0 for j in range(per.value)):
                        self.scratch = low.value + i
                        break
            finally:
                self.x.XFree(syms)
        return self.scratch

    def _code_for(self, keysym):
        """(key code, needs shift, borrowed) for a keysym."""
        code = self.x.XKeysymToKeycode(self.d, keysym)
        if code:
            per = c_int()
            syms = self.x.XGetKeyboardMapping(self.d, code, 1, byref(per))
            try:
                if syms[0] == keysym:
                    return code, False, False
                if per.value > 1 and syms[1] == keysym:
                    return code, True, False
            finally:
                self.x.XFree(syms)
        scratch = self._scratch()
        if not scratch:
            raise Fail("The keyboard has no free key to type that character with.")
        pair = (c_ulong * 2)(keysym, keysym)
        self.x.XChangeKeyboardMapping(self.d, scratch, 2, pair, 1)
        self.x.XSync(self.d, 0)
        time.sleep(0.02)
        return scratch, False, True

    def press(self, keysym, modifiers=()):
        self.need_xtest()
        mods = [self.x.XKeysymToKeycode(self.d, self.keysym(m)) for m in modifiers]
        code, shift, borrowed = self._code_for(keysym)
        shift_code = self.x.XKeysymToKeycode(self.d, self.keysym("Shift_L")) if shift and "Shift_L" not in modifiers else 0
        held = [m for m in mods if m] + ([shift_code] if shift_code else [])
        for m in held:
            self._key(m, True)
        self._key(code, True)
        self._key(code, False)
        for m in reversed(held):
            self._key(m, False)
        self.x.XSync(self.d, 0)
        if borrowed:
            time.sleep(0.02)
            empty = (c_ulong * 2)(0, 0)
            self.x.XChangeKeyboardMapping(self.d, code, 2, empty, 1)
            self.x.XSync(self.d, 0)

    def type_text(self, text):
        for ch in text:
            self.press(char_keysym(ch, self.keysym))
            time.sleep(0.008)


def char_keysym(ch, named):
    if ch == "\n":
        return named("Return")
    if ch == "\t":
        return named("Tab")
    cp = ord(ch)
    return cp if 0x20 <= cp <= 0x7E or 0xA0 <= cp <= 0xFF else 0x01000000 | cp


_x11 = None


def x11():
    global _x11
    if SESSION != "x11":
        raise Fail("This needs an X11 session.", "missing")
    if _x11 is None:
        _x11 = X11()
    return _x11


# ---- Wayland: the desktop portals --------------------------------------------------------------

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
BUTTONS = {1: 0x110, 2: 0x112, 3: 0x111}  # left, middle, right as evdev codes


class Portal:
    def __init__(self):
        if Gio is None:
            raise Fail("Controlling the screen on Wayland needs PyGObject: sudo apt install python3-gi (Fedora: python3-gobject).", "missing")
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = None
        self.streams = []
        self.counter = 0

    def _token(self):
        self.counter += 1
        return f"adtbot{os.getpid()}_{self.counter}"

    def _request(self, iface, method, args, make, timeout):
        """Calls a portal method that answers with a Request's Response signal: (code, results)."""
        token = self._token()
        sender = self.bus.get_unique_name()[1:].replace(".", "_")
        path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
        answer = {}
        loop = GLib.MainLoop()

        def on_response(_conn, _sender, _path, _iface, _signal, params):
            answer["code"], answer["results"] = params.unpack()
            loop.quit()

        sub = self.bus.signal_subscribe(PORTAL, "org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NONE, on_response)
        try:
            self.bus.call_sync(PORTAL, PORTAL_PATH, iface, method, make(token), None, Gio.DBusCallFlags.NONE, 30_000, None)
            timer = GLib.timeout_add(int(timeout * 1000), loop.quit)
            loop.run()
            if "code" in answer:
                GLib.source_remove(timer)
        except GLib.Error as error:
            raise Fail(f"The desktop's {iface.rsplit('.', 1)[-1]} portal isn't available ({error.message}).", "missing") from error
        finally:
            self.bus.signal_unsubscribe(sub)
        if "code" not in answer:
            raise Fail("The desktop didn't answer (a permission dialog may be waiting on screen).", "timeout")
        return answer["code"], answer["results"]

    @staticmethod
    def _opts(token, **extra):
        options = {"handle_token": GLib.Variant("s", token)}
        options.update(extra)
        return GLib.Variant("a{sv}", options)

    # Screenshots

    def screenshot(self, path):
        code, results = self._request(
            "org.freedesktop.portal.Screenshot", "Screenshot", None,
            lambda t: GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", t), "interactive": GLib.Variant("b", False)})), 60,
        )
        if code != 0 or not results.get("uri"):
            raise Fail("Taking a screenshot: the desktop said no. Allow ADT Bot to take screenshots when it asks (or in the system's privacy settings).", "denied")
        source = Gio.File.new_for_uri(results["uri"]).get_path()
        try:
            with open(source, "rb") as f:
                data = f.read()
        finally:
            # The portal saved it in the person's Pictures folder for us: don't leave it there.
            try:
                os.remove(source)
            except OSError:
                pass
        with open(path, "wb") as f:
            f.write(data)
        return {"format": "png"}

    # The pointer and keyboard

    def _token_file(self):
        return os.path.join(STATE_DIR, "remote-desktop-token")

    def connect(self, ask):
        """Starts a remote-desktop session. Without `ask`, only with a saved permission (no dialog)."""
        if self.session:
            return
        try:
            with open(self._token_file(), encoding="utf-8") as f:
                restore = f.read().strip()
        except OSError:
            restore = ""
        if not restore and not ask:
            raise Fail("On Wayland, controlling the pointer and keyboard needs the user's OK once: Settings → Computer control → Allow control on Wayland.", "needs-approval")
        rd = "org.freedesktop.portal.RemoteDesktop"
        code, results = self._request(rd, "CreateSession", None, lambda t: GLib.Variant("(a{sv})", ({"handle_token": GLib.Variant("s", t), "session_handle_token": GLib.Variant("s", t + "s")},)), 30)
        if code != 0:
            raise Fail("The desktop wouldn't start a remote-control session.", "denied")
        session = results["session_handle"]
        extra = {"types": GLib.Variant("u", 3), "persist_mode": GLib.Variant("u", 2)}
        if restore:
            extra["restore_token"] = GLib.Variant("s", restore)
        code, _ = self._request(rd, "SelectDevices", None, lambda t: GLib.Variant("(oa{sv})", (session, {"handle_token": GLib.Variant("s", t), **extra})), 30)
        if code != 0:
            raise Fail("The desktop wouldn't give ADT Bot the pointer and keyboard.", "denied")
        # A screen too, so clicks can go to exact points on it.
        code, _ = self._request(
            "org.freedesktop.portal.ScreenCast", "SelectSources", None,
            lambda t: GLib.Variant("(oa{sv})", (session, {"handle_token": GLib.Variant("s", t), "types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", False)})), 30,
        )
        if code != 0:
            raise Fail("The desktop wouldn't share the screen for clicking at points.", "denied")
        code, results = self._request(rd, "Start", None, lambda t: GLib.Variant("(osa{sv})", (session, "", {"handle_token": GLib.Variant("s", t)})), 180 if ask or not restore else 30)
        if code != 0:
            try:
                os.remove(self._token_file())
            except OSError:
                pass
            raise Fail("Control wasn't allowed (the dialog was closed or refused).", "denied")
        if not int(results.get("devices", 0)) & 3:
            # Shared, but with "Allow Remote Interaction" off: no pointer or keyboard.
            try:
                self.bus.call_sync(PORTAL, session, "org.freedesktop.portal.Session", "Close", None, None, Gio.DBusCallFlags.NONE, 5_000, None)
            except GLib.Error:
                pass
            raise Fail('The pointer and keyboard weren\'t allowed: in the desktop\'s dialog, turn on "Allow Remote Interaction" (and tick "Remember This Selection" so it asks only once), then Share.', "denied")
        self.session = session
        self.streams = [{"node": node, **{k: tuple(v) if isinstance(v, (list, tuple)) else v for k, v in props.items()}} for node, props in results.get("streams", [])]
        token = results.get("restore_token")
        if token:
            os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
            with open(os.open(self._token_file(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
                f.write(token)

    def geometry(self):
        if not self.streams:
            return None
        s = self.streams[0]
        x, y = s.get("position", (0, 0))
        w, h = s.get("size", (0, 0))
        return {"x": x, "y": y, "width": w, "height": h} if w and h else None

    def _notify(self, method, signature, *args):
        if not self.session:
            self.connect(False)
        try:
            self.bus.call_sync(PORTAL, PORTAL_PATH, "org.freedesktop.portal.RemoteDesktop", method, GLib.Variant(signature, (self.session, {}, *args)), None, Gio.DBusCallFlags.NONE, 5_000, None)
        except GLib.Error as error:
            # The session ended (the person stopped it, or logged out): start again next time.
            self.session = None
            raise Fail(f"The remote-control session ended ({error.message}). Try again.", "stale") from error

    def move(self, x, y):
        if not self.session:
            self.connect(False)
        if not self.streams:
            raise Fail("The desktop shared no screen, so the pointer can't go to a point.", "missing")
        s = self.streams[0]
        ox, oy = s.get("position", (0, 0))
        self._notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", s["node"], float(x - ox), float(y - oy))

    def button(self, number, down):
        self._notify("NotifyPointerButton", "(oa{sv}iu)", BUTTONS[number], 1 if down else 0)

    def click(self, x, y, button, clicks):
        self.move(x, y)
        time.sleep(0.03)
        for i in range(clicks):
            self.button(button, True)
            time.sleep(0.02)
            self.button(button, False)
            if i + 1 < clicks:
                time.sleep(0.06)

    def scroll(self, x, y, dx, dy):
        self.move(x, y)
        for axis, amount in ((0, dy), (1, dx)):
            if amount:
                steps = max(1, min(100, round(abs(amount) / 50)))
                self._notify("NotifyPointerAxisDiscrete", "(oa{sv}ui)", axis, steps if amount > 0 else -steps)

    def drag(self, x, y, to_x, to_y):
        self.move(x, y)
        time.sleep(0.05)
        self.button(1, True)
        for i in range(1, 11):
            time.sleep(0.02)
            self.move(x + (to_x - x) * i / 10, y + (to_y - y) * i / 10)
        time.sleep(0.05)
        self.button(1, False)

    def keysym(self, name):
        return KEYSYMS.get(name) or (ord(name) if len(name) == 1 else 0)

    def _key(self, keysym, down):
        if self.session is None or getattr(self, "_warm", None) != self.session:
            # The desktop sets up its virtual keyboard on the first key of a session and drops that
            # key: send a harmless one first (releasing a Shift that isn't held).
            self._notify("NotifyKeyboardKeysym", "(oa{sv}iu)", 0xFFE1, 0)
            self._warm = self.session
            time.sleep(0.05)
        self._notify("NotifyKeyboardKeysym", "(oa{sv}iu)", keysym, 1 if down else 0)

    def press(self, keysym, modifiers=()):
        mods = [KEYSYMS[m] for m in modifiers]
        for m in mods:
            self._key(m, True)
        self._key(keysym, True)
        self._key(keysym, False)
        for m in reversed(mods):
            self._key(m, False)

    def type_text(self, text):
        for ch in text:
            self.press(char_keysym(ch, self.keysym))
            time.sleep(0.008)


# The keysyms the key command uses (Wayland has no XStringToKeysym).
KEYSYMS = {
    "Return": 0xFF0D, "Tab": 0xFF09, "space": 0x20, "BackSpace": 0xFF08, "Delete": 0xFFFF, "Escape": 0xFF1B,
    "Caps_Lock": 0xFFE5, "Insert": 0xFF63, "Help": 0xFF6A, "Home": 0xFF50, "End": 0xFF57, "Prior": 0xFF55,
    "Next": 0xFF56, "Left": 0xFF51, "Up": 0xFF52, "Right": 0xFF53, "Down": 0xFF54,
    "Shift_L": 0xFFE1, "Control_L": 0xFFE3, "Alt_L": 0xFFE9, "Super_L": 0xFFEB,
    "XF86AudioRaiseVolume": 0x1008FF13, "XF86AudioLowerVolume": 0x1008FF11, "XF86AudioMute": 0x1008FF12,
    **{f"F{i}": 0xFFBE + i - 1 for i in range(1, 20)},
}

_portal = None


def portal():
    global _portal
    if _portal is None:
        _portal = Portal()
    return _portal


def input_backend():
    return x11() if SESSION == "x11" else portal()


# ---- The person: idle, locked ------------------------------------------------------------------

_last_posted = 0.0
# Before the first reading, assume the person has been away a while.
_last_user = time.monotonic() - 3600


def _dbus_call(name, path, iface, method, signature="()"):
    if Gio is None:
        return None
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        reply = bus.call_sync(name, path, iface, method, None, GLib.VariantType.new(signature) if signature != "()" else None, Gio.DBusCallFlags.NONE, 1_000, None)
        return reply.unpack()[0] if reply is not None else None
    except Exception:  # noqa: BLE001 - not on this desktop
        return None


def _idle_ms():
    if SESSION == "x11":
        try:
            return x11().idle_ms()
        except Fail:
            return None
    value = _dbus_call("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "GetIdletime", "(t)")
    if value is not None:
        return int(value)
    value = _dbus_call("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", "GetSessionIdleTime", "(u)")
    return int(value) * 1000 if value is not None else None


def user_idle_seconds():
    """Seconds since the person last used the keyboard or mouse, not counting this helper's own input."""
    global _last_user
    idle = _idle_ms()
    if idle is None:
        return None
    last_input = time.monotonic() - idle / 1000.0
    if last_input > _last_posted + 0.3 and last_input > _last_user:
        _last_user = last_input
    return max(0.0, time.monotonic() - _last_user)


def mark_posted():
    global _last_posted
    _last_posted = time.monotonic()


def require_user_pause(what):
    deadline = time.monotonic() + 4
    while True:
        idle = user_idle_seconds()
        if idle is None or idle >= 1.2:
            return
        if time.monotonic() > deadline:
            raise Fail(f"{what}: the user is using this PC right now (keyboard or mouse used {idle:.1f} s ago). Wait for them to pause and try again, or work in the background (mac_ui, mac_press, mac_set_text with the app named).", "busy")
        time.sleep(0.25)


def locked():
    for name, path in (("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"), ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver")):
        value = _dbus_call(name, path, name, "GetActive", "(b)")
        if value is not None:
            return bool(value)
    return False


# ---- Apps and their controls (AT-SPI) ----------------------------------------------------------

ROLES = {
    "push button": "button", "toggle button": "button", "button": "button", "check box": "checkbox", "radio button": "radio button",
    "combo box": "combo box", "entry": "text field", "password text": "text field", "text": "text field", "document text": "text area",
    "link": "link", "menu item": "menu item", "check menu item": "menu item", "radio menu item": "menu item", "page tab": "tab",
    "list item": "row", "table row": "row", "tree item": "row", "table cell": "row", "slider": "slider", "spin button": "stepper",
    "heading": "heading", "label": "text", "static": "text", "image": "image", "icon": "image", "push button menu": "menu button",
    "menu": "menu item", "switch": "checkbox",
}
TEXT_INPUT = {"entry", "password text", "text", "document text", "spin button", "combo box"}
ACTIONABLE = {"push button", "toggle button", "button", "check box", "radio button", "combo box", "link", "menu item", "check menu item", "radio menu item", "page tab", "list item", "table row", "tree item", "table cell", "push button menu", "menu", "switch"}
TOPLEVEL = {"frame", "window", "dialog", "alert", "file chooser"}
MENU_ROLES = {"menu", "menu item", "check menu item", "radio menu item", "menu bar"}
PRESS_ACTIONS = ("click", "press", "activate", "toggle", "jump", "select", "open", "expand or contract")

_atspi_ready = False
_current = {}
_previous = {}
_next_id = 1


def atspi():
    global _atspi_ready
    if Atspi is None:
        raise Fail(MISSING_GI, "missing")
    if not _atspi_ready:
        Atspi.init()
        # Browsers and Electron apps only build their accessibility tree when something asks for it.
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set", GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))), None, Gio.DBusCallFlags.NONE, 2_000, None)
        except Exception:  # noqa: BLE001 - no accessibility bus switch on this desktop
            pass
        _atspi_ready = True
    return Atspi


def safe(fn, default=None):
    try:
        return fn()
    except Exception:  # noqa: BLE001 - the app went away or doesn't answer this
        return default


def role_of(acc):
    return safe(lambda: acc.get_role_name(), "") or ""


def states_of(acc):
    states = safe(lambda: acc.get_state_set())
    return (lambda s: bool(states) and safe(lambda: states.contains(s), False))


def ifaces_of(acc):
    return set(safe(lambda: acc.get_interfaces(), []) or [])


def text_of(acc, size=100_000):
    """A text field's or text area's contents (Accessible.get_text is something else: the Text interface's)."""
    count = safe(lambda: Atspi.Text.get_character_count(acc), 0) or 0
    return clip(safe(lambda: Atspi.Text.get_text(acc, 0, min(count, size)), "") if count else "", size)


def children(acc, limit=400):
    count = safe(lambda: acc.get_child_count(), 0) or 0
    for i in range(min(count, limit)):
        child = safe(lambda i=i: acc.get_child_at_index(i))
        if child is not None:
            yield child


def apps_and_windows():
    """[(app accessible, name, pid, [toplevel windows])], ADT Bot's own included (callers decide)."""
    A = atspi()
    desktop = A.get_desktop(0)
    out = []
    for app in children(desktop, 200):
        pid = safe(lambda app=app: app.get_process_id(), 0) or 0
        name = safe(lambda app=app: app.get_name(), "") or proc_name(pid)
        windows = [w for w in children(app, 60) if role_of(w) in TOPLEVEL]
        out.append((app, name, pid, windows))
    return out


def is_active(window):
    s = states_of(window)
    return s(Atspi.StateType.ACTIVE)


def window_title(window):
    return clip(safe(lambda: window.get_name(), "") or "", 120)


def extents(acc, kind):
    rect = safe(lambda: acc.get_extents(kind))
    # Hidden things (a closed menu's items) report nonsense like x = -2147483648.
    if rect is None or rect.width <= 0 or rect.height <= 0 or rect.width > 100_000 or abs(rect.x) > 100_000 or abs(rect.y) > 100_000:
        return None
    return {"x": int(rect.x), "y": int(rect.y), "w": int(rect.width), "h": int(rect.height)}


def screen_offset(window, pid):
    """
    How to turn a window's frames into screen points: (coordinate type, x to add, y to add), or None
    when it can't be done. GTK 4 doesn't know where its window is and reports positions inside the
    window only: on X11 the window manager knows where the window is. On Wayland nobody tells apps,
    so frames are left out.
    """
    if SESSION != "x11":
        return None
    top = extents(window, Atspi.CoordType.SCREEN)
    if top is None:
        return None
    app = safe(lambda: window.get_application())
    toolkit = (safe(lambda: app.get_toolkit_name(), "") or "").lower() if app is not None else ""
    version = (safe(lambda: app.get_toolkit_version(), "") or "") if app is not None else ""
    gtk4 = toolkit == "gtk" and version.startswith("4")
    if not gtk4 and (top["x"] != 0 or top["y"] != 0):
        return (Atspi.CoordType.SCREEN, 0, 0)
    title = window_title(window)
    try:
        candidates = [w for w in x11().windows() if w["pid"] == pid and not w["hidden"]]
    except Fail:
        candidates = []
    match = next((w for w in candidates if w["title"] == title), candidates[0] if candidates else None)
    if not match:
        return None if gtk4 else (Atspi.CoordType.SCREEN, 0, 0)
    # The client area (without the window manager's frame) is where the toolkit draws.
    inner = x11().window_rect(match["id"]) or match["bounds"]
    return (Atspi.CoordType.WINDOW, inner["x"], inner["y"])


def app_matches(name, pid, windows, want):
    want = want.lower()
    own = {name.lower(), proc_name(pid).lower()} - {""}
    # By its own name, or by the launcher name of the app it runs ("Text Editor" -> mousepad).
    if want in own or own & {n.lower() for n in desktop_names_for(want)}:
        return 3
    if any(n.startswith(want) for n in own):
        return 2
    if any(want in window_title(w).lower() for w in windows):
        return 1
    return 0


def names_self(want):
    """True when a name means ADT Bot itself ("ADT Bot", "adt-bot", or its program's name)."""
    squash = lambda value: re.sub(r"[\s_.-]+", "", value.lower())
    own = {"adtbot"} | ({squash(proc_name(PARENT_PID))} if PARENT_PID else set())
    return squash(want) in own


def find_window(app_name, window_name):
    """The top-level window to read: by title, by app, else the app in front. Never ADT Bot's own."""
    if app_name and names_self(app_name):
        raise Fail(SELF_REFUSAL, "self")
    entries = apps_and_windows()
    refused = None
    if window_name:
        want = window_name.lower()
        for _app, _name, pid, windows in entries:
            for w in windows:
                if want in window_title(w).lower():
                    if refusal_for(pid):
                        refused = refusal_for(pid)
                        continue
                    return w, pid
    if app_name:
        best = ((0, False), None, 0)
        for _app, name, pid, windows in entries:
            score = app_matches(name, pid, windows, app_name)
            if not score:
                continue
            if refusal_for(pid):
                refused = refusal_for(pid)
                continue
            # The best match; among copies of the app, the one in front.
            active = next((w for w in windows if is_active(w)), None)
            if windows and (score, active is not None) > best[0]:
                best = ((score, active is not None), active or windows[0], pid)
        if best[1] is not None:
            return best[1], best[2]
        if refused:
            raise Fail(*refused)
        raise Fail(f'"{app_name}" isn\'t running, or it doesn\'t show its controls to accessibility tools. Open it first (mac_open_app).', "not-running")
    if refused:
        raise Fail(*refused)
    for _app, _name, pid, windows in entries:
        if is_self(pid):
            continue
        for w in windows:
            if is_active(w):
                if is_guarded(pid):
                    # The desktop is asking the user something: that comes first.
                    raise Fail(GUARDED_REFUSAL, "guarded")
                return w, pid
    for _app, _name, pid, windows in entries:
        if not refusal_for(pid) and windows:
            return windows[0], pid
    return None, 0


def front_pid():
    """The app in front: the window manager's active window on X11, else the active AT-SPI window."""
    if SESSION == "x11":
        try:
            w = x11().active()
            if w:
                return w["pid"]
        except Fail:
            pass
    if Atspi is None:
        return 0
    for _app, _name, pid, windows in apps_and_windows():
        if any(is_active(w) for w in windows):
            return pid
    return 0


def snapshot(req):
    global _current, _previous, _next_id
    window, pid = find_window(clip(req.get("app"), 200).strip(), clip(req.get("window"), 200).strip())
    max_nodes = max(20, min(600, int(req.get("max") or 200)))
    words = [w for w in clip(req.get("query"), 200).lower().split() if w]
    deadline = time.monotonic() + (8 if req.get("menus") else 4)
    nodes, ids = [], {}
    state = {"visited": 0, "truncated": False}
    offset = screen_offset(window, pid) if window is not None else None

    def frame_of(acc):
        if offset is None:
            return None
        f = extents(acc, offset[0])
        return {"x": f["x"] + offset[1], "y": f["y"] + offset[2], "w": f["w"], "h": f["h"]} if f else None

    def walk(acc, owner, depth):
        global _next_id
        if state["visited"] >= 6000 or time.monotonic() > deadline or depth > 60:
            state["truncated"] = True
            return
        state["visited"] += 1
        role = role_of(acc)
        has = states_of(acc)
        showing = has(Atspi.StateType.SHOWING)
        name = clip(safe(lambda: acc.get_name(), "") or "", 200).strip()
        kind = ROLES.get(role)
        new_owner = owner
        if kind in ("text", "image"):
            text = name or (clip(safe(lambda: acc.get_description(), ""), 200) if kind == "image" else "")
            if owner is not None and text:
                n = nodes[owner]
                label = n.get("label", "")
                if len(label) < 90 and text not in label:
                    n["label"] = clip(text if not label else f"{label} · {text}", 120)
                kind = None
            elif kind == "image" or not text:
                kind = None
        in_menus = bool(req.get("menus")) and role in MENU_ROLES
        if kind and (showing or in_menus) and not (role == "menu" and not req.get("menus")):
            ifaces = ifaces_of(acc)
            node = {"id": _next_id, "role": kind}
            label = name
            value = None
            editable = "EditableText" in ifaces and has(Atspi.StateType.EDITABLE)
            if role in ("text", "document text") and not editable:
                # Read-only text (a label, a paragraph in a browser) isn't a field.
                kind = "text"
                label = label or text_of(acc, 200).strip()
            elif role in TEXT_INPUT or editable:
                if "Text" in ifaces:
                    value = text_of(acc, 300)
                if not label:
                    label = clip(safe(lambda: acc.get_description(), ""), 120)
            elif "Value" in ifaces and role in ("slider", "spin button"):
                value = str(safe(lambda: acc.get_current_value(), ""))
            if kind == "text":
                node["label"] = clip(label, 200)
            elif label:
                node["label"] = clip(label, 120)
            if value:
                node["value"] = value
            frame = frame_of(acc)
            if frame:
                node["frame"] = frame
            if not has(Atspi.StateType.ENABLED) and not has(Atspi.StateType.SENSITIVE) and kind != "text":
                node["disabled"] = True
            if has(Atspi.StateType.FOCUSED):
                node["focused"] = True
            if has(Atspi.StateType.CHECKED) or has(Atspi.StateType.SELECTED) or has(Atspi.StateType.PRESSED):
                node["selected"] = True
            if editable or role in ("entry", "password text", "spin button"):
                node["input"] = True
            ids[_next_id] = acc
            _next_id += 1
            if kind != "text" or node.get("label"):
                nodes.append(node)
                if role in ACTIONABLE:
                    new_owner = len(nodes) - 1
            if len(nodes) >= max_nodes * 4:
                state["truncated"] = True
                return
        # Hidden parts are skipped; closed menus too, unless the menus were asked for.
        if not showing and depth > 0 and not in_menus:
            return
        for child in children(acc):
            if state["truncated"]:
                return
            walk(child, new_owner, depth + 1)

    _previous, _current = _current, {}
    if window is not None:
        walk(window, None, 0)
    if words:
        nodes = [n for n in nodes if all(w in f'{n.get("label", "")} {n.get("value", "")} {n["role"]}'.lower() for w in words)]
    matched = len(nodes)
    if len(nodes) > max_nodes:
        nodes = nodes[:max_nodes]
        state["truncated"] = True
    _current = ids
    titles = []
    app_name = proc_name(pid) if pid else clip(req.get("app"), 80)
    for _app, name, apid, windows in apps_and_windows() if window is not None else []:
        if apid == pid:
            app_name = name or app_name
            titles = [t for t in (window_title(w) for w in windows) if t]
    out = {
        "name": clip(app_name, 80), "bundleId": None, "pid": pid, "window": window_title(window) if window is not None else "",
        "windows": titles, "elements": nodes, "matched": matched, "truncated": state["truncated"],
        "frontmost": bool(pid) and pid == front_pid(),
    }
    if window is None:
        out["note"] = "No window could be read."
    elif offset is None and SESSION == "wayland":
        out["note"] = "On Wayland apps don't know where they are on screen: act on controls by id (mac_press, mac_set_text), or click points in a screenshot."
    return out


def resolve(req):
    eid = int(req.get("element") or 0)
    acc = _current.get(eid) or _previous.get(eid)
    if acc is None:
        raise Fail(f"Element {eid} isn't in the latest UI list. List the UI again (mac_ui).", "stale")
    if not role_of(acc) or states_of(acc)(Atspi.StateType.DEFUNCT):
        raise Fail("That element is gone (the window changed). List the UI again (mac_ui).", "stale")
    pid = safe(lambda: acc.get_process_id(), 0) or 0
    if refusal_for(pid):
        raise Fail(*refusal_for(pid))
    return acc, pid


def element_center(acc, pid):
    window = acc
    for _ in range(80):
        parent = safe(lambda window=window: window.get_parent())
        if parent is None or role_of(parent) == "application":
            break
        window = parent
    offset = screen_offset(window, pid)
    frame = extents(acc, offset[0]) if offset is not None else None
    if not frame:
        raise Fail("That element has no position on screen" + (" (on Wayland apps don't report one); use press instead." if SESSION == "wayland" else "."))
    return frame["x"] + offset[1] + frame["w"] // 2, frame["y"] + offset[2] + frame["h"] // 2


def bring_forward(pid, what):
    if not pid or pid == front_pid():
        return
    if SESSION != "x11":
        raise Fail(f"{what}: the app isn't in front, and on Wayland ADT Bot can't bring other apps forward. Open it first (mac_open_app) or ask the user to switch to it.", "not-front")
    require_user_pause(what)
    windows = [w for w in x11().windows() if w["pid"] == pid]
    if windows:
        x11().activate(windows[-1]["id"])
    for _ in range(20):
        if pid == front_pid():
            return
        time.sleep(0.05)
    raise Fail(f"{what}: the app didn't come to the front (the user may have switched apps). Nothing was done.", "not-front")


def press(req):
    acc, pid = resolve(req)
    how = req.get("action") or "press"
    if how == "press":
        count = safe(lambda: acc.get_n_actions(), 0) or 0
        names = [(safe(lambda i=i: acc.get_action_name(i), "") or "").lower() for i in range(count)]
        for wanted in PRESS_ACTIONS:
            if wanted in names:
                if safe(lambda: acc.do_action(names.index(wanted)), False) is not False:
                    return {"method": wanted}
        if count:
            safe(lambda: acc.do_action(0))
            return {"method": names[0] or "action"}
    if how == "focus" or how == "press":
        ok = bool(safe(lambda: acc.grab_focus(), False))
        if how == "focus":
            return {"method": "focus", "ok": ok}
    x, y = element_center(acc, pid)
    bring_forward(pid, "Clicking")
    require_user_pause("Clicking")
    time.sleep(0.08)
    click_and_return(x, y, 3 if how == "right_click" else 1, 2 if how == "double_click" else 1)
    return {"method": "click", "x": x, "y": y}


def click_and_return(x, y, button, clicks):
    """A real click; the pointer goes back where it was (X11) so the person can keep working."""
    backend = input_backend()
    was = x11().cursor() if SESSION == "x11" else None
    mark_posted()
    backend.click(x, y, button, clicks)
    if was:
        time.sleep(0.04)
        backend.move(was["x"], was["y"])
    mark_posted()


def loose(text):
    return re.sub(r"[‎‏‪-‮⁦-⁩﻿\s]", "", str(text or "")).lower()


def set_text(req):
    acc, pid = resolve(req)
    text = str(req.get("text") or "")
    replace = req.get("replace") is not False
    submit = req.get("submit") is True
    ifaces = ifaces_of(acc)
    read = lambda: text_of(acc) if "Text" in ifaces else ""  # noqa: E731
    old = read()
    expected = text if replace else old + text
    out = {"typed": len(text)}
    if "EditableText" in ifaces:
        safe(lambda: Atspi.EditableText.set_text_contents(acc, expected))
        time.sleep(0.08)
        now = read()
        if loose(now) == loose(expected):
            out["background"] = "value"
            out["value"] = clip(now, 300)
            if submit:
                count = safe(lambda: acc.get_n_actions(), 0) or 0
                names = [(safe(lambda i=i: acc.get_action_name(i), "") or "").lower() for i in range(count)]
                if "activate" in names and safe(lambda: acc.do_action(names.index("activate")), False) is not False:
                    out["submitted"] = "action"
                elif pid == front_pid() and (user_idle_seconds() or 9) >= 1.0:
                    safe(lambda: acc.grab_focus())
                    mark_posted()
                    input_backend().press(input_backend().keysym("Return"))
                    out["submitted"] = "keys"
                else:
                    out["submitted"] = "skipped"
            return out
    # Typed like a person: the field focused, the app in front, the person idle.
    bring_forward(pid, "Typing")
    safe(lambda: acc.grab_focus())
    time.sleep(0.12)
    if not states_of(acc)(Atspi.StateType.FOCUSED):
        require_user_pause("Typing")
        x, y = element_center(acc, pid)
        click_and_return(x, y, 1, 1)
        time.sleep(0.15)
    require_user_pause("Typing")
    if pid != front_pid():
        raise Fail("Typing: the app isn't in front any more (the user switched apps). Nothing was typed.", "not-front")
    backend = input_backend()
    mark_posted()
    if replace and old:
        backend.press(backend.keysym("a"), ["Control_L"])
        time.sleep(0.05)
        if not text:
            backend.press(backend.keysym("Delete"))
    elif not replace:
        backend.press(backend.keysym("End"), ["Control_L"])
    backend.type_text(text)
    time.sleep(0.15)
    now = read()
    if submit:
        if pid != front_pid() or loose(now) != loose(expected):
            out.update(submitted="skipped", value=clip(now, 300))
            return out
        mark_posted()
        backend.press(backend.keysym("Return"))
        out["submitted"] = "keys"
    else:
        out["value"] = clip(now, 300)
    return out


def target_pid(req):
    """The app named in a request, brought forward (X11) once the user pauses; 0 when none is named."""
    name = clip(req.get("app"), 200).strip()
    if not name:
        return 0
    window, pid = find_window(name, "")
    if window is None or pid == front_pid():
        return 0
    bring_forward(pid, f"Switching to {name}")
    return pid


def require_other_app_in_front(what):
    front = front_pid()
    if is_guarded(front):
        raise Fail(GUARDED_REFUSAL, "guarded")
    if is_self(front):
        raise Fail(f'{what} would go to ADT Bot, which is in front. Name the app to send it to (app: "Text Editor"), or open it first.', "self")


def type_cmd(req):
    text = str(req.get("text") or "")
    pid = target_pid(req) if Atspi is not None else 0
    if not pid:
        require_other_app_in_front("Typing")
        require_user_pause("Typing")
    mark_posted()
    input_backend().type_text(text)
    return {"typed": len(text), "to": "app" if pid else "front"}


MOD_KEYS = {"control": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "super": "Super_L"}


def key_cmd(req):
    mods = []
    for m in req.get("modifiers") or []:
        if m not in MOD_KEYS:
            raise Fail(f"Unknown modifier {m}.")
        mods.append(MOD_KEYS[m])
    backend = input_backend()
    if req.get("keysym"):
        keysym = backend.keysym(str(req["keysym"]))
    elif req.get("char"):
        keysym = char_keysym(str(req["char"])[0], backend.keysym)
    else:
        raise Fail("Give a key name or a character.")
    if not keysym:
        raise Fail(f'Unknown key "{req.get("keysym")}".')
    pid = target_pid(req) if Atspi is not None else 0
    if not pid:
        require_other_app_in_front("The key")
        require_user_pause("Pressing the key")
    mark_posted()
    backend.press(keysym, mods)
    return {"ok": True, "to": "app" if pid else "front"}


def refuse_self_at(x, y, shielded=False):
    """
    A click on ADT Bot's own window (an Allow button, a setting) is refused. `shielded`: ADT Bot's
    windows drop the bot's input themselves during this action, so on Wayland the point may be on
    a window beside ADT Bot even while it's in front.
    """
    if SESSION == "x11":
        try:
            hit = x11().window_at(x, y)
        except Fail:
            hit = None
        if hit and refusal_for(hit["pid"]):
            raise Fail(*refusal_for(hit["pid"]))
    elif is_guarded(front_pid()):
        raise Fail(GUARDED_REFUSAL, "guarded")
    elif not shielded and is_self(front_pid()):
        # Wayland doesn't say where windows are: refuse while ADT Bot is the window in front.
        raise Fail("ADT Bot is the window in front, and on Wayland it can't tell whether the point is on its own window. Switch to the app first (mac_open_app).", "self")


def click_cmd(req):
    x, y = int(req["x"]), int(req["y"])
    refuse_self_at(x, y, bool(req.get("shielded")))
    require_user_pause("Clicking")
    mark_posted()
    button = {"left": 1, "middle": 2, "right": 3}.get(req.get("button") or "left", 1)
    input_backend().click(x, y, button, max(1, min(3, int(req.get("clicks") or 1))))
    mark_posted()
    return {"ok": True}


def drag_cmd(req):
    # Neither picking something up from ADT Bot nor dropping it there.
    refuse_self_at(int(req["x"]), int(req["y"]), bool(req.get("shielded")))
    refuse_self_at(int(req["toX"]), int(req["toY"]), bool(req.get("shielded")))
    require_user_pause("Dragging")
    mark_posted()
    input_backend().drag(int(req["x"]), int(req["y"]), int(req["toX"]), int(req["toY"]))
    mark_posted()
    return {"ok": True}


def scroll_cmd(req):
    require_user_pause("Scrolling")
    mark_posted()
    input_backend().scroll(int(req["x"]), int(req["y"]), int(req.get("dx") or 0), int(req.get("dy") or 0))
    return {"ok": True}


def move_cmd(req):
    mark_posted()
    input_backend().move(int(req["x"]), int(req["y"]))
    return {"ok": True}


_last_pointer = None


def cursor_cmd():
    if SESSION == "x11":
        return x11().cursor()
    return _last_pointer or {"x": 0, "y": 0}


def apps_cmd():
    front = front_pid()
    out, seen = [], set()
    if Atspi is not None:
        for _app, name, pid, windows in apps_and_windows():
            if not windows or proc_name(pid).lower() in SHELLS or refusal_for(pid) or pid in seen:
                continue
            seen.add(pid)
            out.append({"name": clip(name, 80), "bundleId": None, "pid": pid, "active": pid == front, "hidden": False})
    if SESSION == "x11":
        try:
            for w in x11().windows():
                if w["pid"] and w["pid"] not in seen and proc_name(w["pid"]).lower() not in SHELLS and not refusal_for(w["pid"]):
                    seen.add(w["pid"])
                    out.append({"name": clip(proc_name(w["pid"]), 80), "bundleId": None, "pid": w["pid"], "active": w["pid"] == front, "hidden": w["hidden"]})
        except Fail:
            pass
    return {"apps": out}


def find_cmd(req):
    """The running app a name means, matched like the other commands match it (for quitting it)."""
    name = clip(req.get("name"), 200).strip()
    if not name:
        raise Fail("Give the app's name.")
    if names_self(name):
        raise Fail(SELF_REFUSAL, "self")
    if Atspi is not None:
        try:
            _window, pid = find_window(name, "")
            if pid:
                return {"name": clip(proc_name(pid), 80), "pid": pid}
        except Fail as error:
            if error.code != "not-running":
                raise
    for app in apps_cmd()["apps"]:
        if app_matches(app["name"], app["pid"], [], name) >= 2:
            return {"name": app["name"], "pid": app["pid"]}
    raise Fail(f'"{name}" isn\'t running.', "not-running")

def front_cmd():
    if SESSION == "x11":
        try:
            w = x11().active()
        except Fail:
            w = None
        if w and w["pid"]:
            return {"name": clip(proc_name(w["pid"]), 80), "bundleId": None, "pid": w["pid"], "window": clip(w["title"], 120), "bounds": w["bounds"]}
    if Atspi is None:
        return None
    for _app, name, pid, windows in apps_and_windows():
        for w in windows:
            if is_active(w):
                bounds = extents(w, Atspi.CoordType.SCREEN) if SESSION == "x11" else None
                return {"name": clip(name, 80), "bundleId": None, "pid": pid, "window": window_title(w), "bounds": {"x": bounds["x"], "y": bounds["y"], "width": bounds["w"], "height": bounds["h"]} if bounds else None}
    return None


def geometry_cmd(req):
    if SESSION == "x11":
        return x11().geometry()
    hint = req.get("hint") or {}
    if _portal is not None and _portal.geometry():
        g = _portal.geometry()
        return {**g, "backing": hint.get("backing") or 1}
    return {"x": hint.get("x", 0), "y": hint.get("y", 0), "width": hint.get("width", 1280), "height": hint.get("height", 800), "backing": hint.get("backing") or 1}


def screenshot_cmd(req):
    path = str(req["path"])
    if SESSION == "x11":
        region = req.get("region") or x11().geometry()
        rect = {k: int(region[k]) for k in ("x", "y", "width", "height")}
        return {**x11().screenshot(rect, path), "x": rect["x"], "y": rect["y"]}
    if SESSION == "wayland":
        return portal().screenshot(path)
    raise Fail("There's no graphical session to take a screenshot of.", "missing")


# ---- Opening apps ------------------------------------------------------------------------------


def desktop_entries():
    home = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    dirs = [home] + (os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":") + ["/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"]
    seen, out = set(), []
    for base in dirs:
        folder = os.path.join(base, "applications")
        try:
            files = sorted(os.listdir(folder))
        except OSError:
            continue
        for file in files:
            if not file.endswith(".desktop") or file in seen:
                continue
            seen.add(file)
            parser = ConfigParser(interpolation=None, strict=False)
            try:
                parser.read(os.path.join(folder, file), encoding="utf-8")
                entry = parser["Desktop Entry"]
            except Exception:  # noqa: BLE001 - not a readable desktop entry
                continue
            if entry.get("Type") != "Application" or entry.get("NoDisplay") == "true" or entry.get("Hidden") == "true" or not entry.get("Exec"):
                continue
            out.append({"id": file[: -len(".desktop")], "path": os.path.join(folder, file), "name": entry.get("Name", ""), "generic": entry.get("GenericName", ""), "exec": entry.get("Exec", "")})
    return out


_desktop_cache = {"at": 0.0, "entries": []}


def cached_entries():
    if time.monotonic() - _desktop_cache["at"] > 60:
        _desktop_cache.update(at=time.monotonic(), entries=desktop_entries())
    return _desktop_cache["entries"]


def find_entry(name):
    want = name.lower()
    entries = cached_entries()
    # Its name, its id, what kind of app it is ("Text Editor" is Mousepad's), then a name it starts.
    tests = (
        lambda e: e["name"].lower() == want or e["id"].lower() == want,
        lambda e: e["id"].lower().rsplit(".", 1)[-1] == want,
        lambda e: e["generic"].lower() == want,
        lambda e: e["name"].lower().startswith(want),
    )
    for test in tests:
        hit = next((e for e in entries if test(e)), None)
        if hit:
            return hit
    return None


def exec_name(entry):
    try:
        args = [a for a in shlex.split(entry["exec"]) if a != "env" and "=" not in a.split("/")[0]]
    except ValueError:
        return ""
    return os.path.basename(args[0]) if args else ""


def desktop_names_for(want):
    """What an app named like a launcher entry ("Calculator") is called as a process (gnome-calculator)."""
    entry = find_entry(want)
    return {exec_name(entry), entry["id"].lower()} - {""} if entry else set()


def open_cmd(req):
    name = str(req.get("name") or "").strip()
    entry = find_entry(name)
    if not entry:
        raise Fail(f'No app named "{name}" is installed.', "not-found")
    if Gio is not None:
        info = Gio.DesktopAppInfo.new_from_filename(entry["path"])
        if info is not None and info.launch([], None):
            return {"name": entry["name"] or name}
    # Without GIO: the entry's command, its field codes dropped, run directly (no shell).
    args = [a for a in shlex.split(entry["exec"]) if not re.fullmatch(r"%[a-zA-Z]", a)]
    subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"name": entry["name"] or name}


# ---- What works here ---------------------------------------------------------------------------


def capabilities():
    out = {"session": SESSION, "atspi": False, "input": "none", "screenshot": "none", "missing": []}
    if Atspi is not None:
        try:
            atspi()
            out["atspi"] = True
        except Exception:  # noqa: BLE001
            out["missing"].append("accessibility bus (at-spi2-core)")
    else:
        out["missing"].append("python3-gi and gir1.2-atspi-2.0")
    if SESSION == "x11":
        try:
            x = x11()
            out["screenshot"] = "x11"
            out["input"] = "xtest" if x.tst is not None else "none"
            if x.tst is None:
                out["missing"].append("libxtst6")
        except Fail:
            out["missing"].append("an X display")
    elif SESSION == "wayland":
        if Gio is None:
            out["missing"].append("python3-gi")
        else:
            out["screenshot"] = "portal"
            saved = os.path.exists(os.path.join(STATE_DIR, "remote-desktop-token"))
            out["input"] = "portal" if _portal is not None and _portal.session else "portal-saved" if saved else "portal-needs-approval"
    return out


NEEDS_UNLOCKED = {"snapshot", "press", "setText", "type", "key", "click", "move", "drag", "scroll"}


def handle(req):
    global _last_pointer
    cmd = req.get("cmd")
    if cmd in NEEDS_UNLOCKED and locked():
        raise Fail("This PC's screen is locked, so apps can't be seen or used. Ask the user to unlock it, then try again.", "locked")
    if cmd == "ping":
        return {"trusted": True, "pid": os.getpid(), "locked": locked(), "idle": user_idle_seconds(), **capabilities()}
    if cmd == "idle":
        return {"idle": user_idle_seconds()}
    if cmd == "connect":
        if SESSION != "wayland":
            return {"input": capabilities()["input"]}
        portal().connect(True)
        return {"input": "portal"}
    if cmd == "geometry":
        return geometry_cmd(req)
    if cmd == "snapshot":
        return snapshot(req)
    if cmd == "press":
        return press(req)
    if cmd == "setText":
        return set_text(req)
    if cmd == "type":
        return type_cmd(req)
    if cmd == "key":
        return key_cmd(req)
    if cmd in ("click", "move", "drag", "scroll"):
        result = {"click": click_cmd, "move": move_cmd, "drag": drag_cmd, "scroll": scroll_cmd}[cmd](req)
        _last_pointer = {"x": int(req.get("toX", req.get("x", 0))), "y": int(req.get("toY", req.get("y", 0)))}
        return result
    if cmd == "cursor":
        return cursor_cmd()
    if cmd == "apps":
        return apps_cmd()
    if cmd == "front":
        return front_cmd()
    if cmd == "find":
        return find_cmd(req)
    if cmd == "screenshot":
        return screenshot_cmd(req)
    if cmd == "open":
        return open_cmd(req)
    raise Fail("Unknown command.")


def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        try:
            reply = {"id": req.get("id"), "result": handle(req)}
        except Fail as error:
            reply = {"id": req.get("id"), "error": str(error), "code": error.code}
        except Exception as error:  # noqa: BLE001 - report it rather than stop
            reply = {"id": req.get("id"), "error": f"{type(error).__name__}: {error}", "code": None}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
