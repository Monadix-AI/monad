/*
 * monad-sandbox-launcher — Landlock FS write-restriction launcher for Linux.
 *
 * Usage:
 *   monad-sandbox-launcher [--writable <path>]... [--net none] -- <cmd> [args...]
 *
 * Applies a Landlock ruleset that confines the child (and all its descendants,
 * since Landlock is inherited across fork/exec) to writing only to the listed
 * paths. Read access is NOT in the managed set, so reads remain unrestricted.
 *
 * With --net none, a seccomp filter also denies AF_INET/AF_INET6 socket creation,
 * so the child has no IP egress at the kernel level (a raw socket can't bypass the
 * HTTP(S)_PROXY env). AF_UNIX is unaffected. Other --net values are no-ops here
 * (net:'filtered' is enforced by the application-layer egress proxy, not seccomp).
 *
 * If Landlock is unavailable (kernel < 5.13 or CONFIG_SECURITY_LANDLOCK=n),
 * a warning is printed and the command runs unconfined rather than failing.
 *
 * Compile:
 *   gcc -O2 -s -static -o monad-sandbox-launcher main.c
 *   aarch64-linux-gnu-gcc -O2 -s -static -o monad-sandbox-launcher-arm64 main.c
 *   musl-gcc -O2 -s -static -o monad-sandbox-launcher-musl main.c
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Socket address families — fall back to the stable Linux ABI values if the
 * headers don't provide them (static musl builds, minimal sysroots). */
#ifndef AF_INET
#define AF_INET 2
#endif
#ifndef AF_INET6
#define AF_INET6 10
#endif

/* ── Landlock syscall wrappers ─────────────────────────────────────────────── */

static int ll_create_ruleset(const struct landlock_ruleset_attr *attr,
                              size_t size, uint32_t flags) {
  return (int)syscall(SYS_landlock_create_ruleset, attr, size, flags);
}

static int ll_add_rule(int ruleset_fd, enum landlock_rule_type rule_type,
                       const void *rule_attr, uint32_t flags) {
  return (int)syscall(SYS_landlock_add_rule, ruleset_fd, rule_type,
                      rule_attr, flags);
}

static int ll_restrict_self(int ruleset_fd, uint32_t flags) {
  return (int)syscall(SYS_landlock_restrict_self, ruleset_fd, flags);
}

/* ── Write-access-right bitmasks per ABI version ─────────────────────────── */

/* ABI 1 (kernel ≥ 5.13): base write + make rights. */
#define WRITE_V1                             \
  (LANDLOCK_ACCESS_FS_WRITE_FILE |           \
   LANDLOCK_ACCESS_FS_REMOVE_DIR |           \
   LANDLOCK_ACCESS_FS_REMOVE_FILE |          \
   LANDLOCK_ACCESS_FS_MAKE_CHAR |            \
   LANDLOCK_ACCESS_FS_MAKE_DIR |             \
   LANDLOCK_ACCESS_FS_MAKE_REG |             \
   LANDLOCK_ACCESS_FS_MAKE_SOCK |            \
   LANDLOCK_ACCESS_FS_MAKE_FIFO |            \
   LANDLOCK_ACCESS_FS_MAKE_BLOCK |           \
   LANDLOCK_ACCESS_FS_MAKE_SYM)

/* ABI 2 (kernel ≥ 5.19): cross-directory hard-link control. */
#define WRITE_V2 (WRITE_V1 | LANDLOCK_ACCESS_FS_REFER)

/* ABI 3 (kernel ≥ 6.2): truncate. */
#define WRITE_V3 (WRITE_V2 | LANDLOCK_ACCESS_FS_TRUNCATE)

static uint64_t write_rights_for_abi(int abi) {
  if (abi >= 3) return WRITE_V3;
  if (abi >= 2) return WRITE_V2;
  return WRITE_V1;
}

/* ── seccomp-bpf: deny the most dangerous process-manipulation syscalls ───── */
/*
 * Landlock handles "what the child may write"; seccomp adds a complementary
 * "what the child may do to other processes". We deny only the calls that
 * work without CAP_SYS_ADMIN and pose a real threat in this threat model:
 *
 *   ptrace            — same-UID processes can trace/inject each other
 *   process_vm_writev — cross-process memory write (ptrace-like but faster)
 *   open_by_handle_at — can escape Landlock via a stale file handle leaked
 *                       from an ancestor process (e.g. the daemon's open fds)
 *
 * We return EPERM rather than killing the process so a sandboxed script that
 * innocently calls ptrace() (e.g. GDB inside a dev container) fails gracefully
 * with a clear error instead of a mysterious SIGKILL.
 *
 * PR_SET_NO_NEW_PRIVS must be set before SECCOMP_MODE_FILTER; apply_landlock
 * already sets it, but we set it here too so seccomp works standalone (n_writable=0).
 *
 * When block_inet is set (policy net:'none'), additionally deny creation of IP
 * sockets (AF_INET/AF_INET6) so the child has NO network egress at the kernel
 * level — not merely via HTTP(S)_PROXY env (which a raw socket trivially ignores).
 * socket()'s domain is args[0], a scalar seccomp can inspect directly. AF_UNIX
 * stays allowed so local IPC (and the proxy path under net:'filtered') is unaffected.
 */
static void apply_seccomp(int block_inet) {
  prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); /* idempotent if already set */

#ifndef SECCOMP_RET_ERRNO
  /* Kernel headers too old to define SECCOMP constants — skip silently. */
  (void)block_inet;
  return;
#else
  /*
   * BPF_JUMP(op, k, jt, jf): if accumulator==k jump +jt else jump +jf (in instructions).
   * Built incrementally so the optional socket block can be appended only when needed.
   */
  struct sock_filter filter[24];
  int n = 0;

  /* Load syscall number into accumulator. */
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));

  /* Process-manipulation denials: match → fall through to EPERM; else skip it. */
  filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ptrace, 0, 1);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_process_vm_writev, 0, 1);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_open_by_handle_at, 0, 1);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);

#ifdef SYS_socket
  /* net:'none' → deny AF_INET/AF_INET6 socket creation. A still holds the syscall
   * nr here (the denials above don't reload it). On a non-socket call jump past the
   * whole block to ALLOW; otherwise load the domain (args[0]) and deny the two IP
   * families. socketcall-only arches (i386) lack SYS_socket and are simply not built. */
  if (block_inet) {
    filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 4);
    filter[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
    filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 1, 0);
    filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 0, 1);
    filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES);
  }
#else
  (void)block_inet;
#endif

  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);

  struct sock_fprog prog = {.len = (unsigned short)n, .filter = filter};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) < 0) {
    if (errno != EINVAL && errno != ENOSYS)
      perror("monad-sandbox-launcher: prctl(PR_SET_SECCOMP)");
    /* EINVAL / ENOSYS = kernel doesn't support seccomp-bpf; fall through. */
  }
#endif
}

/* ── Apply Landlock write restriction ────────────────────────────────────── */

#define MAX_WRITABLE 64

static int apply_landlock(const char *writable[], int n_writable) {
  /* Probe ABI — returns version ≥ 1 on success, -1 if unsupported. */
  int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) {
    fprintf(stderr,
            "monad-sandbox-launcher: Landlock unavailable (%s) — running unconfined\n",
            (abi < 0 && errno == EOPNOTSUPP) ? "kernel too old or disabled"
                                             : strerror(errno));
    return 0; /* non-fatal: fall through to exec */
  }

  uint64_t write_rights = write_rights_for_abi(abi);
  struct landlock_ruleset_attr rs_attr = {.handled_access_fs = write_rights};
  int rs = ll_create_ruleset(&rs_attr, sizeof(rs_attr), 0);
  if (rs < 0) {
    perror("monad-sandbox-launcher: landlock_create_ruleset");
    return -1;
  }

  for (int i = 0; i < n_writable; i++) {
    /*
     * O_PATH opens without reading content — works on files and directories,
     * and avoids EACCES on paths we don't need to read.  ENOENT is normal:
     * session sandbox roots are created on demand and may not exist yet.
     */
    int fd = open(writable[i], O_PATH | O_CLOEXEC);
    if (fd < 0) {
      if (errno != ENOENT)
        fprintf(stderr, "monad-sandbox-launcher: open %s: %s (skipping)\n",
                writable[i], strerror(errno));
      continue;
    }
    struct landlock_path_beneath_attr pb = {.allowed_access = write_rights,
                                            .parent_fd = fd};
    int ret = ll_add_rule(rs, LANDLOCK_RULE_PATH_BENEATH, &pb, 0);
    close(fd);
    if (ret < 0) {
      perror("monad-sandbox-launcher: landlock_add_rule");
      close(rs);
      return -1;
    }
  }

  /* PR_SET_NO_NEW_PRIVS must be set before restrict_self. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    perror("monad-sandbox-launcher: prctl(PR_SET_NO_NEW_PRIVS)");
    close(rs);
    return -1;
  }

  if (ll_restrict_self(rs, 0) < 0) {
    perror("monad-sandbox-launcher: landlock_restrict_self");
    close(rs);
    return -1;
  }

  close(rs);
  return 0;
}

/* ── main ────────────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
  const char *writable[MAX_WRITABLE];
  int n_writable = 0;
  int block_inet = 0;
  int i;

  for (i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    }
    if (strcmp(argv[i], "--writable") == 0) {
      if (i + 1 >= argc) {
        fputs("monad-sandbox-launcher: --writable requires an argument\n", stderr);
        return 1;
      }
      if (n_writable >= MAX_WRITABLE) {
        fprintf(stderr,
                "monad-sandbox-launcher: too many --writable paths (max %d)\n",
                MAX_WRITABLE);
        return 1;
      }
      writable[n_writable++] = argv[++i];
    } else if (strcmp(argv[i], "--net") == 0) {
      if (i + 1 >= argc) {
        fputs("monad-sandbox-launcher: --net requires an argument\n", stderr);
        return 1;
      }
      /* Only 'none' triggers the seccomp socket block; other modes are no-ops here. */
      if (strcmp(argv[++i], "none") == 0) block_inet = 1;
    } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      puts("monad-sandbox-launcher — Landlock FS write-restriction + seccomp launcher\n"
           "Usage: monad-sandbox-launcher [--writable <path>]... [--net none] -- <cmd> [args...]");
      return 0;
    } else {
      /* Unknown flag — treat remaining args as the command (no leading --). */
      break;
    }
  }

  if (i >= argc) {
    fputs("monad-sandbox-launcher: no command specified\n", stderr);
    return 1;
  }

  if (n_writable > 0 && apply_landlock(writable, n_writable) < 0)
    return 1;

  apply_seccomp(block_inet);

  execvp(argv[i], &argv[i]);
  fprintf(stderr, "monad-sandbox-launcher: exec %s: %s\n", argv[i],
          strerror(errno));
  return 126;
}
