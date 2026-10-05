"""Pre-render design diagrams locally; reading the knowledge base stays offline."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCES = [ROOT.parent / 'design/download-file-state' / (name + '.puml')
           for name in ('before', 'implemented')]


def digest(source):
    return hashlib.sha256(source.encode('utf8')).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, required=True, help='Local PlantUML JAR')
    parser.add_argument('--java', default='java', help='Java executable (can be a portable JRE)')
    parser.add_argument('--font-dir', help='Optional local font directory for a minimal WSL system')
    parser.add_argument('--font', default='Microsoft YaHei', help='Font used to measure Chinese labels')
    parser.add_argument('--dot', help='Optional Graphviz executable; otherwise use built-in Smetana')
    args = parser.parse_args()
    output = ROOT / 'assets/plantuml'
    output.mkdir(parents=True, exist_ok=True)
    entries = []
    pending = []
    for path in SOURCES:
        source = path.read_text(encoding='utf8')
        command = [args.java, '-Djava.awt.headless=true']
        if args.font_dir:
            command.append('-Dsun.java2d.fontpath=' + args.font_dir)
        command += ['-jar', str(args.jar.resolve()), '-charset', 'UTF-8']
        command += ['-graphvizdot', args.dot] if args.dot else ['-Playout=smetana']
        command += ['-SdefaultFontName=' + args.font, '-tsvg', '-pipe']
        result = subprocess.run(command, input=source.encode('utf8'), capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr.decode('utf8', errors='replace'))
        svg = result.stdout.decode('utf8')
        tree = ET.fromstring(svg)
        labels = ''.join(tree.itertext())
        if tree.tag != '{http://www.w3.org/2000/svg}svg' or 'Syntax Error' in labels:
            raise ValueError('PlantUML rendering failed: ' + str(path))
        if not all(label in labels for label in
                   (('NONE', 'DONE', 'SAVING') if path.stem == 'before'
                    else ('AVAILABLE', 'MISSING', 'UNAVAILABLE'))):
            raise ValueError('Expected state labels missing: ' + str(path))
        target = output / (path.stem + '.svg')
        pending.append((target, svg))
        entries.append({'source': '../design/download-file-state/' + path.name,
                        'svg': target.relative_to(ROOT).as_posix(),
                        'sourceSha256': digest(source), 'svgSha256': digest(svg)})
    # Publish only after both diagrams have been rendered and checked.
    for target, svg in pending:
        target.write_text(svg, encoding='utf8')
    (output / 'manifest.json').write_text(json.dumps(entries, ensure_ascii=False, indent=2) + '\n',
                                         encoding='utf8')
    print('Rendered', len(entries), 'PlantUML diagrams to local SVG')


if __name__ == '__main__':
    main()
