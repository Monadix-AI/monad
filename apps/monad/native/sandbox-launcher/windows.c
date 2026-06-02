/*
 * monad-sandbox-launcher.exe — Windows write-restriction launcher.
 *
 * Confines the child process using:
 *   1. Low Integrity token — prevents writes to Medium/High integrity objects
 *      (user profile, SSH keys, monad config, registry) via Windows MIC.
 *   2. Job Object (KILL_ON_JOB_CLOSE) — child tree is terminated if the
 *      launcher exits, preventing orphaned processes.
 *
 * Writable roots are granted Low Integrity GENERIC_ALL in their DACL before
 * the child launches, so the child can write there despite Low IL.
 *
 * Falls back gracefully to an unconfined CreateProcess if token manipulation
 * fails (e.g. running inside an existing Low Integrity process or a CI
 * environment that restricts DuplicateTokenEx).
 *
 * Usage:
 *   monad-sandbox-launcher.exe [--writable <path>]... -- <cmd> [args...]
 *
 * Compile (cross, from Linux):
 *   x86_64-w64-mingw32-gcc -O2 -s -static -municode \
 *     -o monad-sandbox-launcher.exe windows.c -ladvapi32
 */

#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <wchar.h>

#ifndef _countof
#define _countof(a) (sizeof(a) / sizeof((a)[0]))
#endif

#define MAX_WRITABLE 64
#define CMD_LINE_CAP 32768

/* Low Integrity Mandatory Level (SDDL SID S-1-16-4096 = 0x1000). */
#define LOW_IL_SID L"S-1-16-4096"

/* ── logging ─────────────────────────────────────────────────────────────── */

static void warnw(const wchar_t *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fwprintf(stderr, L"monad-sandbox-launcher: ");
  vfwprintf(stderr, fmt, ap);
  fputwc(L'\n', stderr);
  va_end(ap);
}

/* ── grant Low Integrity SID GENERIC_ALL on a path's DACL ───────────────── */

static BOOL GrantLowIntegrity(LPCWSTR path) {
  PSID pSid = NULL;
  PACL pOldDacl = NULL, pNewDacl = NULL;
  PSECURITY_DESCRIPTOR pSD = NULL;
  BOOL ok = FALSE;

  if (!ConvertStringSidToSidW(LOW_IL_SID, &pSid))
    return FALSE;

  if (GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            NULL, NULL, &pOldDacl, NULL, &pSD) != ERROR_SUCCESS)
    goto done;

  EXPLICIT_ACCESS ea;
  memset(&ea, 0, sizeof(ea));
  ea.grfAccessPermissions       = GENERIC_ALL;
  ea.grfAccessMode              = GRANT_ACCESS;
  ea.grfInheritance             = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  ea.Trustee.TrusteeForm        = TRUSTEE_IS_SID;
  ea.Trustee.TrusteeType        = TRUSTEE_IS_WELL_KNOWN_GROUP;
  ea.Trustee.ptstrName          = (LPWSTR)pSid;

  if (SetEntriesInAclW(1, &ea, pOldDacl, &pNewDacl) != ERROR_SUCCESS) goto done;
  ok = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                             DACL_SECURITY_INFORMATION,
                             NULL, NULL, pNewDacl, NULL) == ERROR_SUCCESS;
done:
  if (pSD)      LocalFree(pSD);
  if (pNewDacl) LocalFree(pNewDacl);
  if (pSid)     FreeSid(pSid);
  return ok;
}

/* ── create a Low Integrity duplicate of our process token ──────────────── */

static HANDLE MakeLowToken(void) {
  HANDLE hSrc = NULL, hDup = NULL;
  PSID pSid = NULL;
  TOKEN_MANDATORY_LABEL tml;
  memset(&tml, 0, sizeof(tml));

  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &hSrc)) goto fail;
  if (!DuplicateTokenEx(hSrc, TOKEN_ALL_ACCESS, NULL,
                        SecurityImpersonation, TokenPrimary, &hDup)) goto fail;
  CloseHandle(hSrc);
  hSrc = NULL;

  if (!ConvertStringSidToSidW(LOW_IL_SID, &pSid)) goto fail;
  tml.Label.Attributes = SE_GROUP_INTEGRITY;
  tml.Label.Sid        = pSid;
  if (!SetTokenInformation(hDup, TokenIntegrityLevel, &tml, sizeof(tml))) goto fail;

  FreeSid(pSid);
  return hDup;

fail:
  if (hSrc) CloseHandle(hSrc);
  if (hDup) CloseHandle(hDup);
  if (pSid) FreeSid(pSid);
  return NULL;
}

/* ── append one argument to a Windows CreateProcess command line ─────────── */
/*
 * Follows the quoting rules described in CommandLineToArgvW documentation
 * (Raymond Chen's "Parsing C++ command-line arguments" rules):
 *   - n backslashes before a '"': emit 2n+1 backslashes + escaped quote
 *   - n backslashes at end of arg: emit 2n backslashes (closing '"' follows)
 *   - n backslashes elsewhere: emit n backslashes
 * Always wraps the argument in double quotes.
 */
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
      /* Trailing backslashes: double them before the closing '"'. */
      for (int k = 0; k < nbs * 2; k++)
        wcsncat(buf, L"\\", cap - wcslen(buf) - 1);
      break;
    }
    if (p[nbs] == L'"') {
      /* Backslashes before an internal quote: 2n+1 + escaped quote. */
      for (int k = 0; k < nbs * 2 + 1; k++)
        wcsncat(buf, L"\\", cap - wcslen(buf) - 1);
      wcsncat(buf, L"\"", cap - wcslen(buf) - 1);
      p += nbs + 1;
    } else {
      /* Regular run: copy backslashes unchanged + the character. */
      for (int k = 0; k < nbs; k++)
        wcsncat(buf, L"\\", cap - wcslen(buf) - 1);
      wchar_t ch[2] = {p[nbs], L'\0'};
      wcsncat(buf, ch, cap - wcslen(buf) - 1);
      p += nbs + 1;
    }
  }

  wcsncat(buf, L"\"", cap - wcslen(buf) - 1);
}

/* ── wmain ───────────────────────────────────────────────────────────────── */

int wmain(int argc, wchar_t *argv[]) {
  LPCWSTR writable[MAX_WRITABLE];
  int n_writable = 0;
  int cmd_idx    = -1;
  int i;

  for (i = 1; i < argc; i++) {
    if (wcscmp(argv[i], L"--") == 0)          { cmd_idx = i + 1; break; }
    if (wcscmp(argv[i], L"--writable") == 0)  {
      if (i + 1 >= argc) { warnw(L"--writable requires an argument"); return 1; }
      if (n_writable >= MAX_WRITABLE) { warnw(L"too many --writable paths (max %d)", MAX_WRITABLE); return 1; }
      writable[n_writable++] = argv[++i];
    } else if (wcscmp(argv[i], L"--help") == 0 || wcscmp(argv[i], L"-h") == 0) {
      wprintf(L"monad-sandbox-launcher.exe -- Windows Low Integrity launcher\n"
              L"Usage: monad-sandbox-launcher.exe [--writable <path>]... -- <cmd> [args...]\n");
      return 0;
    } else {
      cmd_idx = i; break;
    }
  }

  if (cmd_idx < 0 || cmd_idx >= argc) {
    warnw(L"no command specified");
    return 1;
  }

  /* Grant Low Integrity write on each writable root (best-effort; path may not exist yet). */
  for (int j = 0; j < n_writable; j++) {
    if (!GrantLowIntegrity(writable[j]))
      warnw(L"could not grant write on %ls (skipping)", writable[j]);
  }

  /* Low Integrity token — derived from our own token so no privilege is required. */
  HANDLE hLowToken = MakeLowToken();
  if (!hLowToken)
    warnw(L"Low Integrity token unavailable (error %lu) -- running unconfined", GetLastError());

  /* Job Object: terminate child tree when the launcher exits. */
  HANDLE hJob = CreateJobObjectW(NULL, NULL);
  if (hJob) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION eli;
    memset(&eli, 0, sizeof(eli));
    eli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &eli, sizeof(eli));
  }

  /* Build command line. */
  static wchar_t cmdLine[CMD_LINE_CAP];
  cmdLine[0] = L'\0';
  for (int j = cmd_idx; j < argc; j++)
    AppendArg(cmdLine, _countof(cmdLine), argv[j]);

  /* Launch the child. */
  STARTUPINFOW si;
  memset(&si, 0, sizeof(si));
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi;
  memset(&pi, 0, sizeof(pi));
  BOOL spawned;

  if (hLowToken) {
    spawned = CreateProcessAsUserW(hLowToken, NULL, cmdLine,
                                   NULL, NULL, TRUE,
                                   CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                                   NULL, NULL, &si, &pi);
    if (!spawned && GetLastError() == ERROR_PRIVILEGE_NOT_HELD) {
      /* Already at Low IL or privilege missing: fall back to normal launch. */
      CloseHandle(hLowToken);
      hLowToken = NULL;
      spawned   = CreateProcessW(NULL, cmdLine, NULL, NULL, TRUE,
                                  CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                                  NULL, NULL, &si, &pi);
    }
  } else {
    spawned = CreateProcessW(NULL, cmdLine, NULL, NULL, TRUE,
                              CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                              NULL, NULL, &si, &pi);
  }

  if (!spawned) {
    warnw(L"CreateProcess %ls: error %lu", argv[cmd_idx], GetLastError());
    if (hLowToken) CloseHandle(hLowToken);
    if (hJob)      CloseHandle(hJob);
    return 126;
  }

  if (hJob) AssignProcessToJobObject(hJob, pi.hProcess);
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  if (hLowToken) CloseHandle(hLowToken);

  /* Wait and forward child exit code. */
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD exitCode = 1;
  GetExitCodeProcess(pi.hProcess, &exitCode);
  CloseHandle(pi.hProcess);
  if (hJob) CloseHandle(hJob);

  return (int)exitCode;
}
