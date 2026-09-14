"""First deployment to the authorized shared host, confined to this project's paths.

Build the web app and commit backend sources first. SSH credentials are prompted,
not stored. Existing shared nginx files and existing containers are never changed.
"""
import datetime
import getpass
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import time
import paramiko

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('preflight', ROOT/'scripts/server-preflight.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
HOST = os.environ['CLUB_SSH_HOST']
FINGERPRINT = os.environ['CLUB_SSH_HOST_KEY_SHA256']
PROJECT = '/data/hejun-club-web'
INC = '/data/hejun-club-trial/nginx-api.inc'
INCLUDE = '\n# Independently hosted business experience.\ninclude /data/hejun-club-web/nginx-web.inc;\n'
PEERS = ['/hejun-club-trial/api/health']
WORK = ROOT/'work/web-experience'
WORK.mkdir(parents=True, exist_ok=True)


def main():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip()
    bundle = WORK/'release.tar.gz'
    files = []
    with tarfile.open(bundle, 'w:gz') as archive:
        paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], cwd=ROOT).decode().splitlines()
        for path in paths:
            if not (re.fullmatch(r'server/[a-z0-9-]+\.mjs', path) or path in ['scripts/backup.mjs','scripts/import-reports.mjs']):
                continue
            data = subprocess.check_output(['git', 'show', 'HEAD:'+path], cwd=ROOT)
            info = tarfile.TarInfo('backend/'+path)
            info.size, info.mode = len(data), 0o644
            archive.addfile(info, io.BytesIO(data))
            files.append(info.name)
        site = ROOT/'work/deploy/cabc-club-app'
        assert (site/'index.html').is_file(), 'Build web experience first'
        for path in sorted(site.rglob('*')):
            assert not path.is_symlink(), 'No symlinks in public build'
            if path.is_file():
                relative = path.relative_to(site).as_posix()
                assert not any(part.startswith('.') for part in path.relative_to(site).parts)
                name = 'web/'+relative
                archive.add(path, arcname=name, recursive=False)
                files.append(name)
    report = {'at': stamp, 'revision': revision, 'bundleSha256': hashlib.sha256(bundle.read_bytes()).hexdigest(), 'files': files}
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(helper.PinnedHost(FINGERPRINT))
    password = getpass.getpass('SSH password (not saved): ')
    client.connect(HOST, username='root', password=password, look_for_keys=False, allow_agent=False, timeout=12, auth_timeout=12)
    password = None
    sftp = client.open_sftp()
    def run(command, timeout=45):
        return helper.run(client, command, timeout)['stdout']
    def read(path):
        with sftp.open(path, 'rb') as stream:
            return stream.read()
    def write(path, data, mode=0o644):
        with sftp.open(path, 'wb') as stream:
            stream.write(data)
        sftp.chmod(path, mode)
    def peers():
        result = {}
        for path in PEERS:
            code = "import subprocess,hashlib,json; v=subprocess.check_output(['curl','--noproxy','*','--resolve','example.com:443:127.0.0.1','-sS','--max-time','15','-w','\\n%{http_code}',"+repr('https://example.com'+path)+"]); body,status=v.rsplit(b'\\n',1); print(json.dumps({'status':int(status),'sha256':hashlib.sha256(body).hexdigest()}))"
            result[path] = json.loads(run('python3 -c '+shlex.quote(code)))
        return result
    shared_cmd = 'sha256sum /usr/local/nginx/conf/nginx.conf /usr/local/nginx/cert.d/preview.conf'
    containers_cmd = "docker ps --format '{{.ID}} {{.Names}}'"
    original = None
    replacement = None
    routed = False
    try:
        run('test ! -e '+PROJECT+' && test ! -L '+PROJECT+' && test ! -e /usr/local/nginx/html/hejun-club && test ! -L /usr/local/nginx/html/hejun-club')
        assert not run("ss -H -lnt 'sport = :5211'").strip(), 'Port 5211 already used'
        report['containersBefore'] = run(containers_cmd)
        assert 'hejun-club-web-api' not in report['containersBefore']
        report['sharedBefore'] = run(shared_cmd)
        report['peersBefore'] = peers()
        assert all(v['status'] == 200 for v in report['peersBefore'].values())
        original = read(INC)
        assert b'/hejun-club/' not in original and b'/data/hejun-club-web/' not in original
        image = run("docker inspect --format '{{.Image}}' hejun-club-trial-api").strip()
        assert re.fullmatch(r'sha256:[a-f0-9]{64}', image)
        release = PROJECT+'/releases/'+stamp
        report['release'] = release
        run('mkdir -p '+release+' '+PROJECT+'/state '+PROJECT+'/backups')
        run('chmod 700 '+PROJECT+'/state '+PROJECT+'/backups && chown 1000:1000 '+PROJECT+'/state '+PROJECT+'/backups')
        sftp.put(str(bundle), release+'/release.tar.gz')
        assert run('sha256sum '+release+'/release.tar.gz').split()[0] == report['bundleSha256']
        run('tar -xzf '+release+'/release.tar.gz -C '+release+' && ln -s '+release+' '+PROJECT+'/release')
        write(PROJECT+'/compose.yaml', (ROOT/'deployment/web-experience/compose.yaml').read_bytes())
        write(PROJECT+'/.env', ('CLUB_NODE_IMAGE='+image+'\n').encode(), 0o600)
        write(PROJECT+'/nginx-web.inc', (ROOT/'deployment/web-experience/nginx-web.inc').read_bytes())
        run('docker compose --project-directory '+PROJECT+' -f '+PROJECT+'/compose.yaml config --quiet')
        run('docker compose --project-directory '+PROJECT+' -f '+PROJECT+'/compose.yaml up -d --pull never', 60)
        for _ in range(20):
            try:
                health = json.loads(run("curl --noproxy '*' -fsS --max-time 3 -H 'Host: example.com' -H 'X-Real-IP: 127.0.0.1' -H 'X-Forwarded-Proto: https' http://127.0.0.1:5211/api/health"))
                assert health['mode'] == 'web-trial' and health['paymentReady'] is False
                report['health'] = health
                break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('New service did not become healthy; no nginx route changed')
        # Only the generated administrator file is downloaded; never print its contents.
        (WORK/'server-admin.txt').write_bytes(read(PROJECT+'/state/admin.txt'))
        run('ln -s '+release+'/web /usr/local/nginx/html/hejun-club')
        write(release+'/nginx-api.inc.before', original)
        assert read(INC) == original, 'Project nginx include changed concurrently'
        replacement = original+INCLUDE.encode()
        write(INC, replacement)
        test = helper.run(client, '/usr/local/nginx/sbin/nginx -t')
        report['nginxTest'] = test['stderr']
        run('/usr/local/nginx/sbin/nginx -s reload')
        routed = True
        time.sleep(1)
        report['peersAfter'] = peers()
        report['sharedAfter'] = run(shared_cmd)
        report['containersAfter'] = run(containers_cmd)
        assert report['sharedBefore'] == report['sharedAfter'], 'Shared configuration changed'
        assert set(report['containersBefore'].splitlines()) <= set(report['containersAfter'].splitlines()), 'Existing container changed'
        assert report['peersBefore'] == report['peersAfter'], 'Existing entry response changed'
        report['publicHealth'] = json.loads(run("curl --noproxy '*' --resolve example.com:443:127.0.0.1 -fsS https://example.com/hejun-club/api/health"))
        report['success'] = True
        print(json.dumps({'success': True, 'url': 'https://example.com/hejun-club/', 'release': release, 'peersUnchanged': True}, ensure_ascii=False))
    except Exception as error:
        report['success'] = False
        report['error'] = str(error)
        if replacement and read(INC) == replacement:
            write(INC, original)
            run('/usr/local/nginx/sbin/nginx -t')
            if routed:
                run('/usr/local/nginx/sbin/nginx -s reload')
            report['routeRolledBack'] = True
        raise
    finally:
        (WORK/'deploy.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        sftp.close()
        client.close()


if __name__ == '__main__':
    main()
