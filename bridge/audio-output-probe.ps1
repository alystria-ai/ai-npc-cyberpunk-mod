# Default Windows output device, for the "Audio delay" Auto setting
# (docs/DIALOGUE_LEVEL.md). Started once by the bridge; prints one JSON line
# now and then one every -Interval seconds:
#   {"name": "...", "enumerator": "BTHENUM", "formFactor": 3, "bluetooth": true}
# Read only: it never changes a device or volume. Exits with its parent (-ParentId).
param([int]$Interval = 60, [int]$ParentId = 0, [switch]$Once)
$ErrorActionPreference = 'Stop'
try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch {}
if (-not ('CyberpunkConvaiAudioOutput.Endpoint' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CyberpunkConvaiAudioOutput {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointer;
    [FieldOffset(8)] public uint number;
    [FieldOffset(16)] public IntPtr padding;
  }
  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
  }
  public static class Endpoint {
    static readonly Guid device = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    static readonly Guid endpoint = new Guid("1da5d803-d492-4edd-8c23-e0c0ffee7f0e");
    static PropVariant Read(IPropertyStore store, Guid fmtid, int pid) {
      var key = new PropertyKey { fmtid = fmtid, pid = pid }; PropVariant value;
      store.GetValue(ref key, out value); return value;
    }
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    // Copies a VT_LPWSTR value and frees the variant (the probe runs for hours).
    static string Text(PropVariant v) {
      string text = v.vt == 31 && v.pointer != IntPtr.Zero ? Marshal.PtrToStringUni(v.pointer) : "";
      PropVariantClear(ref v); return text;
    }
    public static string Describe() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice dev;
      if (enumerator.GetDefaultAudioEndpoint(0, 0, out dev) != 0 || dev == null) return "{\"available\":false}";
      IPropertyStore store; dev.OpenPropertyStore(0, out store);
      string name = Text(Read(store, device, 14)), source = Text(Read(store, device, 24));
      var form = Read(store, endpoint, 0); uint formFactor = form.vt == 19 ? form.number : 10; PropVariantClear(ref form);
      // Bluetooth: the BTHENUM (classic A2DP/HFP) or BTHLE (LE Audio)
      // enumerator. Offloaded Bluetooth audio (Intel Smart Sound "for Bluetooth
      // Audio") enumerates as INTELAUDIO but still names its BTHENUM device and
      // "Bluetooth" in other endpoint properties, so every text property is checked.
      bool bluetooth = source.StartsWith("BTH", StringComparison.OrdinalIgnoreCase);
      int count; store.GetCount(out count);
      for (int i = 0; i < count && !bluetooth; i++) {
        PropertyKey key; if (store.GetAt(i, out key) != 0) continue;
        PropVariant value; if (store.GetValue(ref key, out value) != 0) continue;
        string text = Text(value);
        if (text.IndexOf("BTHENUM", StringComparison.OrdinalIgnoreCase) >= 0 || text.IndexOf("BTHLE", StringComparison.OrdinalIgnoreCase) >= 0
            || text.IndexOf("Bluetooth", StringComparison.OrdinalIgnoreCase) >= 0) bluetooth = true;
      }
      Marshal.ReleaseComObject(store); Marshal.ReleaseComObject(dev); Marshal.ReleaseComObject(enumerator);
      return "{\"available\":true,\"name\":\"" + name.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"enumerator\":\""
        + source.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"formFactor\":" + formFactor + ",\"bluetooth\":" + (bluetooth ? "true" : "false") + "}";
    }
  }
}
'@
}
while ($true) {
  try { [Console]::Out.WriteLine([CyberpunkConvaiAudioOutput.Endpoint]::Describe()) }
  catch { [Console]::Out.WriteLine('{"available":false}') }
  [Console]::Out.Flush()
  if ($Once) { break }
  for ($waited = 0; $waited -lt $Interval; $waited += 5) {
    Start-Sleep -Seconds 5
    if ($ParentId -gt 0 -and -not (Get-Process -Id $ParentId -ErrorAction SilentlyContinue)) { exit 0 }
  }
}
