/*
 * monad-sandbox-appcontainer.exe — Windows AppContainer sandbox launcher.
 *
 * Confines the child process using:
 *   1. AppContainer — separate FS namespace (AC\<name>), network isolation, and
 *      no access to parent-session objects by default (stronger than Low IL).
 *   2. Writable-root ACE grant — the AppContainer SID is granted GENERIC_ALL on
 *      each declared writable root before the child starts.
 *   3. Read-deny ACE — the AppContainer SID is explicitly DENIED read access on
 *      declared credential dirs (~/.ssh, ~/.aws, ~/.gnupg, …), closing the
 *      readDeny gap that the Low IL launcher cannot address.
 *   4. Network capability — absent by default (net: none). Pass --net-client to
 *      grant INTERNET_CLIENT+SERVER+LOCALHOST capabilities (net: filtered or
 *      unrestricted; the egress proxy enforces domain allowlist for filtered).
 *   5. Job Object (KILL_ON_JOB_CLOSE) — child tree is terminated if the
 *      launcher exits, preventing orphaned processes.
 *
 * Profile lifecycle:
 *   CreateAppContainerProfile is idempotent (returns E_ALREADY_EXISTS on reuse).
 *   Profiles are named "monad.<sanitized-session-id>" and persist until the
 *   daemon calls cleanup mode after session disposal.
 *
 * Usage:
 *   monad-sandbox-appcontainer.exe [--writable <path>]... [--deny-read <path>]...
 *       [--profile <name>] [--net-client] -- <cmd> [args...]
 *   monad-sandbox-appcontainer.exe --cleanup-profile <name>
 *
 * Falls back gracefully to an unconfined CreateProcess when AppContainer APIs
 * are unavailable (pre-Win8 or an environment where CreateAppContainerProfile
 * returns a non-retryable error), so old environments stay functional.
 *
 * Compile (cross, from Linux):
 *   x86_64-w64-mingw32-gcc -O2 -s -static -municode \
 *     -o monad-sandbox-appcontainer.exe windows-appcontainer.c \
 *     -ladvapi32 -luserenv
 *   aarch64-w64-mingw32-clang -O2 -s -municode \
 *     -o monad-sandbox-appcontainer-arm64.exe windows-appcontainer.c \
 *     -ladvapi32 -luserenv
 */

#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <userenv.h>
#include <processthreadsapi.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <wchar.h>

/* mingw-w64 < 5.0 may lack PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES */
#ifndef PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
#define PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES \
  ((DWORD_PTR)(9 | 0x00020000)) /* ProcThreadAttributeSecurityCapabilities | INPUT */
#endif

#ifndef _countof
#define _countof(a) (sizeof(a) / sizeof((a)[0]))
#endif

/* Known AppContainer capability SIDs for network access (S-1-15-3-<n>) */
#define CAP_INTERNET_CLIENT      L"S-1-15-3-3"
#define CAP_INTERNET_CLIENT_SRV  L"S-1-15-3-4"
#define CAP_LOCAL_LOOP           L"S-1-15-3-9"  /* loopback to localhost */

#define MAX_WRITABLE  64
#define MAX_DENY_READ 32
#define CMD_LINE_CAP  32768

/* ── logging ─────────────────────────────────────────────────────────────── */

static void warnw(const wchar_t *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fwprintf(stderr, L"monad-sandbox-appcontainer: ");
  vfwprintf(stderr, fmt, ap);
  fputwc(L'\n', stderr);
  va_end(ap);
}

/* ── ACL helpers ─────────────────────────────────────────────────────────── */

/*
 * Add an ACE (grant or deny) for `pSid` on `path`'s DACL.
 * accessMode: GRANT_ACCESS or DENY_ACCESS.
 * permissions: e.g. GENERIC_ALL for write grant, GENERIC_READ for deny.
 *
 * Deny ACEs go at the front of the DACL (Windows DACL ordering rule: deny
 * before allow). SetEntriesInAcl preserves this when DENY_ACCESS is used.
 */
static BOOL SetPathAce(LPCWSTR path, PSID pSid, DWORD permissions, ACCESS_MODE accessMode) {
  PACL pOldDacl = NULL, pNewDacl = NULL;
  PSECURITY_DESCRIPTOR pSD = NULL;
  BOOL ok = FALSE;

  DWORD err = GetNamedSecurityInfoW(path, SE_FILE_OBJECT,
                                    DACL_SECURITY_INFORMATION,
                                    NULL, NULL, &pOldDacl, NULL, &pSD);
  if (err != ERROR_SUCCESS) return FALSE;

  EXPLICIT_ACCESS ea;
  memset(&ea, 0, sizeof(ea));
  ea.grfAccessPermissions    = permissions;
  ea.grfAccessMode           = accessMode;
  ea.grfInheritance          = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  ea.Trustee.TrusteeForm     = TRUSTEE_IS_SID;
  ea.Trustee.TrusteeType     = TRUSTEE_IS_UNKNOWN;
  ea.Trustee.ptstrName       = (LPWSTR)pSid;

  if (SetEntriesInAclW(1, &ea, pOldDacl, &pNewDacl) != ERROR_SUCCESS) goto done;
  ok = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                             DACL_SECURITY_INFORMATION,
                             NULL, NULL, pNewDacl, NULL) == ERROR_SUCCESS;
done:
  if (pSD)      LocalFree(pSD);
  if (pNewDacl) LocalFree(pNewDacl);
  return ok;
}

/* ── AppContainer profile helpers ────────────────────────────────────────── */

/*
 * Create (or reuse) an AppContainer profile and return its SID.
 * Returns NULL on failure; caller frees with FreeSid().
 */
static PSID GetOrCreateProfile(LPCWSTR profileName) {
  PSID acSid = NULL;
  HRESULT hr = CreateAppContainerProfile(
    profileName, L"monad sandbox", L"monad agent execution sandbox",
    NULL, 0, &acSid);

  if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
    /* Profile already exists from a previous session — derive the SID. */
    hr = DeriveAppContainerSidFromAppContainerName(profileName, &acSid);
  }

  if (FAILED(hr)) {
    warnw(L"AppContainer profile '%ls' unavailable (hr=0x%08lX) — falling back to unconfined", profileName, hr);
    return NULL;
  }
  return acSid;
}

/* ── command-line builder ─────────────────────────────────────────────────── */
/* Same Raymond-Chen quoting rules as windows.c */
static void AppendArg(wchar_t *buf, size_t cap, const wchar_t *arg) {
  size_t len = wcslen(buf);
  if (len > 0 && len + 1 < cap) {
    buf[len]     = L' ';
    buf[len + 1] = L'\0';
  }
  wcsncat(buf, L"\"", cap - wcslen(buf) - 1);
  const wchar_t *p = arg;
  while (*p != L'\0') {
    int nbs = 0;
    while (p[nbs] == L'\\') nbs++;
    if (p[nbs] == L'\0') {
      for (int k = 0; k < nbs * 2; k++)
        wcsncat(buf, L"\\", cap - wcslen(buf) - 1);
      break;
    }
    if (p[nbs] == L'"') {
      for (int k = 0; k < nbs * 2 + 1; k++)
        wcsncat(buf, L"\\", cap - wcslen(buf) - 1);
      wcsncat(buf, L"\"", cap - wcslen(buf) - 1);
      p += nbs + 1;
    } else {
      for (int k = 0; k < nbs; k++)
        wcsncat(buf, L"\\", cap - wcslen(buf) - 1);
      wchar_t ch[2] = {p[nbs], L'\0'};
      wcsncat(buf, ch, cap - wcslen(buf) - 1);
      p += nbs + 1;
    }
  }
  wcsncat(buf, L"\"", cap - wcslen(buf) - 1);
}

/* ── wmain ────────────────────────────────────────────────────────────────── */

int wmain(int argc, wchar_t *argv[]) {
  LPCWSTR writable[MAX_WRITABLE];
  LPCWSTR denyRead[MAX_DENY_READ];
  int n_writable  = 0;
  int n_denyRead  = 0;
  int cmd_idx     = -1;
  BOOL netClient  = FALSE;
  LPCWSTR profileName   = L"monad.default";
  LPCWSTR cleanupProfile  = NULL;
  LPCWSTR sweepPrefix     = NULL;

  for (int i = 1; i < argc; i++) {
    if (wcscmp(argv[i], L"--") == 0) {
      cmd_idx = i + 1; break;
    } else if (wcscmp(argv[i], L"--writable") == 0) {
      if (i + 1 >= argc) { warnw(L"--writable requires an argument"); return 1; }
      if (n_writable >= MAX_WRITABLE) { warnw(L"too many --writable paths"); return 1; }
      writable[n_writable++] = argv[++i];
    } else if (wcscmp(argv[i], L"--deny-read") == 0) {
      if (i + 1 >= argc) { warnw(L"--deny-read requires an argument"); return 1; }
      if (n_denyRead >= MAX_DENY_READ) { warnw(L"too many --deny-read paths"); return 1; }
      denyRead[n_denyRead++] = argv[++i];
    } else if (wcscmp(argv[i], L"--profile") == 0) {
      if (i + 1 >= argc) { warnw(L"--profile requires an argument"); return 1; }
      profileName = argv[++i];
    } else if (wcscmp(argv[i], L"--net-client") == 0) {
      netClient = TRUE;
    } else if (wcscmp(argv[i], L"--cleanup-profile") == 0) {
      if (i + 1 >= argc) { warnw(L"--cleanup-profile requires an argument"); return 1; }
      cleanupProfile = argv[++i];
      i = argc; /* stop parsing */
    } else if (wcscmp(argv[i], L"--sweep-profiles") == 0) {
      if (i + 1 >= argc) { warnw(L"--sweep-profiles requires a prefix argument"); return 1; }
      sweepPrefix = argv[++i];
      i = argc; /* stop parsing */
    } else if (wcscmp(argv[i], L"--help") == 0 || wcscmp(argv[i], L"-h") == 0) {
      wprintf(L"monad-sandbox-appcontainer.exe — Windows AppContainer launcher\n"
              L"Usage: [--writable <path>]... [--deny-read <path>]... [--profile <name>]\n"
              L"       [--net-client] -- <cmd> [args...]\n"
              L"       --cleanup-profile <name>\n"
              L"       --sweep-profiles <prefix>\n");
      return 0;
    } else {
      cmd_idx = i; break;
    }
  }

  /* Cleanup mode: delete a single profile by name and exit. */
  if (cleanupProfile) {
    HRESULT hr = DeleteAppContainerProfile(cleanupProfile);
    if (FAILED(hr) && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) {
      warnw(L"DeleteAppContainerProfile '%ls': hr=0x%08lX", cleanupProfile, hr);
      return 1;
    }
    return 0;
  }

  /*
   * Sweep mode: enumerate all AppContainer profiles under
   *   HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\AppContainer\Mappings
   * Each subkey is a SID string; the "Moniker" value is the human-readable name.
   * Delete any profile whose moniker starts with the given prefix (e.g. "monad.").
   * Used by the daemon on startup to reclaim orphaned profiles from prior crashes.
   *
   * Per-user AppContainer profiles created by CreateAppContainerProfile live under
   * HKEY_CURRENT_USER, not HKEY_LOCAL_MACHINE — sweeping the wrong hive finds nothing.
   *
   * Collect matching monikers FIRST, then delete: DeleteAppContainerProfile removes the
   * SID subkey from Mappings, so deleting mid-enumeration shifts the remaining keys left
   * and RegEnumKeyExW(idx++) would skip the next profile.
   */
  if (sweepPrefix) {
    static const WCHAR MAPPINGS[] =
      L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppContainer\\Mappings";
    HKEY hMap;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, MAPPINGS, 0, KEY_READ, &hMap) != ERROR_SUCCESS)
      return 0; /* key absent → nothing to sweep */

    DWORD prefixLen = (DWORD)wcslen(sweepPrefix);
    WCHAR sidStr[256];
    static WCHAR matches[256][256];
    int n_matches = 0;
    for (DWORD idx = 0; n_matches < (int)(_countof(matches)); idx++) {
      DWORD sidLen = (DWORD)(sizeof(sidStr) / sizeof(sidStr[0]));
      LONG rc = RegEnumKeyExW(hMap, idx, sidStr, &sidLen, NULL, NULL, NULL, NULL);
      if (rc == ERROR_NO_MORE_ITEMS) break;
      if (rc != ERROR_SUCCESS) continue;

      HKEY hSid;
      if (RegOpenKeyExW(hMap, sidStr, 0, KEY_READ, &hSid) != ERROR_SUCCESS) continue;

      WCHAR moniker[256] = {0};
      DWORD monikerSz = sizeof(moniker);
      DWORD type = REG_SZ;
      rc = RegQueryValueExW(hSid, L"Moniker", NULL, &type, (LPBYTE)moniker, &monikerSz);
      RegCloseKey(hSid);
      if (rc != ERROR_SUCCESS || type != REG_SZ) continue;

      if (wcsncmp(moniker, sweepPrefix, prefixLen) == 0) {
        wcsncpy(matches[n_matches], moniker, _countof(matches[0]) - 1);
        matches[n_matches][_countof(matches[0]) - 1] = L'\0';
        n_matches++;
      }
    }
    RegCloseKey(hMap);

    for (int j = 0; j < n_matches; j++) {
      HRESULT hr = DeleteAppContainerProfile(matches[j]);
      if (FAILED(hr) && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND))
        warnw(L"sweep: DeleteAppContainerProfile '%ls': hr=0x%08lX", matches[j], hr);
    }
    return 0;
  }

  if (cmd_idx < 0 || cmd_idx >= argc) {
    warnw(L"no command specified");
    return 1;
  }

  /* ── Create/retrieve AppContainer profile ─────────────────────────────── */
  PSID acSid = GetOrCreateProfile(profileName);
  /* acSid == NULL → fall through to unconfined launch below. */

  if (acSid) {
    /* Grant writable roots: AppContainer SID gets GENERIC_ALL. */
    for (int j = 0; j < n_writable; j++) {
      if (!SetPathAce(writable[j], acSid, GENERIC_ALL, GRANT_ACCESS))
        warnw(L"could not grant write on %ls (skipping)", writable[j]);
    }

    /* Deny-read credential dirs: explicit DENY for the AppContainer SID. */
    for (int j = 0; j < n_denyRead; j++) {
      if (!SetPathAce(denyRead[j], acSid, GENERIC_READ | GENERIC_EXECUTE, DENY_ACCESS))
        warnw(L"could not set read-deny on %ls (skipping)", denyRead[j]);
    }
  }

  /* ── Build security capabilities for CreateProcessW ──────────────────── */
  SID_AND_ATTRIBUTES caps[3];
  int nCaps = 0;
  PSID capNetClient  = NULL, capNetSrv = NULL, capLoop = NULL;

  if (acSid && netClient) {
    ConvertStringSidToSidW(CAP_INTERNET_CLIENT,     &capNetClient);
    ConvertStringSidToSidW(CAP_INTERNET_CLIENT_SRV, &capNetSrv);
    ConvertStringSidToSidW(CAP_LOCAL_LOOP,          &capLoop);
    if (capNetClient) { caps[nCaps].Sid = capNetClient; caps[nCaps].Attributes = SE_GROUP_ENABLED; nCaps++; }
    if (capNetSrv)    { caps[nCaps].Sid = capNetSrv;    caps[nCaps].Attributes = SE_GROUP_ENABLED; nCaps++; }
    if (capLoop)      { caps[nCaps].Sid = capLoop;      caps[nCaps].Attributes = SE_GROUP_ENABLED; nCaps++; }
  }

  SECURITY_CAPABILITIES sc;
  memset(&sc, 0, sizeof(sc));
  if (acSid) {
    sc.AppContainerSid  = acSid;
    sc.Capabilities     = nCaps > 0 ? caps : NULL;
    sc.CapabilityCount  = (DWORD)nCaps;
  }

  /* ── Process thread attribute list ───────────────────────────────────── */
  SIZE_T attrSize = 0;
  LPPROC_THREAD_ATTRIBUTE_LIST attrList = NULL;
  if (acSid) {
    InitializeProcThreadAttributeList(NULL, 1, 0, &attrSize);
    attrList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attrSize);
    if (attrList) {
      if (!InitializeProcThreadAttributeList(attrList, 1, 0, &attrSize) ||
          !UpdateProcThreadAttribute(attrList, 0,
                                     PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                     &sc, sizeof(sc), NULL, NULL)) {
        warnw(L"UpdateProcThreadAttribute failed (error %lu) — falling back to unconfined", GetLastError());
        DeleteProcThreadAttributeList(attrList);
        HeapFree(GetProcessHeap(), 0, attrList);
        attrList = NULL;
      }
    }
  }

  /* ── Job Object ───────────────────────────────────────────────────────── */
  HANDLE hJob = CreateJobObjectW(NULL, NULL);
  if (hJob) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION eli;
    memset(&eli, 0, sizeof(eli));
    eli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &eli, sizeof(eli));
  }

  /* ── Build command line ───────────────────────────────────────────────── */
  static wchar_t cmdLine[CMD_LINE_CAP];
  cmdLine[0] = L'\0';
  for (int j = cmd_idx; j < argc; j++)
    AppendArg(cmdLine, _countof(cmdLine), argv[j]);

  /* ── Launch child ─────────────────────────────────────────────────────── */
  PROCESS_INFORMATION pi;
  memset(&pi, 0, sizeof(pi));
  BOOL spawned = FALSE;

  if (attrList) {
    STARTUPINFOEXW siex;
    memset(&siex, 0, sizeof(siex));
    siex.StartupInfo.cb = sizeof(siex);
    siex.lpAttributeList = attrList;
    spawned = CreateProcessW(NULL, cmdLine, NULL, NULL, TRUE,
                             CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                             EXTENDED_STARTUPINFO_PRESENT,
                             NULL, NULL, &siex.StartupInfo, &pi);
    if (!spawned)
      warnw(L"AppContainer CreateProcessW failed (error %lu) — retrying unconfined", GetLastError());
  }

  if (!spawned) {
    STARTUPINFOW si;
    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    spawned = CreateProcessW(NULL, cmdLine, NULL, NULL, TRUE,
                             CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                             NULL, NULL, &si, &pi);
  }

  if (!spawned) {
    warnw(L"CreateProcess %ls: error %lu", argv[cmd_idx], GetLastError());
    if (attrList) { DeleteProcThreadAttributeList(attrList); HeapFree(GetProcessHeap(), 0, attrList); }
    if (hJob)     CloseHandle(hJob);
    if (acSid)    FreeSid(acSid);
    if (capNetClient) FreeSid(capNetClient);
    if (capNetSrv)    FreeSid(capNetSrv);
    if (capLoop)      FreeSid(capLoop);
    return 126;
  }

  if (hJob) AssignProcessToJobObject(hJob, pi.hProcess);
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);

  if (attrList) { DeleteProcThreadAttributeList(attrList); HeapFree(GetProcessHeap(), 0, attrList); }
  if (acSid)    FreeSid(acSid);
  if (capNetClient) FreeSid(capNetClient);
  if (capNetSrv)    FreeSid(capNetSrv);
  if (capLoop)      FreeSid(capLoop);

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD exitCode = 1;
  GetExitCodeProcess(pi.hProcess, &exitCode);
  CloseHandle(pi.hProcess);
  if (hJob) CloseHandle(hJob);

  return (int)exitCode;
}
