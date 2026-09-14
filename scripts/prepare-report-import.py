"""Validate a report ZIP and stage immutable PDF originals; never execute document content."""
import argparse, hashlib, json, re, stat, zipfile
from pathlib import Path, PurePosixPath
from pypdf import PdfReader

parser=argparse.ArgumentParser();parser.add_argument('archive');parser.add_argument('--output',default='work/report-import');args=parser.parse_args()
output=Path(args.output).resolve();files=output/'files';files.mkdir(parents=True,exist_ok=True)
reports=[];seen={}
with zipfile.ZipFile(args.archive) as archive:
    entries=[i for i in archive.infolist() if not i.is_dir()]
    if len(entries)>1000 or sum(i.file_size for i in entries)>3_000_000_000:raise ValueError('Archive exceeds import limit')
    for info in entries:
        name=info.filename.replace('\\','/');path=PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or ':' in name or stat.S_ISLNK(info.external_attr>>16):raise ValueError('Unsafe archive entry')
        if path.suffix.lower()!='.pdf' or info.flag_bits&1 or info.file_size>256_000_000:raise ValueError('Only unencrypted PDF entries up to 256 MB are supported')
        title=path.stem.strip()
        if not title or len(title)>80:raise ValueError('Title needs manual review: '+title)
        temporary=files/'incoming.pdf';digest=hashlib.sha256();size=0
        with archive.open(info) as source,temporary.open('wb') as target:
            while chunk:=source.read(1024*1024):target.write(chunk);digest.update(chunk);size+=len(chunk)
        if size!=info.file_size:raise ValueError('Size mismatch')
        sha=digest.hexdigest();target=files/(sha+'.pdf')
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest()!=sha:raise ValueError('Existing object mismatch')
            temporary.unlink()
        else:temporary.rename(target)
        reader=PdfReader(target)
        if reader.is_encrypted:raise ValueError('Encrypted PDF: '+title)
        pages=len(reader.pages)
        if pages<1:raise ValueError('Empty PDF: '+title)
        row={'title':title,'filename':path.name,'sha256':sha,'bytes':size,'pages':pages,'source':'业务方提供的行业研究报告压缩包'}
        if sha in seen:row['duplicateOf']=seen[sha]
        else:seen[sha]=title
        reports.append(row)
manifest={'version':1,'archiveName':Path(args.archive).name,'count':len(reports),'uniqueCount':len(seen),'totalBytes':sum(r['bytes'] for r in reports),'reports':reports}
(output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in manifest.items() if k!='reports'},ensure_ascii=False))
