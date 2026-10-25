"""用户选择的 DNA 文件目录；dna.json 为读取真源，其余文件供人查看。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import threading
import uuid


class LibraryError(Exception):
    pass


FORBIDDEN = re.compile(r'^(?:api_?key|writing_?key|asr_?key|parser_?token|siliconflow_?api_?key|istero_?api_?token|authorization|credentials?|secrets?|password|token)$', re.I)


def clean_data(value):
    if isinstance(value, dict):
        return {key: clean_data(item) for key, item in value.items() if not FORBIDDEN.fullmatch(key)}
    if isinstance(value, list):
        return [clean_data(item) for item in value]
    return value


def normalize_dna(data):
    if not isinstance(data, dict):
        raise LibraryError('DNA 数据格式不正确。')
    for key in ('id', 'name', 'text'):
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise LibraryError('DNA 缺少编号、名称或正文。')
    if len(data['id']) > 180 or len(data['name']) > 300:
        raise LibraryError('DNA 编号或名称过长。')
    raw = data.get('raw', [])
    if not isinstance(raw, list) or any(not isinstance(a, dict) or not isinstance(a.get('title'), str) or not isinstance(a.get('content'), str) for a in raw):
        raise LibraryError('DNA 的参考原稿格式不完整。')
    allowed = ('id', 'name', 'text', 'raw', 'results', 'expressionProfile', 'createdAt', 'updatedAt', 'authorName', 'authorKey', 'style')
    result = clean_data({k: data[k] for k in allowed if k in data})
    result.setdefault('raw', [])
    result.setdefault('results', {})
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 8 * 1024 * 1024:
        raise LibraryError('单份 DNA 超过 8 MB，请减少重复素材后再保存。')
    return result


def write_text_atomic(path, text):
    temp = path.with_name(path.name + '.new')
    temp.write_text(text, encoding='utf-8', newline='\n')
    temp.replace(path)


class DnaStore:
    def __init__(self, config):
        self.config = config
        self.lock = threading.RLock()

    def directory(self):
        if self.config.workspace is not None:
            return self.config.workspace / 'DNA'
        with self.config.lock:
            value = self.config.settings.get('dnaDirectory', '')
        return Path(value) if value else None

    def validate_directory(self, value):
        if not isinstance(value, str) or not value.strip():
            raise LibraryError('请选择一个用于保存 DNA 的本地目录。')
        path = Path(value.strip().strip('"')).expanduser()
        if not path.is_absolute():
            raise LibraryError('请填写完整绝对路径，例如 D:\\口播DNA资料；不要填写网页链接或相对路径。')
        # 保留用户选择的实际 Unicode 路径，不改成其他目录。
        try:
            path = path.resolve()
            path.mkdir(parents=True, exist_ok=True)
            actual = next((p for p in path.parent.iterdir() if p.name == path.name), None)
            if actual is None or actual.name != path.name:
                raise LibraryError('目录名称回读不一致，未保存配置。')
            probe = path / ('写入校验-' + uuid.uuid4().hex + '.tmp')
            try:
                probe.write_text('中文 DNA 目录校验', encoding='utf-8')
                if probe.read_text(encoding='utf-8') != '中文 DNA 目录校验':
                    raise LibraryError('目录 UTF-8 读写校验失败。')
            finally:
                probe.unlink(missing_ok=True)
            # 已有目录先读取验证，不删除、不覆盖其他文件。
            self._read(path)
        except OSError as exc:
            raise LibraryError(f'无法使用该目录（系统错误 {getattr(exc, "winerror", None) or exc.errno}）。请检查路径、访问权限或磁盘状态。') from None
        return path

    def configure(self, value):
        path = self.validate_directory(value)
        if self.config.workspace is not None and path != (self.config.workspace / 'DNA').resolve():
            raise LibraryError('DNA 固定保存在工作目录的 DNA 子文件夹，请通过“选择文件夹”切换整个工作目录。')
        with self.lock, self.config.lock:
            settings = dict(self.config.settings, dnaDirectory=str(path))
            write_text_atomic(self.config.path, json.dumps(settings, ensure_ascii=False, indent=2))
            self.config.settings = settings
        return self.load()

    def _read(self, directory):
        entries, locations, warnings, seen = [], {}, [], set()
        for child in sorted(directory.iterdir(), key=lambda p: p.name):
            if not child.is_dir() or child.is_symlink():
                continue
            file = child / 'dna.json'
            if not file.is_file():
                continue
            try:
                if file.stat().st_size > 8 * 1024 * 1024:
                    raise LibraryError('文件过大')
                data = json.loads(file.read_text(encoding='utf-8-sig'))
                if data.get('format') != 'spoken-dna/v1':
                    raise LibraryError('文件格式不是 spoken-dna/v1')
                dna = normalize_dna(data.get('dna'))
                if dna['id'] in seen:
                    raise LibraryError('编号与其他 DNA 重复')
                seen.add(dna['id']); entries.append(dna)
                locations[dna['id']] = str(child)
            except (ValueError, UnicodeError, OSError, LibraryError, AttributeError):
                warnings.append(child.name + ' 的 dna.json 无法读取，已保留文件并跳过，请检查格式。')
        return entries, locations, warnings

    def load(self):
        with self.lock:
            directory = self.directory()
            if directory is None:
                return {'configured': False, 'directory': '', 'workspaceDirectory': '', 'entries': [], 'locations': {}, 'warnings': []}
            if not directory.is_dir():
                raise LibraryError('已配置的 DNA 目录不存在或不可访问。请重新连接该目录；浏览器缓存不会被清空。')
            try:
                entries, locations, warnings = self._read(directory)
            except OSError:
                raise LibraryError('无法读取已配置的 DNA 目录，请检查磁盘和权限。浏览器缓存已保留。') from None
            return {'configured': True, 'directory': str(directory),
                    'workspaceDirectory': str(self.config.workspace) if self.config.workspace else '',
                    'entries': entries, 'locations': locations, 'warnings': warnings}

    def save(self, data):
        dna = normalize_dna(data)
        with self.lock:
            state = self.load()
            if not state['configured']:
                raise LibraryError('尚未配置 DNA 本地目录，请先在配置面板选择目录。')
            directory = Path(state['directory'])
            previous = state['locations'].get(dna['id'])
            if previous:
                folder = Path(previous)
            else:
                name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', dna['name']).strip(' .')[:60] or '未命名DNA'
                if name.upper().split('.')[0] in ('CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))):
                    name = '_' + name
                folder = directory / (name + '--' + hashlib.sha256(dna['id'].encode('utf-8')).hexdigest()[:12])
                if (folder / 'dna.json').exists():
                    raise LibraryError('目标文件夹已有无法识别或冲突的 DNA 文件，已保留原文件；请先检查目录。')
            if folder.is_symlink() or not folder.resolve().is_relative_to(directory.resolve()):
                raise LibraryError('DNA 文件夹指向目录外部，已停止保存。')
            try:
                folder.mkdir(exist_ok=True)
                if folder.name not in [p.name for p in directory.iterdir()]:
                    raise LibraryError('DNA 文件夹名称回读失败。')
                write_text_atomic(folder / 'Writing-DNA.md', dna['text'])
                write_text_atomic(folder / '原稿.json', json.dumps(dna['raw'], ensure_ascii=False, indent=2))
                payload = {'format': 'spoken-dna/v1', 'dna': dna}
                write_text_atomic(folder / 'dna.json', json.dumps(payload, ensure_ascii=False, indent=2))
                if json.loads((folder / 'dna.json').read_text(encoding='utf-8')) != payload:
                    raise LibraryError('DNA 文件保存后回读校验失败。')
            except OSError as exc:
                raise LibraryError(f'DNA 文件保存失败（系统错误 {getattr(exc, "winerror", None) or exc.errno}），浏览器资料仍保留。') from None
            return {'ok': True, 'dna': dna, 'directory': str(folder)}

    def open_directory(self):
        directory = self.config.workspace or self.directory()
        if directory is None or not directory.is_dir():
            raise LibraryError('请先配置并连接有效的 DNA 目录。')
        if os.name != 'nt':
            raise LibraryError('请复制页面显示的目录路径，在文件管理器中打开。')
        os.startfile(str(directory))
        return {'ok': True}
