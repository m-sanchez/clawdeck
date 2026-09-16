# ClaudeDeck - native interop types for the deck (dot-sourced by session-view.ps1).
#
# Pure Add-Type definitions, no dependency on any deck state. Registered in the
# AppDomain the moment this file is dot-sourced, so the deck can use them as
# [WinFocus], [VDesk] and [NoActivateForm]. Dot-source AFTER the System.Windows.Forms
# / System.Drawing assemblies are loaded (NoActivateForm references WinForms).
#
#   WinFocus        - find/raise IDE windows by title, global mouse/keyboard polling,
#                     and the taskbar attention flash used by the focus nudge.
#   VDesk           - keep the deck on whichever virtual desktop is in view.
#   NoActivateForm  - a Form that never steals keyboard focus (the deck is an overlay
#                     that pops up on task completion; it must not interrupt typing).

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinFocus {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr hAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  const int SW_RESTORE = 9;
  const int SW_SHOWNOACTIVATE = 4;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  public static bool FocusByTitle(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      string t = sb.ToString();
      bool isIde = t.IndexOf("Visual Studio Code", StringComparison.OrdinalIgnoreCase) >= 0
                || t.IndexOf("Cursor", StringComparison.OrdinalIgnoreCase) >= 0;
      if (isIde && t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return RaiseWindow(found);
  }
  // Find a top-level window whose title EXACTLY matches (returns hwnd or zero).
  public static IntPtr FindExact(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (string.Equals(sb.ToString(), title, StringComparison.OrdinalIgnoreCase)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool RaiseWindow(IntPtr found) {
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, SW_RESTORE);  // only un-minimize; never resize a maximized/normal window
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint cur = GetCurrentThreadId();
    AttachThreadInput(cur, fg, true);
    BringWindowToTop(found);
    SetForegroundWindow(found);
    AttachThreadInput(cur, fg, false);
    return true;
  }
  // Bring a window to the top of the z-order WITHOUT stealing keyboard focus.
  // Used when an already-open overlay is re-surfaced on task completion: the user
  // may be mid-sentence in another app, so we must never activate (which is why we
  // don't reuse RaiseWindow here - that one intentionally yanks focus for IDE jumps).
  public static bool SurfaceWindow(IntPtr found) {
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, SW_SHOWNOACTIVATE);  // un-minimize without activating
    SetWindowPos(found, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    return true;
  }
  public static bool AnyMouseDown() {
    return ((GetAsyncKeyState(0x01) & 0x8000) != 0) || ((GetAsyncKeyState(0x02) & 0x8000) != 0);
  }
  public static bool CursorOutside(int l, int t, int r, int b) {
    POINT p; if (!GetCursorPos(out p)) return false;
    return (p.X < l || p.X > r || p.Y < t || p.Y > b);
  }
  // Standard taskbar attention flash (used by the focus nudge).
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO p);
  [StructLayout(LayoutKind.Sequential)] struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  public static void Flash(IntPtr h, uint count) {
    FLASHWINFO fi = new FLASHWINFO();
    fi.cbSize = (uint)Marshal.SizeOf(fi);
    fi.hwnd = h; fi.dwFlags = 3 /* FLASHW_ALL */; fi.uCount = count; fi.dwTimeout = 0;
    FlashWindowEx(ref fi);
  }
}

// Documented virtual-desktop API (stable across Windows updates).
[ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager {
  bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
  Guid GetWindowDesktopId(IntPtr topLevelWindow);
  void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
}

public class VDesk {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  static IVirtualDesktopManager _mgr;
  static IVirtualDesktopManager Mgr() {
    if (_mgr == null) {
      Type t = Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"));
      _mgr = (IVirtualDesktopManager)Activator.CreateInstance(t);
    }
    return _mgr;
  }
  // Keep the window on whatever desktop the user is currently viewing: if it's
  // not on the current desktop, move it there. Makes it feel pinned to all
  // desktops, using only the documented IVirtualDesktopManager.
  public static void FollowToCurrentDesktop(IntPtr hwnd) {
    try {
      var mgr = Mgr();
      if (mgr.IsWindowOnCurrentVirtualDesktop(hwnd)) return;
      IntPtr fg = GetForegroundWindow();
      if (fg == IntPtr.Zero || fg == hwnd) return;
      Guid id = mgr.GetWindowDesktopId(fg);
      if (id == Guid.Empty) return;
      mgr.MoveWindowToDesktop(hwnd, ref id);
    } catch {}
  }
}
"@

# A Form that NEVER steals the keyboard focus. The deck is an overlay that pops
# up on task completion, so it must not interrupt whatever you're typing in
# another window. ShowWithoutActivation skips activation when it's shown;
# WS_EX_NOACTIVATE also keeps it from grabbing focus if you later click it
# (rows/buttons/drag still work via their own mouse handlers).
Add-Type -ReferencedAssemblies 'System.Windows.Forms','System.Drawing' -TypeDefinition @"
using System;
using System.Windows.Forms;
public class NoActivateForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      const int WS_EX_NOACTIVATE = 0x08000000;
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= WS_EX_NOACTIVATE;
      return cp;
    }
  }
}

// Application-wide mouse-wheel hook. The deck is a WS_EX_NOACTIVATE overlay that
// never takes focus, so neither the form nor its child controls reliably raise the
// .NET MouseWheel event. Windows' "scroll inactive windows on hover" posts
// WM_MOUSEWHEEL to whatever window is under the cursor (a child control, usually) —
// an IMessageFilter sees that message in the pump regardless of focus or target.
// The PS side assigns Handler := (screenX, screenY, delta) => handled; returning
// true consumes the scroll (used over a todo header), false lets it fall through
// (so the session list still scrolls natively). For WM_MOUSEWHEEL the LPARAM x/y
// are SCREEN coordinates, which is exactly what hit-testing the header wants.
public class WheelFilter : IMessageFilter {
  public static Func<int,int,int,bool> Handler;
  public bool PreFilterMessage(ref Message m) {
    if (m.Msg == 0x020A && Handler != null) {
      long w = m.WParam.ToInt64();
      int delta = (short)((w >> 16) & 0xFFFF);
      long lp = m.LParam.ToInt64();
      int x = (short)(lp & 0xFFFF);
      int y = (short)((lp >> 16) & 0xFFFF);
      try { return Handler(x, y, delta); } catch { return false; }
    }
    return false;
  }
}
"@
