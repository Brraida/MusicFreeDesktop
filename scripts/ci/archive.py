import sys
import zipfile
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
if not source.is_dir() or destination.exists():
    raise RuntimeError('Expected an application directory and a new ZIP path')
# Include .webpack and all resources; do not use archivers that omit dotfiles.
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    archive.write(source, source.name)
    for file in sorted(source.rglob('*')):
        if file.is_file() or file.is_dir():
            archive.write(file, file.relative_to(source.parent))
with zipfile.ZipFile(destination) as archive:
    bad_file = archive.testzip()
    if bad_file:
        raise RuntimeError('Corrupt ZIP entry: ' + bad_file)
