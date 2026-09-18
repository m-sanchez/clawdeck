param([Parameter(Mandatory)][long]$WindowHandle, [Parameter(Mandatory)][string]$IconPath)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public static class OcelinWindowIcons {
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr icon);

    public static string Verify(long windowHandle, string path) {
        string sizes = "";
        for (int kind = 0; kind <= 1; kind++) {
            IntPtr actual;
            if (SendMessageTimeout(new IntPtr(windowHandle), 0x007F, new IntPtr(kind), IntPtr.Zero, 2, 3000, out actual) == IntPtr.Zero || actual == IntPtr.Zero)
                throw new Exception("Window icon missing: " + kind);
            using (Icon actualIcon = Icon.FromHandle(actual))
            using (Bitmap actualBitmap = actualIcon.ToBitmap()) {
                IntPtr expected = LoadImage(IntPtr.Zero, path, 1, actualBitmap.Width, actualBitmap.Height, 0x0010);
                if (expected == IntPtr.Zero) throw new Exception("Windows could not load the Ocelin icon file");
                try {
                    using (Icon expectedIcon = Icon.FromHandle(expected))
                    using (Bitmap expectedBitmap = expectedIcon.ToBitmap()) {
                        for (int y = 0; y < actualBitmap.Height; y++)
                            for (int x = 0; x < actualBitmap.Width; x++)
                                if (actualBitmap.GetPixel(x, y).ToArgb() != expectedBitmap.GetPixel(x, y).ToArgb())
                                    throw new Exception("Window icon does not match Ocelin: " + kind);
                    }
                } finally { DestroyIcon(expected); }
                sizes += (kind == 0 ? "" : ",") + actualBitmap.Width;
            }
        }
        return sizes;
    }
}
'@
[OcelinWindowIcons]::Verify($WindowHandle, $IconPath)
