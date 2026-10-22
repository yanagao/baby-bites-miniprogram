"""Validate project files and generated TDesign dependencies without reading node_modules."""
from pathlib import Path
import json
import os
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
errors = []
excluded = {'node_modules', '.git', 'output', '__pycache__'}


def project_files():
    for directory, folders, files in os.walk(root):
        folders[:] = sorted(folder for folder in folders if folder not in excluded)
        for name in sorted(files):
            if name != 'project.private.config.json':
                yield Path(directory) / name


files = list(project_files())
for file in files:
    if file.suffix == '.json':
        try:
            json.loads(file.read_text())
        except Exception as error:
            errors.append(f'{file.relative_to(root)}: {error}')

try:
    app = json.loads((root / 'app.json').read_text())
except Exception as error:
    print(f'app.json: {error}')
    sys.exit(1)

pages = list(app.get('pages', []))
for package in app.get('subPackages', app.get('subpackages', [])):
    pages.extend(f"{package['root']}/{page}" for page in package.get('pages', []))
for page in pages:
    for extension in ['.js', '.json', '.wxml', '.wxss']:
        if not (root / (page + extension)).is_file():
            errors.append(f'Missing page {page + extension}')

# Use the builder's identical resolver for npm bare imports, root paths and assets.
dependency_check = subprocess.run(['node', 'scripts/build-tdesign.cjs', '--check'], cwd=root, capture_output=True, text=True)
if dependency_check.returncode:
    errors.append(dependency_check.stderr.strip() or dependency_check.stdout.strip())

# Parse all files in one process without executing code. SourceTextModule accepts
# both the project's CommonJS syntax and the ES modules published by TDesign.
js_files = [str(file.relative_to(root)) for file in files if file.suffix in {'.js', '.cjs', '.wxs'}]
parse_script = r"""
const fs = require('node:fs'), vm = require('node:vm');
const files = JSON.parse(fs.readFileSync(0, 'utf8'));
let failures = 0;
for (const file of files) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.js')) new vm.SourceTextModule(source, { identifier: file });
    else new vm.Script(source, { filename: file });
  } catch (error) { console.error(`${file}: ${error.message}`); failures++; }
}
process.exitCode = failures ? 1 : 0;
"""
js_check = subprocess.run(['node', '--no-warnings', '--experimental-vm-modules', '-e', parse_script],
                          input=json.dumps(js_files), cwd=root, capture_output=True, text=True)
if js_check.returncode:
    errors.append(js_check.stderr.strip())

compiler_candidates = [
    Path(os.environ['WECHAT_COMPILER_DIR']) if os.environ.get('WECHAT_COMPILER_DIR') else None,
    Path('/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec'),
    Path('/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc-exec'),
]
compiler = next((directory for directory in compiler_candidates if directory and
                 (directory / 'wcc').is_file() and (directory / 'wcsc').is_file()), None)
compiled = False
if compiler:
    compiled = True
    # Pass every imported template/style in each batch, avoiding hundreds of
    # native compiler startups for generated component files.
    for extension, executable in [('.wxml', 'wcc'), ('.wxss', 'wcsc')]:
        extensions = {'.wxml', '.wxs'} if extension == '.wxml' else {'.wxss'}
        inputs = [str(file.relative_to(root)) for file in files if file.suffix in extensions]
        if not inputs:
            continue
        result = subprocess.run([str(compiler / executable), *inputs], cwd=root, capture_output=True, text=True)
        if result.returncode:
            errors.append(f'{executable}: {result.stderr.strip() or result.stdout[-5000:]}')

tab_bar = app.get('tabBar', {})
if tab_bar.get('custom'):
    for extension in ['.js', '.json', '.wxml', '.wxss']:
        if not (root / ('custom-tab-bar/index' + extension)).is_file():
            errors.append(f'Missing custom-tab-bar/index{extension}')
for item in tab_bar.get('list', []):
    for key in ['iconPath', 'selectedIconPath']:
        if key not in item:
            continue
        file = root / item[key].lstrip('/')
        if not file.is_file():
            errors.append(f'Missing tab icon: {file.relative_to(root)}')
        elif file.stat().st_size > 40 * 1024:
            errors.append(f'Tab icon exceeds 40 KB: {file.relative_to(root)}')

if errors:
    print('\n'.join(errors))
    sys.exit(1)
print(f'PASS: {len(pages)} pages, JSON, {len(js_files)} JS/WXS scripts, component/import/asset dependencies, tab icons'
      + ('; native WXML/WXSS batch compilation passed' if compiled else '; native compiler unavailable (not a compilation pass)'))
