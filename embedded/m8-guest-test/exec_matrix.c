/*
 * M8 guest exec matrix — every exec variant, one ptrace-caught execve each.
 * (embedded/EXEC-DESIGN.md §9.2; compile and run INSIDE the guest:
 *     cc -O2 -o /tmp/exec_matrix exec_matrix.c && /tmp/exec_matrix )
 *
 * Each variant execs /bin/echo to print "<variant> OK". The exec syscall is
 * issued through glibc symbols AND raw syscall(2) — the case termux-exec
 * explicitly cannot cover and proot can (it intercepts the syscall, not the
 * libc symbol; EXEC-DESIGN.md §2.2/§7 M4). posix_spawn rides glibc's
 * clone(CLONE_VM|CLONE_VFORK) + execve, covered by proot's TRACEVFORK.
 *
 * Deliberately does NOT use /proc/self/exe to re-exec itself: inside the
 * guest that path shows the loader's HOST path (§5 known limit).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int failures = 0;

static void report_status(const char *name, int status) {
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0)
        return; /* child's echo line already printed "<name> OK" */
    printf("%s: FAIL (raw status %d)\n", name, status);
    failures++;
}

static void run_forked(const char *name, void (*variant)(void)) {
    pid_t pid = fork();
    if (pid == 0) {
        variant(); /* only returns on failure */
        fprintf(stderr, "%s: %s\n", name, strerror(errno));
        _exit(99);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    report_status(name, status);
}

static void v_execve(void) {
    char *const argv[] = {"echo", "execve OK", NULL};
    char *const envp[] = {"PATH=/usr/local/bin:/usr/bin:/bin", NULL};
    execve("/bin/echo", argv, envp);
}

static void v_execv(void) {
    char *const argv[] = {"echo", "execv OK", NULL};
    execv("/bin/echo", argv);
}

static void v_execvp(void) {
    /* PATH lookup inside the guest resolves /usr/bin/echo */
    char *const argv[] = {"echo", "execvp OK", NULL};
    execvp("echo", argv);
}

static void v_execl(void) {
    execl("/bin/echo", "echo", "execl OK", (char *)NULL);
}

static void v_execlp(void) {
    execlp("echo", "echo", "execlp OK", (char *)NULL);
}

static void v_raw_syscall_execve(void) {
    /* termux-exec's documented blind spot (technical/index.md:37): a binary
     * calling the execve syscall directly. proot still catches it — the
     * syscall itself is what's ptrace-intercepted. */
    char *const argv[] = {"echo", "raw-syscall-execve OK", NULL};
    syscall(SYS_execve, "/bin/echo", argv, environ);
}

static void run_posix_spawn(void) {
    pid_t pid = 0;
    char *const argv[] = {"echo", "posix_spawn OK", NULL};
    if (posix_spawn(&pid, "/bin/echo", NULL, NULL, argv, environ) != 0) {
        printf("posix_spawn: FAIL (%s)\n", strerror(errno));
        failures++;
        return;
    }
    int status = 0;
    waitpid(pid, &status, 0);
    report_status("posix_spawn", status);
}

int main(void) {
    run_forked("execve", v_execve);
    run_forked("execv", v_execv);
    run_forked("execvp", v_execvp);
    run_forked("execl", v_execl);
    run_forked("execlp", v_execlp);
    run_posix_spawn();
    run_forked("raw-syscall-execve", v_raw_syscall_execve);

    if (failures == 0) {
        printf("exec-matrix all-variants OK\n");
        return 0;
    }
    printf("exec-matrix: %d variant(s) FAILED\n", failures);
    return 1;
}
