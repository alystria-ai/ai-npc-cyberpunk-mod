// Development measurement only: WASAPI loopback capture of the default output
// device plus per-application session peak meters. It records what the player
// actually hears (game Wwise, Audioware and the bridge's browser voice all mix
// into this endpoint), so the voice level can be matched against vanilla
// dialogue. It never changes any volume or device setting.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace CyberpunkConvaiAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IntPtr store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    int GetBufferSize(out uint frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr handle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }

  [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    int ReleaseBuffer(uint frames);
    int GetNextPacketSize(out uint frames);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl2 session);
  }

  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName(string name, IntPtr context);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath(string path, IntPtr context);
    int GetGroupingParam(out Guid param);
    int SetGroupingParam(ref Guid param, IntPtr context);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetProcessId(out uint pid);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float level, IntPtr context);
    int GetMasterVolume(out float level);
    int SetMute(bool mute, IntPtr context);
    int GetMute(out bool mute);
  }

  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    int GetPeakValue(out float peak);
  }

  public class SessionInfo {
    public uint Pid; public string Process; public int State; public float Volume; public bool Mute; public float Peak;
  }

  public static class Loopback {
    const int CLSCTX_ALL = 23;
    static IMMDevice Device() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice device; Check(enumerator.GetDefaultAudioEndpoint(0, 0, out device), "default render device");
      return device;
    }
    static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8")); }

    static readonly Dictionary<uint, string> names = new Dictionary<uint, string>();
    static string ProcessName(uint pid) {
      string name; if (names.TryGetValue(pid, out name)) return name;
      try { name = Process.GetProcessById((int)pid).ProcessName; } catch { name = pid == 0 ? "system" : "?"; }
      names[pid] = name; return name;
    }

    public static List<SessionInfo> Sessions() {
      var device = Device(); object raw; var iid = typeof(IAudioSessionManager2).GUID;
      Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out raw), "session manager");
      IAudioSessionEnumerator sessions; Check(((IAudioSessionManager2)raw).GetSessionEnumerator(out sessions), "sessions");
      int count; sessions.GetCount(out count);
      var result = new List<SessionInfo>();
      for (int i = 0; i < count; i++) {
        IAudioSessionControl2 control; if (sessions.GetSession(i, out control) != 0) continue;
        var info = new SessionInfo(); control.GetProcessId(out info.Pid); control.GetState(out info.State);
        info.Process = ProcessName(info.Pid);
        var volume = control as ISimpleAudioVolume; if (volume != null) { volume.GetMasterVolume(out info.Volume); volume.GetMute(out info.Mute); }
        var meter = control as IAudioMeterInformation; if (meter != null) meter.GetPeakValue(out info.Peak);
        result.Add(info);
      }
      return result;
    }

    // Records `seconds` of the default output mix to a 32-bit float WAV. Packets
    // are placed by their QPC timestamp, so silent stretches (when nothing
    // renders and loopback delivers nothing) stay silent and in time. A side
    // CSV logs each application session's peak meter every 50 ms.
    public static string Record(string wavPath, string csvPath, double seconds) {
      var device = Device(); object raw; var iid = typeof(IAudioClient).GUID;
      Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out raw), "audio client");
      var client = (IAudioClient)raw; IntPtr format; Check(client.GetMixFormat(out format), "mix format");
      int channels = Marshal.ReadInt16(format, 2), rate = Marshal.ReadInt32(format, 4), bits = Marshal.ReadInt16(format, 14);
      ushort tag = (ushort)Marshal.ReadInt16(format, 0);
      bool isFloat = tag == 3 || (tag == 0xFFFE && bits == 32);
      if (!isFloat || bits != 32) throw new Exception("Unsupported mix format: tag " + tag + " bits " + bits);
      Check(client.Initialize(0, 0x00020000, 10000000, 0, format, IntPtr.Zero), "loopback initialize");
      object rawCapture; var captureIid = typeof(IAudioCaptureClient).GUID;
      Check(client.GetService(ref captureIid, out rawCapture), "capture service");
      var capture = (IAudioCaptureClient)rawCapture;
      long total = (long)(seconds * rate);
      var samples = new float[total * channels];
      var log = new StreamWriter(csvPath); log.WriteLine("t,pid,process,state,volume,mute,peak");
      long startTicks = Stopwatch.GetTimestamp(); double qpcStart = -1;
      Check(client.Start(), "start");
      long nextMeter = 0; int packets = 0;
      while (true) {
        double elapsed = (Stopwatch.GetTimestamp() - startTicks) / (double)Stopwatch.Frequency;
        if (elapsed >= seconds) break;
        if (elapsed * 1000 >= nextMeter) {
          nextMeter += 50;
          try { foreach (var s in Sessions()) if (s.Peak > 0 || s.State == 1)
            log.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture, "{0:F3},{1},{2},{3},{4:F3},{5},{6:F5}", elapsed, s.Pid, s.Process, s.State, s.Volume, s.Mute, s.Peak)); } catch {}
        }
        uint next; capture.GetNextPacketSize(out next);
        while (next > 0) {
          IntPtr data; uint frames, flags; ulong devPos, qpc;
          Check(capture.GetBuffer(out data, out frames, out flags, out devPos, out qpc), "get buffer");
          // qpcPosition is in 100 ns units.
          double t = qpc / 1e7;
          if (qpcStart < 0) qpcStart = t - elapsed;
          long index = (long)Math.Round((t - qpcStart) * rate);
          if ((flags & 2) == 0 && index >= 0) {
            var chunk = new float[frames * channels]; Marshal.Copy(data, chunk, 0, chunk.Length);
            long n = Math.Min(chunk.Length, samples.Length - index * channels);
            if (n > 0) Array.Copy(chunk, 0, samples, index * channels, n);
          }
          capture.ReleaseBuffer(frames); packets++;
          capture.GetNextPacketSize(out next);
        }
        Thread.Sleep(5);
      }
      client.Stop(); log.Close();
      using (var w = new BinaryWriter(File.Create(wavPath))) {
        int dataBytes = samples.Length * 4;
        w.Write(new char[] {'R','I','F','F'}); w.Write(36 + dataBytes); w.Write(new char[] {'W','A','V','E','f','m','t',' '});
        w.Write(16); w.Write((short)3); w.Write((short)channels); w.Write(rate); w.Write(rate * channels * 4);
        w.Write((short)(channels * 4)); w.Write((short)32); w.Write(new char[] {'d','a','t','a'}); w.Write(dataBytes);
        var bytes = new byte[dataBytes]; Buffer.BlockCopy(samples, 0, bytes, 0, dataBytes); w.Write(bytes);
      }
      return string.Format("{0} Hz, {1} ch, {2} packets", rate, channels, packets);
    }
  }
}
