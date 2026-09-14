"""Run committed backend tests in an isolated, disposable container on an authorized host.

Requires local paramiko. Password is prompted without echo; never saved or passed in argv.
No image pulls, published ports, existing container changes, or nginx mutations.
"""
import argparse
import base64
import datetime
import getpass
import hashlib
import io
import json
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import time
import uuid

import paramiko


ROOT = Path(__file__).resolve().parent.parent


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def make_bundle(output):
    revision = git('rev-parse', 'HEAD').decode().strip()
    paths = git('ls-tree', '-r', '--name-only', revision).decode().splitlines()
    paths = [p for p in paths if re.fullmatch(r'server/[a-z0-9-]+\.mjs', p)
             or re.fullmatch(r'tests/server/[a-z0-9-]+\.test\.mjs', p)
             or p in ['scripts/backup.mjs','scripts/import-reports.mjs']]
    if 'server/app.mjs' not in paths or 'scripts/backup.mjs' not in paths:
        raise RuntimeError('Committed backend files missing')
    with tarfile.open(output, 'w:gz') as archive:
        for name in paths:
            data = git('show', f'{revision}:{name}')
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            archive.addfile(info, io.BytesIO(data))
    return {'revision': revision, 'files': paths,
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}


class PinnedHost(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected):
        self.expected = expected.removeprefix('SHA256:').rstrip('=')

    def missing_host_key(self, client, hostname, key):
        actual = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
        if actual != self.expected:
            raise RuntimeError('SSH host key differs from the supplied fingerprint')


def run(client, command, timeout=30):
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    channel = stdout.channel
    out, err = bytearray(), bytearray()
    deadline = time.monotonic() + timeout
    while True:
        while channel.recv_ready():
            out.extend(channel.recv(65536))
        while channel.recv_stderr_ready():
            err.extend(channel.recv_stderr(65536))
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            break
        if time.monotonic() > deadline:
            channel.close()
            raise TimeoutError('Remote command timed out; see cleanup results')
        time.sleep(0.05)
    result = {'exit': channel.recv_exit_status(), 'stdout': out.decode('utf-8', 'replace'),
              'stderr': err.decode('utf-8', 'replace')}
    if result['exit']:
        raise RuntimeError(json.dumps(result, ensure_ascii=False))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--user', default='root')
    parser.add_argument('--host-key-sha256', required=True)
    parser.add_argument('--image', default='node:22-bookworm-slim')
    parser.add_argument('--bundle-only', action='store_true')
    args = parser.parse_args()
    directory = ROOT / 'work' / 'server-audit' / ('preflight-' + uuid.uuid4().hex)
    directory.mkdir(parents=True)
    bundle = directory / 'source.tar.gz'
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'bundle': make_bundle(bundle), 'publicPorts': False}
    if args.bundle_only:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(PinnedHost(args.host_key_sha256))
    password = getpass.getpass('SSH password (not saved): ')
    remote = None
    container = 'hejun-club-preflight-' + uuid.uuid4().hex
    checksums = 'sha256sum /usr/local/nginx/conf/nginx.conf /usr/local/nginx/cert.d/preview.conf'
    try:
        client.connect(args.host, username=args.user, password=password, look_for_keys=False,
                       allow_agent=False, timeout=15, auth_timeout=15, banner_timeout=15)
        password = None
        report['nginxBefore'] = run(client, checksums)['stdout']
        report['containersBefore'] = run(client, "docker ps --format '{{.ID}} {{.Names}} {{.Status}}'")['stdout']
        # Inspect and run the immutable cached image ID, never silently pull or change a tag.
        image = run(client, 'docker image inspect --format ' + shlex.quote('{{.Id}}') + ' ' + shlex.quote(args.image))['stdout'].strip()
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
            raise RuntimeError('Invalid cached image ID')
        report['imageId'] = image
        remote = run(client, 'mktemp -d /tmp/hejun-club-preflight.XXXXXXXX')['stdout'].strip()
        if not re.fullmatch(r'/tmp/hejun-club-preflight\.[A-Za-z0-9]{8}', remote):
            remote = None
            raise RuntimeError('Unexpected temporary directory; refusing writes')
        with client.open_sftp() as sftp:
            sftp.put(str(bundle), remote + '/source.tar.gz')
        actual = run(client, 'sha256sum ' + shlex.quote(remote + '/source.tar.gz'))['stdout'].split()[0]
        if actual != report['bundle']['sha256']:
            raise RuntimeError('Transferred bundle checksum differs')
        extract = ("import tarfile,pathlib; p=pathlib.Path(" + repr(remote) + "); "
                   "(p/'src').mkdir(mode=0o755); "
                   "tarfile.open(p/'source.tar.gz').extractall(p/'src',filter='data')")
        run(client, 'python3 -c ' + shlex.quote(extract))
        prefix = ['docker', 'run', '--rm', '--pull=never', '--name', container,
                  '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL',
                  '--security-opt=no-new-privileges', '--memory=512m', '--cpus=0.5', '--pids-limit=128',
                  '--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777', '--mount',
                  f'type=bind,source={remote}/src,target=/app,readonly', '--workdir=/app', image]
        report['nodeVersion'] = run(client, shlex.join(prefix + ['node', '--version']))['stdout'].strip()
        tests = [p for p in report['bundle']['files'] if p.startswith('tests/server/')]
        print('Running isolated Linux backend tests...', flush=True)
        report['tests'] = run(client, shlex.join(prefix + ['node', '--test', '--test-concurrency=1', *tests]), timeout=120)
        print(report['tests']['stdout'], flush=True)
        report['nginxAfter'] = run(client, checksums)['stdout']
        report['containersAfter'] = run(client, "docker ps --format '{{.ID}} {{.Names}} {{.Status}}'")['stdout']
        if report['nginxBefore'] != report['nginxAfter']:
            raise RuntimeError('Shared nginx configuration changed during inspection; investigate before deploying')
        report['status'] = 'passed'
    except Exception as error:
        report['status'], report['error'] = 'failed', str(error)
        raise
    finally:
        if remote:
            try:
                # Only the unique container and verified directory created by this run are eligible.
                cleanup = 'docker rm -f ' + shlex.quote(container) + ' >/dev/null 2>&1 || true\n'
                cleanup += 'rm -rf -- ' + shlex.quote(remote) + '\ntest ! -e ' + shlex.quote(remote)
                cleanup += '\n! docker container inspect ' + shlex.quote(container) + ' >/dev/null 2>&1'
                report['cleanup'] = run(client, cleanup)
            except Exception as error:
                report['cleanup'] = {'error': str(error), 'directory': remote, 'container': container}
                report['status'] = 'failed'
        client.close()
        (directory / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('Evidence:', directory / 'result.json', flush=True)
    if report['status'] != 'passed':
        raise RuntimeError('Preflight or cleanup failed; inspect the evidence')


if __name__ == '__main__':
    main()
