#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef SECCOMP_FILTER_FLAG_NEW_LISTENER
#define SECCOMP_FILTER_FLAG_NEW_LISTENER (1UL << 3)
#endif
#ifndef SECCOMP_RET_USER_NOTIF
#define SECCOMP_RET_USER_NOTIF 0x7fc00000U
#endif
#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif
#ifndef SECCOMP_GET_NOTIF_SIZES
#define SECCOMP_GET_NOTIF_SIZES 3
#endif
#ifndef SECCOMP_IOCTL_NOTIF_RECV
#define SECCOMP_IOC_MAGIC '!'
#define SECCOMP_IOCTL_NOTIF_RECV _IOWR(SECCOMP_IOC_MAGIC, 0, struct seccomp_notif)
#define SECCOMP_IOCTL_NOTIF_SEND _IOWR(SECCOMP_IOC_MAGIC, 1, struct seccomp_notif_resp)
#define SECCOMP_IOCTL_NOTIF_ID_VALID _IOW(SECCOMP_IOC_MAGIC, 2, __u64)
#endif
#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif

#if defined(__x86_64__)
#define OBS_AUDIT_ARCH AUDIT_ARCH_X86_64
#define OBS_HAS_X32 1
#elif defined(__aarch64__)
#define OBS_AUDIT_ARCH AUDIT_ARCH_AARCH64
#define OBS_HAS_X32 0
#else
#error unsupported architecture
#endif

#define OBS_PATH_CAP 4097
#define OBS_RESOLVED_CAP 8192
#define OBS_LINE_CAP 16640
#define OBS_WRITE_MASK ((unsigned)(O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND))

enum path_kind {
    PATH_NONE,
    PATH_CWD,
    PATH_DIRFD,
    PATH_FD
};

struct observed_call {
    int nr;
    const char *name;
    int8_t path_arg;
    int8_t path2_arg;
    int8_t dirfd_arg;
    int8_t dirfd2_arg;
    int8_t flags_arg;
    enum path_kind kind;
    enum path_kind kind2;
};

static const struct observed_call observed_calls[] = {
    {__NR_openat, "openat", 1, -1, 0, -1, 2, PATH_DIRFD, PATH_NONE},
#ifdef __NR_openat2
    {__NR_openat2, "openat2", 1, -1, 0, -1, -2, PATH_DIRFD, PATH_NONE},
#endif
    {__NR_unlinkat, "unlinkat", 1, -1, 0, -1, -1, PATH_DIRFD, PATH_NONE},
    {__NR_mkdirat, "mkdirat", 1, -1, 0, -1, -1, PATH_DIRFD, PATH_NONE},
    {__NR_mknodat, "mknodat", 1, -1, 0, -1, -1, PATH_DIRFD, PATH_NONE},
    {__NR_symlinkat, "symlinkat", 2, -1, 1, -1, -1, PATH_DIRFD, PATH_NONE},
    {__NR_linkat, "linkat", 1, 3, 0, 2, -1, PATH_DIRFD, PATH_DIRFD},
#ifdef __NR_renameat
    {__NR_renameat, "renameat", 1, 3, 0, 2, -1, PATH_DIRFD, PATH_DIRFD},
#endif
#ifdef __NR_renameat2
    {__NR_renameat2, "renameat2", 1, 3, 0, 2, -1, PATH_DIRFD, PATH_DIRFD},
#endif
#ifdef __x86_64__
    {__NR_open, "open", 0, -1, -1, -1, 1, PATH_CWD, PATH_NONE},
    {__NR_creat, "creat", 0, -1, -1, -1, -1, PATH_CWD, PATH_NONE},
    {__NR_unlink, "unlink", 0, -1, -1, -1, -1, PATH_CWD, PATH_NONE},
    {__NR_rmdir, "rmdir", 0, -1, -1, -1, -1, PATH_CWD, PATH_NONE},
    {__NR_rename, "rename", 0, 1, -1, -1, -1, PATH_CWD, PATH_CWD},
    {__NR_link, "link", 0, 1, -1, -1, -1, PATH_CWD, PATH_CWD},
    {__NR_symlink, "symlink", 1, -1, -1, -1, -1, PATH_CWD, PATH_NONE},
    {__NR_mkdir, "mkdir", 0, -1, -1, -1, -1, PATH_CWD, PATH_NONE},
    {__NR_mknod, "mknod", 0, -1, -1, -1, -1, PATH_CWD, PATH_NONE},
    {__NR_truncate, "truncate", 0, -1, -1, -1, -1, PATH_CWD, PATH_NONE},
#endif
    {__NR_ftruncate, "ftruncate", 0, -1, -1, -1, -1, PATH_FD, PATH_NONE},
};

static volatile sig_atomic_t workload_pid = -1;

static void forward_signal(int signal_number) {
    pid_t pid = (pid_t)workload_pid;
    if (pid > 0) kill(pid, signal_number);
}

static void install_signal_forwarders(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = forward_signal;
    sigemptyset(&action.sa_mask);
    const int forwarded[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
    for (size_t index = 0; index < sizeof(forwarded) / sizeof(forwarded[0]); index++) sigaction(forwarded[index], &action, NULL);
    signal(SIGPIPE, SIG_IGN);
}

static int exit_like_child(int status) {
    if (WIFSIGNALED(status)) {
        int signal_number = WTERMSIG(status);
        struct sigaction action;
        memset(&action, 0, sizeof(action));
        action.sa_handler = SIG_DFL;
        sigemptyset(&action.sa_mask);
        sigaction(signal_number, &action, NULL);
        raise(signal_number);
        return 128 + signal_number;
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}

static const struct observed_call *find_call(int nr) {
    size_t count = sizeof(observed_calls) / sizeof(observed_calls[0]);
    for (size_t index = 0; index < count; index++) {
        if (observed_calls[index].nr == nr) return &observed_calls[index];
    }
    return NULL;
}

static int build_filter(struct sock_filter *filter, size_t capacity) {
    int length = 0;
#define EMIT(instruction) do { if ((size_t)length >= capacity) return -1; filter[length++] = (struct sock_filter)instruction; } while (0)
#define OFFSET(index, target) ((unsigned char)((target) - (index) - 1))
    EMIT(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)));
    int arch_jump = length;
    EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, OBS_AUDIT_ARCH, 0, 0));
    EMIT(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));
#if OBS_HAS_X32
    int x32_jump = length;
    EMIT(BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000u, 0, 0));
#endif

    int notify_jumps[64];
    size_t notify_count = 0;
    struct gated_jump { int syscall_jump; int flags_jump; } gated[8];
    size_t gated_count = 0;
    size_t call_count = sizeof(observed_calls) / sizeof(observed_calls[0]);
    for (size_t index = 0; index < call_count; index++) {
        if (observed_calls[index].flags_arg >= 0) continue;
        notify_jumps[notify_count++] = length;
        EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned)observed_calls[index].nr, 0, 0));
    }
    for (size_t index = 0; index < call_count; index++) {
        if (observed_calls[index].flags_arg < 0) continue;
        gated[gated_count].syscall_jump = length;
        EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned)observed_calls[index].nr, 0, 0));
        EMIT(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args) + (size_t)observed_calls[index].flags_arg * sizeof(__u64)));
        EMIT(BPF_STMT(BPF_ALU | BPF_AND | BPF_K, OBS_WRITE_MASK));
        gated[gated_count].flags_jump = length;
        EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 0));
        gated_count++;
    }
    int allow_at = length;
    EMIT(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    int notify_at = length;
    EMIT(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF));

    filter[arch_jump].jf = OFFSET(arch_jump, allow_at);
#if OBS_HAS_X32
    filter[x32_jump].jt = OFFSET(x32_jump, allow_at);
#endif
    for (size_t index = 0; index < notify_count; index++) filter[notify_jumps[index]].jt = OFFSET(notify_jumps[index], notify_at);
    for (size_t index = 0; index < gated_count; index++) {
        int next = index + 1 < gated_count ? gated[index + 1].syscall_jump : allow_at;
        filter[gated[index].syscall_jump].jf = OFFSET(gated[index].syscall_jump, next);
        filter[gated[index].flags_jump].jt = OFFSET(gated[index].flags_jump, allow_at);
        filter[gated[index].flags_jump].jf = OFFSET(gated[index].flags_jump, notify_at);
    }
#undef OFFSET
#undef EMIT
    return length;
}

static int send_fd(int socket_fd, int sent_fd) {
    char marker = 'F';
    char control[CMSG_SPACE(sizeof(int))];
    memset(control, 0, sizeof(control));
    struct iovec iov = {.iov_base = &marker, .iov_len = 1};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control)};
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &sent_fd, sizeof(int));
    return sendmsg(socket_fd, &message, 0);
}

static int receive_fd(int socket_fd) {
    char marker = 0;
    char control[CMSG_SPACE(sizeof(int))];
    memset(control, 0, sizeof(control));
    struct iovec iov = {.iov_base = &marker, .iov_len = 1};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control)};
    if (recvmsg(socket_fd, &message, 0) <= 0 || marker != 'F') return -1;
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    if (!header || header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) return -1;
    int received_fd = -1;
    memcpy(&received_fd, CMSG_DATA(header), sizeof(int));
    return received_fd;
}

static int install_filter(int socket_fd) {
    struct sock_filter filter[160];
    int length = build_filter(filter, sizeof(filter) / sizeof(filter[0]));
    if (length < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return -1;
    struct sock_fprog program = {.len = (unsigned short)length, .filter = filter};
    int listener = (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
    if (listener < 0) return -1;
    if (send_fd(socket_fd, listener) < 0) {
        close(listener);
        return -2;
    }
    close(listener);
    return 0;
}

static ssize_t read_remote(pid_t pid, unsigned long address, void *destination, size_t capacity) {
    struct iovec local = {.iov_base = destination, .iov_len = capacity};
    struct iovec remote = {.iov_base = (void *)address, .iov_len = capacity};
    return process_vm_readv(pid, &local, 1, &remote, 1, 0);
}

static size_t read_remote_string(pid_t pid, unsigned long address, char *destination) {
    ssize_t count = read_remote(pid, address, destination, OBS_PATH_CAP);
    if (count <= 0) return 0;
    char *terminator = memchr(destination, '\0', (size_t)count);
    if (!terminator) return 0;
    return (size_t)(terminator - destination);
}

static size_t read_proc_link(pid_t pid, enum path_kind kind, int fd, char *destination, size_t capacity) {
    char proc_path[64];
    if (kind == PATH_CWD || (kind == PATH_DIRFD && fd == AT_FDCWD)) {
        snprintf(proc_path, sizeof(proc_path), "/proc/%d/cwd", pid);
    } else {
        snprintf(proc_path, sizeof(proc_path), "/proc/%d/fd/%d", pid, fd);
    }
    ssize_t count = readlink(proc_path, destination, capacity - 1);
    if (count <= 0 || (size_t)count >= capacity - 1) return 0;
    destination[count] = '\0';
    return (size_t)count;
}

static size_t resolve_path(const struct seccomp_notif *request, enum path_kind kind, int path_arg, int dirfd_arg, char *destination) {
    if (kind == PATH_FD) {
        return read_proc_link(request->pid, PATH_FD, (int)request->data.args[path_arg], destination, OBS_RESOLVED_CAP);
    }
    char raw[OBS_PATH_CAP];
    size_t raw_length = read_remote_string(request->pid, (unsigned long)request->data.args[path_arg], raw);
    if (raw_length == 0) return 0;
    if (raw[0] == '/') {
        if (raw_length >= OBS_RESOLVED_CAP) return 0;
        memcpy(destination, raw, raw_length + 1);
        return raw_length;
    }
    int dirfd = kind == PATH_DIRFD ? (int)request->data.args[dirfd_arg] : AT_FDCWD;
    size_t base_length = read_proc_link(request->pid, kind, dirfd, destination, OBS_RESOLVED_CAP);
    if (base_length == 0 || base_length + 1 + raw_length >= OBS_RESOLVED_CAP) return 0;
    destination[base_length] = '/';
    memcpy(destination + base_length + 1, raw, raw_length + 1);
    return base_length + 1 + raw_length;
}

static size_t json_escape(char *destination, size_t capacity, const char *source, size_t length) {
    static const char hex[] = "0123456789abcdef";
    size_t output = 0;
    for (size_t index = 0; index < length; index++) {
        unsigned char byte = (unsigned char)source[index];
        if (byte == '"' || byte == '\\') {
            if (output + 2 >= capacity) return 0;
            destination[output++] = '\\';
            destination[output++] = (char)byte;
        } else if (byte < 0x20) {
            if (output + 6 >= capacity) return 0;
            destination[output++] = '\\'; destination[output++] = 'u'; destination[output++] = '0'; destination[output++] = '0';
            destination[output++] = hex[byte >> 4]; destination[output++] = hex[byte & 15];
        } else {
            if (output + 1 >= capacity) return 0;
            destination[output++] = (char)byte;
        }
    }
    destination[output] = '\0';
    return output;
}

static void emit_event(int event_fd, const struct observed_call *call, pid_t pid, const char *path, size_t path_length) {
    if (event_fd < 0 || path_length == 0 || path_length > 4096) return;
    char escaped[OBS_LINE_CAP];
    size_t escaped_length = json_escape(escaped, sizeof(escaped), path, path_length);
    if (escaped_length == 0) return;
    char line[OBS_LINE_CAP];
    int length = snprintf(line, sizeof(line), "{\"syscall\":\"%s\",\"pid\":%d,\"path\":\"%s\"}\n", call->name, pid, escaped);
    if (length <= 0 || (size_t)length >= sizeof(line)) return;
    ssize_t ignored = write(event_fd, line, (size_t)length);
    (void)ignored;
}

static void emit_setup_error(int event_fd) {
    if (event_fd < 0) return;
    static const char record[] = "{\"error\":\"unsupported\"}\n";
    ssize_t ignored = write(event_fd, record, sizeof(record) - 1);
    (void)ignored;
}

static int same_path_sample(const char *left, size_t left_length, const char *right, size_t right_length) {
    return left_length == right_length && (left_length == 0 || memcmp(left, right, left_length) == 0);
}

static int openat2_is_write(const struct seccomp_notif *request) {
    uint64_t flags = 0;
    ssize_t count = read_remote(request->pid, (unsigned long)request->data.args[2], &flags, sizeof(flags));
    return count == (ssize_t)sizeof(flags) && ((unsigned)flags & OBS_WRITE_MASK) != 0;
}

static int service_notification(int listener, int event_fd, struct seccomp_notif *request, struct seccomp_notif_resp *response, size_t request_size, size_t response_size) {
    memset(request, 0, request_size);
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, request) < 0) return errno == EINTR || errno == ENOENT ? 0 : -1;
    const struct observed_call *call = find_call(request->data.nr);
    char first[OBS_RESOLVED_CAP];
    char second[OBS_RESOLVED_CAP];
    char first_check[OBS_RESOLVED_CAP];
    char second_check[OBS_RESOLVED_CAP];
    size_t first_length = 0;
    size_t second_length = 0;
    if (call && ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request->id) == 0) {
        if (call->flags_arg != -2 || openat2_is_write(request)) {
            first_length = resolve_path(request, call->kind, call->path_arg, call->dirfd_arg, first);
            if (call->path2_arg >= 0) second_length = resolve_path(request, call->kind2, call->path2_arg, call->dirfd2_arg, second);
            size_t first_check_length = resolve_path(request, call->kind, call->path_arg, call->dirfd_arg, first_check);
            size_t second_check_length = 0;
            if (call->path2_arg >= 0) second_check_length = resolve_path(request, call->kind2, call->path2_arg, call->dirfd2_arg, second_check);
            if (!same_path_sample(first, first_length, first_check, first_check_length)) first_length = 0;
            if (!same_path_sample(second, second_length, second_check, second_check_length)) second_length = 0;
        }
    }
    memset(response, 0, response_size);
    response->id = request->id;
    response->flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, response) < 0 && errno != ENOENT) return -1;
    if (call) {
        emit_event(event_fd, call, request->pid, first, first_length);
        emit_event(event_fd, call, request->pid, second, second_length);
    }
    return 0;
}

static int supervise(pid_t child, int listener, int event_fd) {
    struct seccomp_notif_sizes sizes;
    if (syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) < 0) {
        sizes.seccomp_notif = sizeof(struct seccomp_notif);
        sizes.seccomp_notif_resp = sizeof(struct seccomp_notif_resp);
    }
    struct seccomp_notif *request = calloc(1, sizes.seccomp_notif);
    struct seccomp_notif_resp *response = calloc(1, sizes.seccomp_notif_resp);
    if (!request || !response) {
        free(request);
        free(response);
        kill(child, SIGKILL);
        int status = 0;
        while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
        return 125;
    }
    int status = 0;
    for (;;) {
        pid_t waited = waitpid(child, &status, WNOHANG);
        if (waited == child) break;
        if (waited < 0 && errno != EINTR) {
            status = 1 << 8;
            break;
        }
        struct pollfd poll_fd = {.fd = listener, .events = POLLIN};
        int ready = poll(&poll_fd, 1, 50);
        if (ready > 0 && (poll_fd.revents & POLLIN)) {
            if (service_notification(listener, event_fd, request, response, sizes.seccomp_notif, sizes.seccomp_notif_resp) < 0) {
                kill(child, SIGKILL);
            }
        } else if (ready > 0 && (poll_fd.revents & (POLLERR | POLLHUP | POLLNVAL))) {
            kill(child, SIGKILL);
        }
    }
    free(request);
    free(response);
    return exit_like_child(status);
}

static int parse_event_fd(const char *text) {
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno || !end || *end != '\0' || value < 0 || value > INT_MAX) return -1;
    return (int)value;
}

int main(int argc, char **argv) {
    if (argc < 5 || strcmp(argv[1], "--event-fd") != 0 || strcmp(argv[3], "--") != 0) {
        fprintf(stderr, "usage: %s --event-fd FD -- COMMAND [ARG...]\n", argv[0]);
        return 64;
    }
    signal(SIGPIPE, SIG_IGN);
    int event_fd = parse_event_fd(argv[2]);
    if (event_fd >= 0) {
        int flags = fcntl(event_fd, F_GETFL);
        if (flags < 0 || fcntl(event_fd, F_SETFL, flags | O_NONBLOCK) < 0) event_fd = -1;
    }
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) < 0) {
        execvp(argv[4], &argv[4]);
        return 127;
    }
    pid_t child = fork();
    if (child < 0) return 125;
    if (child == 0) {
        close(sockets[0]);
        int installed = install_filter(sockets[1]);
        if (installed == -1) {
            emit_setup_error(event_fd);
            ssize_t ignored = write(sockets[1], "E", 1);
            (void)ignored;
        } else if (installed == -2) {
            _exit(125);
        }
        if (event_fd >= 0) close(event_fd);
        close(sockets[1]);
        execvp(argv[4], &argv[4]);
        _exit(127);
    }

    close(sockets[1]);
    workload_pid = child;
    install_signal_forwarders();
    int listener = receive_fd(sockets[0]);
    close(sockets[0]);
    int status;
    if (listener < 0) {
        while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
        return exit_like_child(status);
    }
    int exit_code = supervise(child, listener, event_fd);
    close(listener);
    return exit_code;
}
