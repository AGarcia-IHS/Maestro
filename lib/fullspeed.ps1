# Asks Windows not to slow one process down to save power.
# A program with no window in front is moved to the processor's efficiency cores a few seconds after it starts, which
# makes Maestro's queries about three times slower. This changes that for the Maestro server only; nothing else on the
# machine is affected and it lasts only until the server stops.
param([int]$ProcessId)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MaestroQos {
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr h, int cls, ref State s, uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static bool FullSpeed(int pid) {
    IntPtr h = OpenProcess(0x0200, false, pid); // PROCESS_SET_INFORMATION
    if (h == IntPtr.Zero) return false;
    State s = new State { Version = 1, ControlMask = 1, StateMask = 0 }; // execution speed: never throttled
    bool ok = SetProcessInformation(h, 4, ref s, (uint)Marshal.SizeOf(typeof(State))); // 4 = ProcessPowerThrottling
    CloseHandle(h);
    return ok;
  }
}
'@
if ([MaestroQos]::FullSpeed($ProcessId)) { 'ok' } else { 'failed' }
