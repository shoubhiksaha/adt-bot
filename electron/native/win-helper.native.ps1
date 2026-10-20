# Native shim for win-helper.ps1 (dot-sourced). Defines [AdtNative], the small set of Win32 calls the
# accessibility helper needs that UI Automation and .NET don't cover: synthesising pointer and
# keyboard events (as the Mac helper does with CGEvent), reading the foreground window, the system
# idle time and the lock state, and capturing the screen. This is the Windows equivalent of the
# input layer in electron/native/mac-helper.swift; it runs only inside ADT Bot's "Control this PC"
# feature, which the user turns on and which asks for approval per the app's policy.

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AdtNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040;
  const uint KEYUP = 0x0002, KEYUNICODE = 0x0004;

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h, int index, byte[] info, uint len, out uint needed);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  public static void MakeDpiAware() { try { SetProcessDPIAware(); } catch (Exception) { } }
  public static int[] Virt() { return new int[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) }; }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static int PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return (int)pid; }
  public static int[] RectOf(IntPtr h) { RECT r; if (GetWindowRect(h, out r)) return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top }; return new int[] { 0, 0, 0, 0 }; }
  public static uint LastInputTick() { LASTINPUTINFO i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)); GetLastInputInfo(ref i); return i.dwTime; }
  public static uint Tick() { return GetTickCount(); }
  public static double Since(uint earlier) { return (double)unchecked(GetTickCount() - earlier); }
  public static bool After(uint a, uint b, uint margin) { return unchecked((int)(a - (b + margin))) > 0; }

  static INPUT M(uint flags, int dx, int dy, uint data) { INPUT i = new INPUT(); i.type = INPUT_MOUSE; i.u.mi.dwFlags = flags; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = INPUT_KEYBOARD; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static int Norm(int v, int origin, int size) { if (size <= 1) size = 2; return (int)(((double)(v - origin)) * 65535.0 / (size - 1)); }

  public static void Move(int x, int y) { int[] s = Virt(); Send(new INPUT[] { M(MOVE | ABSOLUTE | VIRTUALDESK, Norm(x, s[0], s[2]), Norm(y, s[1], s[3]), 0) }); }
  public static void Click(int x, int y, int button, int clicks) {
    uint dn = button == 1 ? RDOWN : (button == 2 ? MDOWN : LDOWN);
    uint up = button == 1 ? RUP : (button == 2 ? MUP : LUP);
    Move(x, y); System.Threading.Thread.Sleep(30);
    int n = clicks < 1 ? 1 : (clicks > 3 ? 3 : clicks);
    for (int i = 0; i < n; i++) { Send(new INPUT[] { M(dn, 0, 0, 0), M(up, 0, 0, 0) }); if (i < n - 1) System.Threading.Thread.Sleep(60); }
  }
  public static void Scroll(int x, int y, int dx, int dy) {
    Move(x, y);
    if (dy != 0) Send(new INPUT[] { M(WHEEL, 0, 0, unchecked((uint)(-dy))) });
    if (dx != 0) Send(new INPUT[] { M(HWHEEL, 0, 0, unchecked((uint)dx)) });
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    Move(x1, y1); System.Threading.Thread.Sleep(50);
    Send(new INPUT[] { M(LDOWN, 0, 0, 0) }); System.Threading.Thread.Sleep(80);
    for (int i = 1; i <= 30; i++) { double t = i / 30.0; Move((int)(x1 + (x2 - x1) * t), (int)(y1 + (y2 - y1) * t)); System.Threading.Thread.Sleep(12); }
    System.Threading.Thread.Sleep(50);
    Send(new INPUT[] { M(LUP, 0, 0, 0) });
  }
  public static void TapKey(ushort vk) { Send(new INPUT[] { K(vk, 0, 0), K(vk, 0, KEYUP) }); }
  public static void SelectAll() { KeyCombo(new ushort[] { 0x11 }, (ushort)'A'); }
  public static void KeyCombo(ushort[] mods, ushort vk) {
    List<INPUT> a = new List<INPUT>();
    foreach (ushort m in mods) a.Add(K(m, 0, 0));
    a.Add(K(vk, 0, 0)); a.Add(K(vk, 0, KEYUP));
    for (int i = mods.Length - 1; i >= 0; i--) a.Add(K(mods[i], 0, KEYUP));
    Send(a.ToArray());
  }
  public static void CharCombo(ushort[] mods, char ch) {
    short vks = VkKeyScan(ch);
    if (vks == -1 || mods.Length == 0) { TypeUnicode(ch.ToString()); return; }
    List<ushort> all = new List<ushort>(mods);
    if ((vks & 0x100) != 0 && !all.Contains((ushort)0x10)) all.Add(0x10);
    KeyCombo(all.ToArray(), (ushort)(vks & 0xff));
  }
  public static void TypeUnicode(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { TapKey(0x0D); } else if (c == '\t') { TapKey(0x09); }
      else { Send(new INPUT[] { K(0, (ushort)c, KEYUNICODE), K(0, (ushort)c, KEYUNICODE | KEYUP) }); }
      System.Threading.Thread.Sleep(5);
    }
  }
  public static bool Locked() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return true;
    try {
      byte[] buf = new byte[512]; uint need;
      if (!GetUserObjectInformationW(d, 2, buf, (uint)buf.Length, out need)) return false;
      int len = (int)Math.Min((uint)buf.Length, need);
      string name = Encoding.Unicode.GetString(buf, 0, len).TrimEnd('\0');
      return !string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase);
    } finally { CloseDesktop(d); }
  }
  public static void CapturePng(int x, int y, int w, int h, string path) {
    using (System.Drawing.Bitmap bmp = new System.Drawing.Bitmap(w, h)) {
      using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(bmp)) { g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h)); }
      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
  }
}
'@
