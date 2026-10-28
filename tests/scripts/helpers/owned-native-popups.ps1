param([string]$OutputAssembly)
$ErrorActionPreference = 'Stop'
# CI prepares this once before starting the application. Loading the assembly
# keeps C# compilation outside the existing owned-dialog interaction deadline.
if (-not $OutputAssembly -and $env:MODUTEX_TEST_NATIVE_POPUPS_ASSEMBLY) {
    Add-Type -Path (Resolve-Path -LiteralPath $env:MODUTEX_TEST_NATIVE_POPUPS_ASSEMBLY -ErrorAction Stop).Path
    return
}
$compileOptions = @{}
if ($OutputAssembly) { $compileOptions.OutputAssembly = $OutputAssembly }
Add-Type @compileOptions @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class OwnedNativePopupWindowInfo {
    public IntPtr Handle { get; private set; }
    public uint ProcessId { get; private set; }
    public string ClassName { get; private set; }
    public string Title { get; private set; }

    public OwnedNativePopupWindowInfo(IntPtr handle, uint processId, string className, string title) {
        Handle = handle;
        ProcessId = processId;
        ClassName = className;
        Title = title;
    }
}

public sealed class OwnedNativeChildWindowInfo {
    public IntPtr Handle { get; private set; }
    public uint ProcessId { get; private set; }
    public int ControlId { get; private set; }
    public string ClassName { get; private set; }
    public string Text { get; private set; }

    public OwnedNativeChildWindowInfo(IntPtr handle, uint processId, int controlId, string className, string text) {
        Handle = handle;
        ProcessId = processId;
        ControlId = controlId;
        ClassName = className;
        Text = text;
    }
}

public static class OwnedNativePopupWindows {
    private const uint GW_OWNER = 4;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint WM_GETTEXT = 0x000D;
    private const uint WM_SETTEXT = 0x000C;
    private const uint BM_CLICK = 0x00F5;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private static readonly object ParentCacheLock = new object();
    private static Dictionary<uint, uint> cachedParents;
    private static DateTime parentCacheExpiresUtc;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    private delegate bool EnumChildWindowsProc(IntPtr window, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumChildWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDlgItem(IntPtr dialog, int controlId);

    [DllImport("user32.dll")]
    private static extern bool IsChild(IntPtr parent, IntPtr child);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        StringBuilder lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        string lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static OwnedNativeChildWindowInfo[] EnumerateChildren(IntPtr parent) {
        var children = new List<OwnedNativeChildWindowInfo>();
        EnumChildWindows(parent, delegate(IntPtr window, IntPtr parameter) {
            if (children.Count >= 128) return false;

            uint processId;
            GetWindowThreadProcessId(window, out processId);
            var className = new StringBuilder(128);
            GetClassName(window, className, className.Capacity);
            var text = new StringBuilder(512);
            IntPtr ignoredResult;
            SendMessageTimeout(window, WM_GETTEXT, new UIntPtr((uint)text.Capacity), text,
                SMTO_ABORTIFHUNG, 20, out ignoredResult);
            children.Add(new OwnedNativeChildWindowInfo(
                window, processId, GetDlgCtrlID(window), className.ToString(), text.ToString()));
            return true;
        }, IntPtr.Zero);
        return children.ToArray();
    }

    public static bool TrySelectFolder(IntPtr dialog, uint expectedProcessId, string folderPath, out string detail) {
        uint dialogProcessId;
        GetWindowThreadProcessId(dialog, out dialogProcessId);
        var dialogClass = new StringBuilder(128);
        GetClassName(dialog, dialogClass, dialogClass.Capacity);
        if (dialogProcessId != expectedProcessId || !String.Equals(dialogClass.ToString(), "#32770", StringComparison.Ordinal)) {
            detail = "folder picker root must be a verified same-process #32770 dialog";
            return false;
        }

        IntPtr edit = GetDlgItem(dialog, 1152);
        IntPtr select = GetDlgItem(dialog, 1);
        if (edit == IntPtr.Zero || select == IntPtr.Zero || !IsChild(dialog, edit) || !IsChild(dialog, select)) {
            detail = "verified folder picker does not expose child IDs 1152 and 1";
            return false;
        }

        uint editProcessId;
        uint selectProcessId;
        GetWindowThreadProcessId(edit, out editProcessId);
        GetWindowThreadProcessId(select, out selectProcessId);
        var editClass = new StringBuilder(128);
        var selectClass = new StringBuilder(128);
        GetClassName(edit, editClass, editClass.Capacity);
        GetClassName(select, selectClass, selectClass.Capacity);
        if (editProcessId != expectedProcessId || selectProcessId != expectedProcessId ||
            GetDlgCtrlID(edit) != 1152 || GetDlgCtrlID(select) != 1 ||
            !String.Equals(editClass.ToString(), "Edit", StringComparison.Ordinal) ||
            !String.Equals(selectClass.ToString(), "Button", StringComparison.Ordinal)) {
            detail = "folder picker child PID, ID, or class did not match the observed native controls";
            return false;
        }

        var buttonText = new StringBuilder(512);
        IntPtr textResult;
        if (SendMessageTimeout(select, WM_GETTEXT, new UIntPtr((uint)buttonText.Capacity), buttonText,
            SMTO_ABORTIFHUNG, 500, out textResult) == IntPtr.Zero) {
            detail = "could not read the verified folder-selection button text";
            return false;
        }
        string label = buttonText.ToString().Trim();
        if (!String.Equals(label, "選擇資料夾", StringComparison.Ordinal) &&
            !String.Equals(label, "選取資料夾", StringComparison.Ordinal) &&
            !String.Equals(label, "Select Folder", StringComparison.OrdinalIgnoreCase) &&
            !String.Equals(label, "Choose folder", StringComparison.OrdinalIgnoreCase)) {
            detail = "native button text did not identify a folder-selection action: " + label;
            return false;
        }

        IntPtr setResult;
        if (SendMessageTimeout(edit, WM_SETTEXT, UIntPtr.Zero, folderPath,
            SMTO_ABORTIFHUNG, 1000, out setResult) == IntPtr.Zero) {
            detail = "WM_SETTEXT did not complete on the verified folder path edit";
            return false;
        }

        var enteredPath = new StringBuilder(4096);
        if (SendMessageTimeout(edit, WM_GETTEXT, new UIntPtr((uint)enteredPath.Capacity), enteredPath,
            SMTO_ABORTIFHUNG, 500, out textResult) == IntPtr.Zero ||
            !String.Equals(enteredPath.ToString(), folderPath, StringComparison.OrdinalIgnoreCase)) {
            detail = "folder path edit did not retain the requested path";
            return false;
        }

        IntPtr clickResult;
        if (SendMessageTimeout(select, BM_CLICK, UIntPtr.Zero, IntPtr.Zero,
            SMTO_ABORTIFHUNG, 1000, out clickResult) == IntPtr.Zero) {
            detail = "BM_CLICK did not complete on the verified folder-selection button";
            return false;
        }

        detail = label;
        return true;
    }

    public static bool TryClickOwnedCancel(IntPtr popup, uint rootProcessId, IntPtr button, out string detail) {
        if (!IsWindow(popup) || !IsWindow(button)) {
            detail = "popup or cancel button handle is no longer valid";
            return false;
        }

        uint popupProcessId;
        GetWindowThreadProcessId(popup, out popupProcessId);
        var popupClass = new StringBuilder(128);
        GetClassName(popup, popupClass, popupClass.Capacity);
        string nativeClass = popupClass.ToString();
        bool recognizedPopup = String.Equals(nativeClass, "#32770", StringComparison.Ordinal) ||
            String.Equals(nativeClass, "TaskDialog", StringComparison.Ordinal) ||
            String.Equals(nativeClass, "Chrome_WidgetWin_1", StringComparison.Ordinal);
        var parents = GetParentProcessIds();
        bool verifiedOwner = popupProcessId == rootProcessId || HasRootOwner(popup, rootProcessId) ||
            IsDescendantOf(popupProcessId, rootProcessId, parents);
        if (!recognizedPopup || !verifiedOwner || !IsChild(popup, button)) {
            detail = "popup ownership, popup class, or child relationship failed validation";
            return false;
        }

        uint buttonProcessId;
        GetWindowThreadProcessId(button, out buttonProcessId);
        var buttonClass = new StringBuilder(128);
        GetClassName(button, buttonClass, buttonClass.Capacity);
        int controlId = GetDlgCtrlID(button);
        if (buttonProcessId != popupProcessId || controlId != 2 ||
            !String.Equals(buttonClass.ToString(), "Button", StringComparison.Ordinal)) {
            detail = "cancel control PID, ID, or class did not match the verified native button";
            return false;
        }

        var buttonText = new StringBuilder(512);
        IntPtr textResult;
        if (SendMessageTimeout(button, WM_GETTEXT, new UIntPtr((uint)buttonText.Capacity), buttonText,
            SMTO_ABORTIFHUNG, 500, out textResult) == IntPtr.Zero) {
            detail = "could not read the verified native cancel button label";
            return false;
        }

        string label = buttonText.ToString().Trim();
        if (!String.Equals(label, "取消", StringComparison.Ordinal) &&
            !String.Equals(label, "Cancel", StringComparison.OrdinalIgnoreCase) &&
            !String.Equals(label, "Cancel (C)", StringComparison.OrdinalIgnoreCase)) {
            detail = "native button ID 2 is not labelled as Cancel: " + label;
            return false;
        }

        IntPtr clickResult;
        if (SendMessageTimeout(button, BM_CLICK, UIntPtr.Zero, IntPtr.Zero,
            SMTO_ABORTIFHUNG, 1000, out clickResult) == IntPtr.Zero) {
            detail = "BM_CLICK did not complete on the verified native cancel button";
            return false;
        }

        detail = label;
        return true;
    }

    // Caller must first match the exact dirty-replacement message through this dialog's UIA tree.
    public static bool TryClickOwnedTaskDialogCancel(IntPtr popup, uint expectedProcessId, IntPtr button, out string detail) {
        if (!IsWindow(popup) || !IsWindow(button) || !IsChild(popup, button)) {
            detail = "TaskDialog or its cancel child is no longer valid";
            return false;
        }
        uint popupProcessId;
        uint buttonProcessId;
        GetWindowThreadProcessId(popup, out popupProcessId);
        GetWindowThreadProcessId(button, out buttonProcessId);
        var popupClass = new StringBuilder(128);
        var buttonClass = new StringBuilder(128);
        GetClassName(popup, popupClass, popupClass.Capacity);
        GetClassName(button, buttonClass, buttonClass.Capacity);
        int controlId = GetDlgCtrlID(button);
        if (popupProcessId != expectedProcessId || buttonProcessId != expectedProcessId ||
            !String.Equals(popupClass.ToString(), "#32770", StringComparison.Ordinal) ||
            !String.Equals(buttonClass.ToString(), "Button", StringComparison.Ordinal) ||
            (controlId != 0 && controlId != 2)) {
            detail = "TaskDialog PID, class, child ID, or button class did not match";
            return false;
        }
        var title = new StringBuilder(512);
        var label = new StringBuilder(512);
        IntPtr result;
        if (SendMessageTimeout(popup, WM_GETTEXT, new UIntPtr((uint)title.Capacity), title,
                SMTO_ABORTIFHUNG, 500, out result) == IntPtr.Zero ||
            !String.Equals(title.ToString(), "ModuTeX", StringComparison.Ordinal) ||
            SendMessageTimeout(button, WM_GETTEXT, new UIntPtr((uint)label.Capacity), label,
                SMTO_ABORTIFHUNG, 500, out result) == IntPtr.Zero ||
            (!String.Equals(label.ToString(), "取消", StringComparison.Ordinal) &&
             !String.Equals(label.ToString(), "Cancel", StringComparison.Ordinal))) {
            detail = "TaskDialog title or exact native Cancel label did not match";
            return false;
        }
        if (SendMessageTimeout(button, BM_CLICK, UIntPtr.Zero, IntPtr.Zero,
                SMTO_ABORTIFHUNG, 1000, out result) == IntPtr.Zero) {
            detail = "BM_CLICK did not complete on the verified TaskDialog cancel child";
            return false;
        }
        detail = label.ToString();
        return true;
    }

    private static Dictionary<uint, uint> ReadParentProcessIds() {
        var parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) return parents;

        try {
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snapshot, ref entry)) {
                do {
                    parents[entry.th32ProcessID] = entry.th32ParentProcessID;
                    entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                } while (Process32Next(snapshot, ref entry));
            }
        } finally {
            CloseHandle(snapshot);
        }

        return parents;
    }

    private static Dictionary<uint, uint> GetParentProcessIds() {
        lock (ParentCacheLock) {
            if (cachedParents == null || DateTime.UtcNow >= parentCacheExpiresUtc) {
                cachedParents = ReadParentProcessIds();
                parentCacheExpiresUtc = DateTime.UtcNow.AddSeconds(1);
            }
            return cachedParents;
        }
    }

    private static bool IsDescendantOf(uint processId, uint rootProcessId, Dictionary<uint, uint> parents) {
        uint current = processId;
        for (int depth = 0; current != 0 && depth < 32; depth++) {
            uint parent;
            if (!parents.TryGetValue(current, out parent) || parent == 0 || parent == current) return false;
            if (parent == rootProcessId) return true;
            current = parent;
        }
        return false;
    }

    private static bool HasRootOwner(IntPtr window, uint rootProcessId) {
        IntPtr owner = GetWindow(window, GW_OWNER);
        for (int depth = 0; owner != IntPtr.Zero && depth < 16; depth++) {
            uint ownerProcessId;
            GetWindowThreadProcessId(owner, out ownerProcessId);
            if (ownerProcessId == rootProcessId) return true;
            owner = GetWindow(owner, GW_OWNER);
        }
        return false;
    }

    public static OwnedNativePopupWindowInfo[] Enumerate(uint rootProcessId) {
        return EnumerateOwnedTopLevel(rootProcessId, true);
    }

    public static OwnedNativePopupWindowInfo[] EnumerateOwnedTopLevel(uint rootProcessId, bool popupsOnly) {
        var parents = GetParentProcessIds();
        var windows = new List<OwnedNativePopupWindowInfo>();

        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (!IsWindowVisible(window)) return true;

            var className = new StringBuilder(128);
            if (GetClassName(window, className, className.Capacity) == 0) return true;
            string nativeClass = className.ToString();
            bool popupClass = String.Equals(nativeClass, "#32770", StringComparison.Ordinal) ||
                String.Equals(nativeClass, "TaskDialog", StringComparison.Ordinal) ||
                String.Equals(nativeClass, "Chrome_WidgetWin_1", StringComparison.Ordinal);
            if (popupsOnly && !popupClass) return true;

            uint processId;
            GetWindowThreadProcessId(window, out processId);
            bool ownedByRoot = HasRootOwner(window, rootProcessId);
            bool verifiedDescendant = processId != rootProcessId && IsDescendantOf(processId, rootProcessId, parents);
            if (popupsOnly && String.Equals(nativeClass, "Chrome_WidgetWin_1", StringComparison.Ordinal) &&
                processId == rootProcessId && !ownedByRoot) return true;
            if (processId != rootProcessId && !ownedByRoot && !verifiedDescendant) return true;

            var title = new StringBuilder(512);
            IntPtr ignoredResult;
            SendMessageTimeout(window, WM_GETTEXT, new UIntPtr((uint)title.Capacity), title,
                SMTO_ABORTIFHUNG, 100, out ignoredResult);
            windows.Add(new OwnedNativePopupWindowInfo(window, processId, nativeClass, title.ToString()));
            return true;
        }, IntPtr.Zero);

        return windows.ToArray();
    }
}
'@
