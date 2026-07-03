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
/* AppContainer APIs (CreateAppContainerProfile/DeriveAppContainerSidFromAppContainerName/
 * DeleteAppContainerProfile) are declared in userenv.h only when the target Windows version is
 * Win8+. Without this, clang (llvm-mingw, used for the arm64 release build) errors on the
 * implicit declarations and gcc silently builds wrong int-returning stubs. */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00 /* Windows 10 */
#endif
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

/*
 * Remove every ACE for `pSid` from `path`'s DACL — reverts a prior SetPathAce.
 *
 * We edit the ACL directly (GetAce + DeleteAce) rather than SetEntriesInAcl(REVOKE_ACCESS):
 * REVOKE removes the trustee's ALLOW ACEs but leaves its DENY ACEs, so a reverted deny-read
 * would linger as an orphaned-SID ACE. Deleting matching allow AND deny ACEs covers both, plus
 * the inherit-only copy SetEntriesInAcl split out. Removing the inheritable ACE on a directory
 * also clears the copies inherited onto its children.
 */
static void RemovePathAce(LPCWSTR path, PSID pSid) {
  PACL pDacl = NULL;
  PSECURITY_DESCRIPTOR pSD = NULL;
  if (GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            NULL, NULL, &pDacl, NULL, &pSD) != ERROR_SUCCESS)
    return;

  if (pDacl) {
    BOOL changed = FALSE;
    /* Walk backwards so DeleteAce's index shift doesn't skip the next entry. */
    for (LONG i = (LONG)pDacl->AceCount - 1; i >= 0; i--) {
      ACE_HEADER *hdr = NULL;
      if (!GetAce(pDacl, (DWORD)i, (LPVOID *)&hdr)) continue;
      PSID aceSid = NULL;
      if (hdr->AceType == ACCESS_ALLOWED_ACE_TYPE)
        aceSid = (PSID)&((ACCESS_ALLOWED_ACE *)hdr)->SidStart;
      else if (hdr->AceType == ACCESS_DENIED_ACE_TYPE)
        aceSid = (PSID)&((ACCESS_DENIED_ACE *)hdr)->SidStart;
      else
        continue;
      if (EqualSid(aceSid, pSid)) { DeleteAce(pDacl, (DWORD)i); changed = TRUE; }
    }
    if (changed)
      SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            NULL, NULL, pDacl, NULL);
  }

  if (pSD) LocalFree(pSD);
}

/*
 * Revert all grant/deny ACEs applied for `acSid` before launch. Called on every exit path
 * after the ACEs were set — normal child exit AND the CreateProcessW fallback — so the host's
 * DACLs are never left mutated by a run (the ACEs are scoped to the child's lifetime).
 */
static void RevertAppliedAces(LPCWSTR *writable, int n_writable,
                              LPCWSTR *denyRead, int n_denyRead, PSID acSid) {
  for (int j = 0; j < n_writable; j++) RemovePathAce(writable[j], acSid);
  for (int j = 0; j < n_denyRead; j++) RemovePathAce(denyRead[j], acSid);
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
  /* Only quote when needed (arg empty, or contains space/tab/quote). Unconditional quoting
   * breaks cmd.exe: it mis-parses `"cmd" "/c" "ver"` because a quoted `/c` switch and a quoted
   * command tail defeat cmd's own quote-stripping. A normal exe's argv parser is unaffected
   * either way, so conditional quoting is correct for every target and fixes cmd. */
  if (arg[0] != L'\0' && !wcspbrk(arg, L" \t\"")) {
    wcsncat(buf, arg, cap - wcslen(buf) - 1);
    return;
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
   * Sweep mode: delete every AppContainer profile whose moniker starts with `sweepPrefix`
   * (e.g. "monad."). Used by the daemon on startup to reclaim profiles orphaned by a prior
   * crash (disposeSession was never called).
   *
   * A profile created by CreateAppContainerProfile materializes as a folder
   *   %LOCALAPPDATA%\Packages\<moniker>
   * The registry "AppContainer\Mappings" key is NOT a reliable enumeration source — it is
   * absent on modern Windows (verified Win11 26200), so we enumerate the Packages folder
   * directly: the folder name IS the moniker, and DeleteAppContainerProfile(moniker) removes
   * both the profile and its folder.
   *
   * Collect names FIRST, then delete: DeleteAppContainerProfile removes the folder, which
   * would disrupt an interleaved FindNextFile enumeration.
   */
  if (sweepPrefix) {
    WCHAR localAppData[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, _countof(localAppData));
    if (n == 0 || n >= _countof(localAppData)) return 0;

    WCHAR pattern[MAX_PATH];
    swprintf(pattern, _countof(pattern), L"%ls\\Packages\\%ls*", localAppData, sweepPrefix);

    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0; /* nothing matches → nothing to sweep */

    static WCHAR matches[256][256];
    int n_matches = 0;
    do {
      if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
      if (fd.cFileName[0] == L'.') continue;
      if (n_matches >= (int)_countof(matches)) break;
      wcsncpy(matches[n_matches], fd.cFileName, _countof(matches[0]) - 1);
      matches[n_matches][_countof(matches[0]) - 1] = L'\0';
      n_matches++;
    } while (FindNextFileW(h, &fd));
    FindClose(h);

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
    if (acSid) {
      RevertAppliedAces(writable, n_writable, denyRead, n_denyRead, acSid);
      FreeSid(acSid);
    }
    if (capNetClient) FreeSid(capNetClient);
    if (capNetSrv)    FreeSid(capNetSrv);
    if (capLoop)      FreeSid(capLoop);
    return 126;
  }

  if (hJob) AssignProcessToJobObject(hJob, pi.hProcess);
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);

  if (attrList) { DeleteProcThreadAttributeList(attrList); HeapFree(GetProcessHeap(), 0, attrList); }
  if (capNetClient) FreeSid(capNetClient);
  if (capNetSrv)    FreeSid(capNetSrv);
  if (capLoop)      FreeSid(capLoop);

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD exitCode = 1;
  GetExitCodeProcess(pi.hProcess, &exitCode);
  CloseHandle(pi.hProcess);
  if (hJob) CloseHandle(hJob);

  // Revert the grant/deny ACEs we set before launch — they are scoped to the child's lifetime,
  // never left on the host. acSid is kept alive until here for exactly this; freed after.
  if (acSid) {
    RevertAppliedAces(writable, n_writable, denyRead, n_denyRead, acSid);
    FreeSid(acSid);
  }

  return (int)exitCode;
}
