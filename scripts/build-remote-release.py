"""Create a private deployment bundle from committed, allowlisted files only."""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import uuid

root = Path(__file__).resolve().parent.parent
def git(*args):
    return subprocess.check_output(['git', '-C', str(root), *args])

revision = git('rev-parse', 'HEAD').decode().strip()
tracked = git('ls-tree', '-r', '--name-only', revision).decode().splitlines()
files = [name for name in tracked if re.fullmatch(r'server/[a-z0-9-]+\.mjs', name)
         or name == 'scripts/backup.mjs']
templates = ['compose.yaml', 'nginx-api.inc', 'remote.example.json']
if 'server/remote-index.mjs' not in files:
    raise SystemExit('Commit the remote entry before packaging')
output = root / 'work' / 'remote-release' / (revision[:12] + '-' + uuid.uuid4().hex[:8])
output.mkdir(parents=True)
manifest = {'revision': revision, 'files': []}
archive_path = output / 'backend.tar.gz'
with tarfile.open(archive_path, 'w:gz') as archive:
    for name in files:
        content = git('show', f'{revision}:{name}')
        info = tarfile.TarInfo(name)
        info.size, info.mode, info.mtime = len(content), 0o644, 0
        archive.addfile(info, io.BytesIO(content))
        manifest['files'].append({'path': name, 'sha256': hashlib.sha256(content).hexdigest()})
manifest['archiveSha256'] = hashlib.sha256(archive_path.read_bytes()).hexdigest()
for name in templates:
    content = git('show', f'{revision}:deployment/remote-trial/{name}')
    (output / name).write_bytes(content)
    manifest['files'].append({'path': name, 'sha256': hashlib.sha256(content).hexdigest()})
(output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'directory': str(output), 'revision': revision, 'fileCount': len(manifest['files'])}, ensure_ascii=False))
