#!/usr/bin/python3
"""Own one remote Codex cgroup; provide a bounded, identity-checked stop."""
import fcntl
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def process(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
        fields = raw[raw.rindex(')') + 2:].split()
        return {'pid': int(pid), 'state': fields[0], 'pgid': int(fields[2]), 'start': fields[19]}
    except (FileNotFoundError, ProcessLookupError):
        return None


def save(file, data):
    tmp = file.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.chmod(0o600)
    tmp.replace(file)


def unit_group(unit):
    result = subprocess.run(['systemctl', '--user', 'show', unit, '-p', 'ControlGroup', '--value'], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        raise RuntimeError('Remote systemd state unavailable')
    return result.stdout.strip()


def live_members(group):
    if not group or not group.startswith('/') or '..' in group.split('/'):
        return []
    directory = Path('/sys/fs/cgroup' + group)
    if not directory.exists():
        return []
    pids = set()
    for file in directory.rglob('cgroup.procs'):
        try:
            pids.update(int(p) for p in file.read_text().split())
        except FileNotFoundError:
            pass
    return [pid for pid in pids if (p := process(pid)) and p['state'] != 'Z']


def stop(file):
    end = time.monotonic() + 12
    while True:
        data = json.loads(file.read_text())
        if data['status'] != 'starting':
            break
        owner = data.get('wrapper', {})
        current_owner = process(owner.get('pid', 0))
        if owner and (not current_owner or current_owner['start'] != owner['start']):
            group = unit_group(data['unit'])
            if group:
                data = {**data, 'cgroup': group}
                break
        if time.monotonic() >= end:
            raise RuntimeError('Remote launch outcome unknown')
        time.sleep(0.1)
    expected = 'paperclip-ssh-' + data['runId'] + '.scope'
    if data['unit'] != expected:
        raise RuntimeError('Remote scope identity mismatch')
    group = data.get('cgroup')
    if group and expected not in group.split('/'):
        raise RuntimeError('Remote cgroup mismatch')
    current = unit_group(expected)
    if current and current != group:
        raise RuntimeError('Remote scope changed')
    for sig, seconds in [('SIGTERM', 5), ('SIGKILL', 3)]:
        if not live_members(group):
            break
        subprocess.run(['systemctl', '--user', 'kill', '--kill-who=all', '--signal=' + sig, expected], capture_output=True, timeout=5)
        end = time.monotonic() + seconds
        while time.monotonic() < end and live_members(group):
            time.sleep(0.1)
    if live_members(group):
        raise RuntimeError('Remote scope still active')
    return {'stopped': True, 'runId': data['runId'], 'unit': expected, 'cgroup': group}


def record_lock(file):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(file.with_suffix('.lock'), 'a')
    end = time.monotonic() + 15
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            if time.monotonic() >= end:
                lock.close()
                raise RuntimeError('Remote launch lock busy')
            time.sleep(0.05)


def main():
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == '--stop-record':
        file = Path(sys.argv[2])
        base = Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/state/paperclip-ssh'
        if base not in file.parents or file.resolve() != file or not re.fullmatch(r'[a-zA-Z0-9_-]+', file.stem):
            raise RuntimeError('Unsafe control path')
        with record_lock(file):
            if not file.exists():
                unit = 'paperclip-ssh-' + file.stem + '.scope'
                group = unit_group(unit)
                if live_members(group):
                    raise RuntimeError('Unowned remote scope remains active')
                # Fence a cancelled launch: later dispatch with this run id must fail.
                save(file, {'runId': file.stem, 'unit': unit, 'cgroup': group, 'status': 'stopped', 'neverLaunched': True})
        if file.is_symlink() or file.stat().st_uid != os.getuid() or file.stat().st_mode & 0o077:
            raise RuntimeError('Unsafe control record')
        print(json.dumps(stop(file)))
        return
    run_id = os.environ.get('PAPERCLIP_RUN_ID', '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', run_id):
        raise RuntimeError('Paperclip run identity required')
    home = Path(os.environ['CODEX_HOME'])
    base = Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/state/paperclip-ssh'
    if base not in home.parents or home.resolve() != home:
        raise RuntimeError('Expected isolated Paperclip Codex home')
    controls = home.parent / 'processes'
    controls.mkdir(parents=True, exist_ok=True, mode=0o700)
    locks = base / 'workspace-locks'
    locks.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(locks / hashlib.sha256(os.getcwd().encode()).hexdigest(), 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    file = controls / f'{run_id}.json'
    launch_lock = record_lock(file)
    if file.exists():
        raise RuntimeError('Run identity already dispatched; never replay')
    unit = 'paperclip-ssh-' + run_id + '.scope'
    startup_signals = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    signal.pthread_sigmask(signal.SIG_BLOCK, startup_signals)
    save(file, {'runId': run_id, 'unit': unit, 'cwd': os.getcwd(), 'status': 'starting', 'wrapper': process(os.getpid())})
    child = subprocess.Popen(['systemd-run', '--user', '--scope', '--quiet', '--unit=' + unit,
                              os.environ.get('PAPERCLIP_SSH_CODEX_PATH', str(Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/codex')), *sys.argv[1:]], start_new_session=True, pass_fds=(lock.fileno(),),
                             preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_UNBLOCK, startup_signals))
    deadline = time.monotonic() + 12
    group = ''
    while child.poll() is None and not group and time.monotonic() < deadline:
        group = unit_group(unit)
        if not group: time.sleep(0.05)
    if not group and child.poll() is None:
        raise RuntimeError('Remote scope creation unverified')
    save(file, {'runId': run_id, 'unit': unit, 'cgroup': group, 'cwd': os.getcwd(), 'status': 'running'})
    launch_lock.close()
    def interrupt(signum, frame):
        stop(file)
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGHUP, interrupt)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, startup_signals)
    code = child.wait()
    receipt = stop(file)
    save(file, {**json.loads(file.read_text()), **receipt, 'status': 'stopped', 'exitCode': code})
    raise SystemExit(code if code >= 0 else 128 - code)


if __name__ == '__main__':
    main()
