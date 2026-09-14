"""Render at most 10 pages into a new image-only PDF; never copy source objects."""
import argparse, hashlib, json, io
from pathlib import Path
import pymupdf as fitz
import pypdfium2 as pdfium

def prepare(manifest_path, originals, output):
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for index, report in enumerate(manifest['reports']):
        source = originals / (report['sha256'] + '.pdf')
        assert hashlib.sha256(source.read_bytes()).hexdigest() == report['sha256']
        with pdfium.PdfDocument(source) as original, fitz.open() as preview:
            assert len(original) == report['pages']
            for page_index in range(min(10, len(original))):
                page = original[page_index]
                rendered = page.render(scale=2, draw_annots=False)
                image = rendered.to_pil().convert('RGB')
                buffer = io.BytesIO()
                image.save(buffer, format='JPEG', quality=85)
                width, height = page.get_size()
                dest = preview.new_page(width=width, height=height)
                dest.insert_image(dest.rect, stream=buffer.getvalue())
                rendered.close()
                page.close()
            data = preview.tobytes(garbage=4, deflate=True)
        sha = hashlib.sha256(data).hexdigest()
        path = output / (sha + '.pdf')
        path.write_bytes(data)
        with fitz.open(path) as check:
            assert check.page_count == min(10, report['pages'])
            assert check.embfile_count() == 0
            assert all(not p.get_text().strip() and not p.get_links() for p in check)
        rows.append({'originalSha256': report['sha256'], 'sha256': sha, 'bytes': len(data), 'pages': min(10, report['pages'])})
        print(json.dumps({'prepared': index + 1, 'total': len(manifest['reports'])}), flush=True)
    result = {'version': 1, 'previewLimit': 10, 'reports': rows}
    (output.parent / 'preview-manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    parser.add_argument('originals', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    prepare(args.manifest, args.originals, args.output)
