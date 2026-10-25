"""口播 DNA 本地服务。Python 标准库 + 本机 FFmpeg，无第三方运行依赖。"""
from __future__ import annotations

import argparse
import concurrent.futures
import ctypes
from email.utils import parsedate_to_datetime
import ipaddress
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error, parse, request
import uuid
from dna_store import DnaStore, LibraryError
from folder_picker import choose_local_directory, FolderPickerError
from workbench_store import WorkbenchStore, WorkbenchConflict
from project_skills import load_skills

ROOT = Path(__file__).resolve().parent
PARSER_URL = 'https://api.istero.com/resource/v2/video/analysis'
ASR_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions'
ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall'
MAX_MEDIA = 400 * 1024 * 1024
MAX_SECONDS = 3600
MAX_JOB_SECONDS = 2700
ACTIVE = {'pending', 'parsing', 'downloading', 'extracting', 'transcribing', 'rate_limited'}
# Fake-IP 仅对已知视频 CDN 域名兼容；真实本机／私网地址始终拒绝。
MEDIA_DOMAINS = ('douyinvod.com', 'douyinvodhk.com', '365yg.com', 'bytevcloudcdn.com', 'smtcdns.com',
                 'xhscdn.com', 'redcdn.net', 'amemv.com', 'ibytedtos.com', 'pstatp.com')
FAKE_IP_RANGE = ipaddress.ip_network('198.18.0.0/15')
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'}
LOG = logging.getLogger('spoken-dna')


class UserError(Exception):
    pass


class RateLimited(UserError):
    def __init__(self, provider, retry_after=0):
        self.provider, self.retry_after = provider, max(0, retry_after)
        super().__init__(provider + '请求限流，自动等待重试次数已用完，请稍后重试或检查账号额度。')


def retry_after_seconds(value):
    try:
        return max(0, float(value))
    except (TypeError, ValueError):
        try:
            return max(0, parsedate_to_datetime(value).timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            return 0


class ProviderGate:
    """每个服务共享一个请求通道；限流冷却对整批任务生效。"""
    def __init__(self):
        self.lock = threading.Lock()
        self.next_allowed = 0

    def run(self, operation, interval, deadline, stopped, on_wait, before, retries=4):
        notified = False
        while not self.lock.acquire(timeout=.2):
            if stopped() or time.monotonic() >= deadline:
                raise UserError('服务已停止或等待接口队列超时，请稍后重试。')
            if not notified:
                on_wait(0, False, 0); notified = True
        try:
            for attempt in range(retries + 1):
                wait = max(0, self.next_allowed - time.monotonic())
                if wait:
                    on_wait(wait, attempt > 0, attempt)
                while time.monotonic() < self.next_allowed:
                    if stopped() or time.monotonic() >= deadline:
                        raise UserError('服务已停止或接口冷却超过处理期限，请稍后重试。')
                    time.sleep(min(.2, max(0, self.next_allowed - time.monotonic())))
                if stopped() or time.monotonic() >= deadline:
                    raise UserError('本条处理已停止或超时，请稍后重试。')
                before()
                self.next_allowed = time.monotonic() + interval
                try:
                    return operation()
                except RateLimited as exc:
                    delay = max(exc.retry_after, 15 * 2**attempt)
                    self.next_allowed = max(self.next_allowed, time.monotonic() + delay)
                    if attempt == retries or self.next_allowed >= deadline:
                        raise
        finally:
            self.lock.release()


def atomic_json(path: Path, data):
    temp = path.with_suffix('.new')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def dpapi(data: bytes, decrypt=False) -> bytes:
    if os.name != 'nt':
        raise UserError('本版记住密钥使用 Windows 用户加密，请选择仅本次会话。')
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]
    buf = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    dest = Blob()
    crypt = ctypes.windll.crypt32
    func = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    func.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                     ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    func.restype = wintypes.BOOL
    if not func(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(dest)):
        raise UserError('Windows 密钥加密或解密失败，请重新填写配置。')
    try:
        return ctypes.string_at(dest.pbData, dest.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.cast(dest.pbData, ctypes.c_void_p))


class Config:
    def __init__(self, root=ROOT, legacy=None, workspace=None):
        self.root = root
        self.bootstrap_path = root / 'data/settings.json'
        bootstrap = json.loads(self.bootstrap_path.read_text(encoding='utf-8')) if self.bootstrap_path.exists() else {}
        selected = workspace or bootstrap.get('workspaceDirectory')
        self.workspace = Path(selected) if selected else None
        self.path = self.workspace / 'config.json' if self.workspace else self.bootstrap_path
        self.secret_path = self.workspace / 'credentials.dpapi' if self.workspace else root / 'data/credentials.dpapi'
        self.lock = threading.RLock()
        self.settings = {'remember': False, 'reuseExisting': True, 'model': ASR_MODEL,
                         'asrInterval': 6, 'parserInterval': 1, 'dnaDirectory': '',
                         'writingBase': 'https://api.deepseek.com/v1', 'writingModel': 'deepseek-chat'}
        self.secrets = {}
        self.sources = {}
        self.warning = ''
        if self.path.exists():
            self.settings.update(json.loads(self.path.read_text(encoding='utf-8')))
        self.settings['model'] = ASR_MODEL  # 固定识别模型，旧配置中的自定义值不再生效。
        if self.workspace:
            self.settings.update(workspaceDirectory=str(self.workspace), dnaDirectory=str(self.workspace / 'DNA'))
            if not self.workspace.is_dir():
                self.warning = '已选择的本地工作目录暂不可访问，请重新连接该目录；不要重复填写密钥。'
        if self.secret_path.exists():
            try:
                self.secrets = json.loads(dpapi(self.secret_path.read_bytes(), True).decode('utf-8'))
                self.sources = {k: 'Windows 加密保存' for k in self.secrets}
            except Exception:
                self.warning = '之前保存的密钥无法解密，请重新填写；原文件已保留。'
        values = dict(os.environ)
        # 项目目录内的可选配置文件，或用户明确指定的已有文件；不绑定开发者电脑路径。
        configured_file = self.settings.get('externalEnvFile') or os.environ.get('SPOKEN_DNA_ENV_FILE')
        env_file = Path(legacy) if legacy is not None else Path(configured_file).expanduser() if configured_file else root / '.env.local'
        if self.settings['reuseExisting'] and env_file.is_file():
            for line in env_file.read_text(encoding='utf-8-sig').splitlines():
                match = re.match(r'^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$', line)
                if match:
                    values.setdefault(match[1], match[2].strip('\"\''))
        if self.settings['reuseExisting']:
            for key, names in {'parserToken': ['ISTERO_API_TOKEN', 'ISTERO_TOKEN'],
                               'asrKey': ['SILICONFLOW_API_KEY']}.items():
                if not self.secrets.get(key):
                    for name in names:
                        val = values.get(name, '').strip()
                        if val and not val.startswith(('YOUR_', '请填写')):
                            self.secrets[key] = val
                            self.sources[key] = '本机已有配置（服务端只读复用）'
                            break

    def activate_workspace(self, directory):
        """先在新目录完整写好配置，再切换指针；旧目录文件保留。"""
        folder = Path(directory)
        if not folder.is_absolute() or not folder.is_dir():
            raise UserError('请选择一个有效的本地文件夹。')
        with self.lock:
            exists = (folder / 'config.json').is_file()
            if exists:
                try:
                    stored = json.loads((folder / 'config.json').read_text(encoding='utf-8'))
                    if not isinstance(stored, dict) or stored.get('format') != 'spoken-dna-config/v1':
                        raise ValueError()
                except (ValueError, OSError):
                    raise UserError('该文件夹已有其他格式或损坏的 config.json，原文件已保留。请选择空文件夹或已有的口播 DNA 工作目录。') from None
            candidate = Config(self.root, workspace=folder)
            if not exists:
                candidate.settings.update({k:self.settings[k] for k in ('asrInterval','parserInterval','writingBase','writingModel')})
                candidate.secrets = dict(self.secrets)
            candidate.settings.update(workspaceDirectory=str(folder), dnaDirectory=str(folder / 'DNA'), reuseExisting=False, model=ASR_MODEL)
            candidate.settings.pop('externalEnvFile', None)
            candidate.save({'remember': os.name == 'nt'})
            return candidate

    def adopt_workspace(self, candidate):
        with self.lock:
            # 项目内只留下定位文件，不在项目内继续保存工作目录的实际配置。
            atomic_json(self.bootstrap_path, {'workspaceDirectory': str(candidate.workspace)})
            for key in ('workspace','path','secret_path','settings','secrets','sources','warning'):
                setattr(self, key, getattr(candidate, key))

    def public(self):
        with self.lock:
            return {'parserConfigured': bool(self.secrets.get('parserToken')),
                    'asrConfigured': bool(self.secrets.get('asrKey')),
                    'parserSource': self.sources.get('parserToken', '未配置'),
                    'asrSource': self.sources.get('asrKey', '未配置'),
                    'remember': self.settings['remember'], 'model': self.settings['model'],
                    'warning': self.warning, 'ffmpeg': bool(shutil.which('ffmpeg')),
                    'ffprobe': bool(shutil.which('ffprobe')),
                    'asrInterval': self.settings['asrInterval'], 'parserInterval': self.settings['parserInterval'],
                    'asrConcurrency': 1, 'writingConfigured': bool(self.secrets.get('writingKey')),
                    'writingBase': self.settings['writingBase'], 'writingModel': self.settings['writingModel'],
                    'workspaceDirectory': str(self.workspace) if self.workspace else '',
                    'workspaceAvailable': bool(self.workspace and self.workspace.is_dir())}

    def snapshot(self):
        with self.lock:
            return dict(self.secrets), self.settings['model']

    def save(self, payload):
        with self.lock:
            if payload.get('requireWorkspace') and self.workspace is None:
                raise UserError('请先选择本地工作目录，再保存配置。')
            if self.workspace is not None and not self.workspace.is_dir():
                raise UserError('本地工作目录不可访问，请先重新连接，原配置没有改动。')
            updated = dict(self.secrets)
            if payload.get('forget'):
                updated = {}
            else:
                for key in ('parserToken', 'asrKey', 'writingKey'):
                    value = payload.get(key)
                    if value is not None:
                        if not isinstance(value, str) or len(value) > 1024 or any(c in value for c in '\r\n'):
                            raise UserError('密钥格式不正确，请重新粘贴。')
                        if value.strip():
                            updated[key] = value.strip()
            model = ASR_MODEL
            base = payload.get('writingBase', self.settings['writingBase'])
            writing_model = payload.get('writingModel', self.settings['writingModel'])
            if not isinstance(base, str) or len(base) > 2048:
                raise UserError('写作接口地址格式不正确。')
            address = parse.urlsplit(base)
            if address.scheme not in ('http','https') or not address.hostname or address.username or address.password or address.query or address.fragment:
                raise UserError('写作接口须为完整 http(s) 地址，不要把密钥放在地址中。')
            if not isinstance(writing_model, str) or not re.fullmatch(r'[A-Za-z0-9_./:-]{1,150}', writing_model):
                raise UserError('写作模型名称格式不正确。')
            remember = bool(payload.get('remember', self.workspace is not None and os.name == 'nt')) and not payload.get('forget')
            intervals = {}
            for name in ('asrInterval', 'parserInterval'):
                value = payload.get(name, self.settings[name])
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not 1 <= value <= 120:
                    raise UserError('接口最小请求间隔须为 1—120 秒。')
                intervals[name] = value
            if remember:
                encrypted = dpapi(json.dumps(updated).encode('utf-8'))
                tmp = self.secret_path.with_suffix('.new')
                tmp.write_bytes(encrypted)
                tmp.replace(self.secret_path)
            else:
                self.secret_path.unlink(missing_ok=True)
            self.settings = dict(self.settings, remember=remember, reuseExisting=False, model=model,
                                 writingBase=base.rstrip('/'), writingModel=writing_model, **intervals)
            if self.workspace is not None:
                self.settings['format'] = 'spoken-dna-config/v1'
            atomic_json(self.path, self.settings)
            self.secrets = updated
            self.sources = {key: 'Windows 加密保存' if remember else '仅本次服务会话' for key in updated}
            self.warning = ''
            return self.public()


def normalize_link(url):
    try:
        p = parse.urlsplit(url)
        host = (p.hostname or '').lower()
        if p.scheme not in ('http', 'https') or p.username or p.password or p.port not in (None, 80, 443):
            raise ValueError()
        path = p.path.rstrip('/')
        if host in ('v.douyin.com', 'douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'):
            platform = '抖音'
            video = re.search(r'/(?:share/)?video/(\d+)', path)
            vid = parse.parse_qs(p.query).get('modal_id', [''])[0]
            if video or vid.isdigit():
                return platform, 'douyin:' + (video[1] if video else vid)
            if host == 'v.douyin.com' and re.fullmatch(r'/[A-Za-z0-9_-]+', path):
                return platform, 'douyin-short:' + path[1:]
        if host in ('xhslink.com', 'www.xhslink.com', 'xiaohongshu.com', 'www.xiaohongshu.com'):
            platform = '小红书'
            note = re.search(r'/(?:explore|discovery/item)/(\w+)', path)
            if note:
                return platform, 'xhs:' + note[1].lower()
            if host in ('xhslink.com', 'www.xhslink.com') and re.fullmatch(r'/(?:[A-Za-z]/)?[A-Za-z0-9_-]+', path):
                return platform, 'xhs-short:' + path[1:]
    except (ValueError, TypeError):
        pass
    raise UserError('链接无效或内容类型不支持；请粘贴抖音／小红书单条视频分享链接。')


def extract_links(text):
    pattern = r'https?://[^\s<>\"\u4e00-\u9fff，。！？、；：）】》]+|(?<![\w.])(?:v\.douyin\.com|www\.douyin\.com|douyin\.com|xhslink\.com|www\.xiaohongshu\.com|xiaohongshu\.com)/[^\s<>\"\u4e00-\u9fff，。！？、；：）】》]+'
    return [x.rstrip('.,!?:;)]}\'”’') if x.startswith('http') else 'https://' + x.rstrip('.,!?:;)]}\'”’')
            for x in re.findall(pattern, text, re.I)]


def remote_url(url):
    try:
        p = parse.urlsplit(url)
        if p.scheme not in ('https', 'http') or not p.hostname or p.username or p.password or p.port not in (None, 80, 443):
            raise ValueError()
        host = p.hostname.lower().rstrip('.')
        try:
            literal = ipaddress.ip_address(host)
            if not literal.is_global:
                raise UserError('媒体地址指向本机或内网，已停止下载。')
        except ValueError:
            pass
        try:
            addresses = socket.getaddrinfo(host, p.port or (443 if p.scheme == 'https' else 80), type=socket.SOCK_STREAM)
        except OSError:
            raise UserError('视频媒体域名解析失败，请检查网络或 DNS 后重试；分享链接已解析成功。') from None
        known_cdn = any(host == domain or host.endswith('.' + domain) for domain in MEDIA_DOMAINS)
        def allowed(address):
            ip = ipaddress.ip_address(address)
            return ip.is_global or (known_cdn and ip.version == 4 and ip in FAKE_IP_RANGE)
        if not addresses or any(not allowed(x[4][0]) for x in addresses):
            raise ValueError()
    except (ValueError, OSError):
        raise UserError('解析出的媒体地址无效或指向本机／内网，已停止下载。') from None
    return url


class SafeRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        remote_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def provider_json(url, body, token, provider, content_type='application/json', timeout=90):
    req = request.Request(url, data=body, headers={**HEADERS, 'Content-Type': content_type,
                          'Authorization': 'Bearer ' + token}, method='POST')
    try:
        with request.urlopen(req, timeout=timeout) as res:
            raw = res.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise UserError(provider + '响应过大，请重试。')
            return json.loads(raw)
    except error.HTTPError as exc:
        if exc.code == 429:
            # 仅内部识别日额度耗尽，不向页面返回可能含敏感信息的上游原文。
            detail = exc.read(32768).decode('utf-8', errors='replace').lower()
            if any(word in detail for word in ('insufficient_quota', 'daily limit', 'requests per day', 'rpd limit', '余额不足', '日额度')):
                raise UserError(provider + '日额度或余额不足；已停止自动重试，请检查账号额度。') from None
            raise RateLimited(provider, retry_after_seconds(exc.headers.get('Retry-After'))) from None
        mapping = {401: '密钥无效或已过期，请在 API 配置中更新。', 403: '鉴权失败，请检查密钥、账号权限或动态签名设置。',
                   402: '余额不足，请检查账号。', 429: '请求过快或额度不足，请稍后单独重试。'}
        raise UserError(provider + '：' + mapping.get(exc.code, f'返回 HTTP {exc.code}，请稍后重试。')) from None
    except (TimeoutError, socket.timeout):
        raise UserError(provider + '等待超时，请稍后单独重试。') from None
    except (error.URLError, OSError):
        raise UserError(provider + '连接失败，请检查网络后重试。') from None
    except (ValueError, UnicodeError):
        raise UserError(provider + '返回的数据格式不正确，请重试。') from None


def parse_media(payload):
    if not isinstance(payload, dict):
        raise UserError('起零数据返回的数据格式不正确。')
    code = str(payload.get('code', '200'))
    if code != '200':
        if code == '429':
            raise RateLimited('起零数据')
        msg = {'202': '余额不足。', '401': 'Token 无效。', '403': 'Token 鉴权失败，请更新配置或检查动态签名设置。',
               '429': '请求过快，请稍后重试。', '302': '接口维护中。', '502': '账号被封锁或冻结。'}
        raise UserError('起零数据：' + msg.get(code, '平台解析失败；请确认链接仍有效、公开可访问且为视频。'))
    data = payload.get('data')
    if not isinstance(data, dict):
        raise UserError('起零数据未返回可识别的视频信息。')
    kind = str(data.get('type') or data.get('media_type') or data.get('note_type') or '').lower()
    media = data.get('url') or data.get('video_url') or data.get('video')
    if isinstance(media, dict):
        media = media.get('url') or media.get('play_url')
    if kind in ('image', 'images', 'normal', '图文', '图集') or not isinstance(media, str) or not media.strip():
        raise UserError('当前内容不是可下载的视频，可能是小红书图文／图集；第一版仅支持视频转文字。')
    return str(data.get('title') or '未命名视频')[:300], media.strip()


def parse_author(payload):
    """仅使用解析接口明确返回的作者，不从标题或文案猜测身份。"""
    data = payload.get('data', {}) if isinstance(payload, dict) else {}
    if not isinstance(data, dict):
        return '', ''
    author = next((data[k] for k in ('author', 'user', 'owner') if isinstance(data.get(k), dict)), {})
    name = author.get('nickname') or author.get('name') or author.get('nick_name') or data.get('author_name') or data.get('nickname')
    if not name and isinstance(data.get('author'), str):
        name = data['author']
    uid = author.get('sec_uid') or author.get('uid') or author.get('user_id') or data.get('author_id')
    return (str(name).strip()[:150] if isinstance(name, (str, int)) else '',
            str(uid).strip()[:200] if isinstance(uid, (str, int)) else '')


def download_media(url, dest, timeout=240):
    remote_url(url)
    opener = request.build_opener(SafeRedirect())
    started = time.monotonic()
    try:
        with opener.open(request.Request(url, headers=HEADERS), timeout=30) as res, dest.open('wb') as out:
            length = int(res.headers.get('Content-Length', '0'))
            if length > MAX_MEDIA:
                raise UserError('视频超过 400 MB，已停止下载；请使用较短的视频。')
            ctype = res.headers.get('Content-Type', '').lower()
            if ctype.startswith(('image/', 'text/')) or 'json' in ctype:
                raise UserError('下载结果不是视频，可能是图文、失效链接或平台验证页。')
            written = 0
            while True:
                block = res.read(256 * 1024)
                if not block:
                    break
                written += len(block)
                if written > MAX_MEDIA or time.monotonic() - started > timeout:
                    raise UserError('视频下载超时或超过 400 MB，已停止；可单独重试。')
                out.write(block)
            if not written:
                raise UserError('下载结果为空，请重试或更换视频链接。')
    except UserError:
        raise
    except Exception:
        raise UserError('视频下载失败或超时；平台链接可能失效，请单独重试。') from None


def run_media(args, timeout):
    try:
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True).stdout
    except FileNotFoundError:
        raise UserError('未找到 FFmpeg／FFprobe，请安装或加入 PATH 后重启服务。') from None
    except subprocess.TimeoutExpired:
        raise UserError('音频提取超时，已停止并清理临时媒体。') from None
    except subprocess.CalledProcessError:
        raise UserError('媒体无法读取或没有有效音轨；可能是图文、损坏文件或平台验证内容。') from None


def extract_audio(media, folder):
    result = run_media(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'default=noprint_wrappers=1:nokey=1', str(media)], 30)
    try:
        duration = float(result.strip())
        if not 0 < duration <= MAX_SECONDS:
            raise ValueError()
    except ValueError:
        raise UserError('无法确认视频时长，或视频超过 60 分钟；已停止，未截断原文。') from None
    run_media(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(media),
               '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
               '-f', 'segment', '-segment_time', '180', '-reset_timestamps', '1',
               str(folder / 'part-%03d.wav')], 240)
    parts = sorted(folder.glob('part-*.wav'))
    if not parts or any(x.stat().st_size < 100 for x in parts):
        raise UserError('没有提取到有效音频，无法转写。')
    return parts


def transcribe(part, key, model, timeout=600):
    boundary = '----SpokenDNA' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{model}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
            'Content-Type: audio/wav\r\n\r\n').encode('utf-8')
    body += part.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    result = provider_json(ASR_URL, body, key, '硅基流动', 'multipart/form-data; boundary=' + boundary, timeout)
    if isinstance(result, dict) and str(result.get('code')) == '429':
        raise RateLimited('硅基流动')
    text = result.get('text') if isinstance(result, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise UserError('语音识别返回空文字；请确认视频有清晰人声。未将空结果标记为成功。')
    return text.strip()


def connect_workspace(config, library, directory):
    folder = library.validate_directory(directory)
    library.validate_directory(str(folder / 'DNA'))
    try:
        previous = library.load()['entries']
    except LibraryError:
        previous = []  # 旧盘不可访问时保留原文件，允许重新连接其他已有工作目录。
    candidate = config.activate_workspace(folder)
    target = DnaStore(candidate)
    existing = {d['id'] for d in target.load()['entries']}
    # 兼容此前直接在所选目录下保存的 DNA，不移动、不删除原文件。
    legacy, _, _ = library._read(folder)
    for dna in previous + legacy:
        if dna['id'] not in existing:
            target.save(dna); existing.add(dna['id'])
    config.adopt_workspace(candidate)
    data = library.load()
    data['config'] = config.public()
    return data


def writing_request(config, payload):
    secrets, _ = config.snapshot()
    if not secrets.get('writingKey'):
        raise UserError('请在设置弹框填写并保存写作模型 API Key。')
    messages = payload.get('messages')
    if not isinstance(messages, list) or not messages or any(not isinstance(m, dict) or m.get('role') not in ('system','user','assistant') or not isinstance(m.get('content'), str) for m in messages):
        raise UserError('写作请求内容格式不正确。')
    tokens = payload.get('max_tokens', 6000)
    if isinstance(tokens, bool) or not isinstance(tokens, int) or not 1 <= tokens <= 32000:
        raise UserError('写作输出长度设置不正确。')
    with config.lock:
        base, model = config.settings['writingBase'], config.settings['writingModel']
    body = {'model':model,'messages':messages,'temperature':0.3,'max_tokens':tokens}
    try:
        result = provider_json(base.rstrip('/')+'/chat/completions', json.dumps(body,ensure_ascii=False).encode('utf-8'),
                               secrets['writingKey'], '写作模型', timeout=300)
    except RateLimited:
        raise UserError('写作接口限流，请稍后重试；已有分析和文稿已保留。') from None
    if not isinstance(result, dict) or not isinstance(result.get('choices'), list):
        raise UserError('写作接口未返回有效结果，请检查模型设置。')
    return result


class Jobs:
    def __init__(self, root, config):
        self.root, self.config = root, config
        self.path = root / 'data/jobs.json'
        self.temp = root / 'runtime/temp'
        self.lock = threading.RLock()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.rows = []
        self.stopping = False
        self.gates = {'parser': ProviderGate(), 'asr': ProviderGate()}
        if self.path.exists():
            self.rows = json.loads(self.path.read_text(encoding='utf-8'))
        for job in self.rows:
            if job['status'] in ACTIVE:
                job.update(status='failed', detail='服务上次停止时未完成，请单独重试。', error='服务中断，临时媒体已清理。')
        self.flush()
        for child in self.temp.iterdir():
            if child.is_dir() and re.fullmatch(r'[a-f0-9]{32}', child.name):
                shutil.rmtree(child)

    def flush(self):
        atomic_json(self.path, self.rows)

    def public(self):
        with self.lock:
            return json.loads(json.dumps(self.rows))

    def update(self, job, **fields):
        with self.lock:
            job.update(fields, updatedAt=time.time())
            self.flush()

    def submit(self, text):
        if not isinstance(text, str) or len(text) > 50000:
            raise UserError('分享文案过长，请每批控制在 50 条链接以内。')
        links = extract_links(text)
        if not links:
            raise UserError('未找到链接，请粘贴完整的分享文案或 http(s) 视频地址。')
        if len(links) > 50:
            raise UserError('每批最多 50 条链接，请分批添加。')
        added, duplicates, todo = [], 0, []
        with self.lock:
            if len(self.rows) + len(links) > 500:
                raise UserError('导入记录已达 500 条，请先清理已结束记录。原稿列表不受影响。')
            keys = {x['key'] for x in self.rows}
            for link in links:
                problem = ''
                try:
                    platform, key = normalize_link(link)
                except UserError as exc:
                    platform, key, problem = '不支持', 'invalid:' + link, str(exc)
                if key in keys:
                    duplicates += 1
                    continue
                keys.add(key)
                job = dict(id=uuid.uuid4().hex, key=key, platform=platform, originalUrl=link,
                           title='', transcript='', originalTranscript='', status='failed' if problem else 'pending',
                           detail=problem or '等待处理', error=problem, attempts=1, createdAt=time.time(), updatedAt=time.time())
                self.rows.append(job)
                added.append(job['id'])
                if not problem:
                    todo.append(job)
            self.flush()
        for job in todo:
            self.pool.submit(self.process, job)
        return {'added': len(added), 'duplicates': duplicates, 'ids': added}

    def retry(self, job_id):
        with self.lock:
            job = next((j for j in self.rows if j['id'] == job_id), None)
            if not job or job['status'] != 'failed':
                raise UserError('只能重试失败项；成功内容和正在处理的任务会保留。')
            normalize_link(job['originalUrl'])
            self.update(job, status='pending', error='', detail='等待重试', attempts=job['attempts'] + 1)
            self.pool.submit(self.process, job)
        return {'ok': True}

    def edit(self, job_id, payload):
        with self.lock:
            job = next((j for j in self.rows if j['id'] == job_id), None)
            if not job or job['status'] != 'success':
                raise UserError('只有转写成功的结果可以编辑。')
            title, text = payload.get('title'), payload.get('transcript')
            if not isinstance(title, str) or not isinstance(text, str) or not text.strip() or len(text) > 200000:
                raise UserError('原稿不能为空或超过 20 万字符。')
            self.update(job, title=title.strip()[:300] or '未命名视频', transcript=text.strip())
        return {'ok': True}

    def clear_finished(self):
        with self.lock:
            self.rows = [j for j in self.rows if j['status'] in ACTIVE]
            self.flush()
        return {'ok': True}

    def call_provider(self, which, job, phase, detail, operation, deadline):
        name = '语音识别' if which == 'asr' else '链接解析'
        interval = self.config.public()['asrInterval' if which == 'asr' else 'parserInterval']
        def on_wait(seconds, limited, attempt):
            text = f'{name}限流，等待约 {int(seconds)+1} 秒后自动重试（第 {attempt}/4 次）' if limited else f'等待{name}通道／请求间隔，约 {int(seconds)+1} 秒' if seconds else f'等待{name}通道，批量任务按顺序处理'
            self.update(job, status='rate_limited' if limited else phase, detail=text)
        return self.gates[which].run(operation, interval, deadline, lambda: self.stopping, on_wait,
                                     lambda: self.update(job, status=phase, detail=detail))

    def process(self, job):
        folder = self.temp / job['id']
        deadline = time.monotonic() + MAX_JOB_SECONDS
        try:
            if self.stopping:
                raise UserError('服务正在停止，请下次启动后重试。')
            secrets, model = self.config.snapshot()
            if not secrets.get('parserToken') or not secrets.get('asrKey'):
                raise UserError('请在 API 配置中分别填写起零数据 Token 和语音识别 API Key，然后重试。')
            if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
                raise UserError('未找到 FFmpeg／FFprobe，请安装后重启服务。')
            if shutil.disk_usage(self.root).free < 2 * 1024**3:
                raise UserError('项目所在磁盘可用空间不足 2 GB，已暂停媒体下载。')
            self.update(job, status='parsing', detail='正在解析视频链接', error='')
            def analyse():
                payload = provider_json(PARSER_URL, json.dumps({'url': job['originalUrl']}).encode('utf-8'),
                                        secrets['parserToken'], '起零数据')
                title, url = parse_media(payload)
                return title, url, parse_author(payload)
            title, url, (author_name, author_id) = self.call_provider('parser', job, 'parsing', '正在解析视频链接', analyse, deadline)
            self.update(job, title=title, authorName=author_name, authorId=author_id,
                        status='downloading', detail='正在下载临时视频')
            folder.mkdir(parents=True, exist_ok=True)
            media = folder / 'media.bin'
            download_media(url, media)
            self.update(job, status='extracting', detail='正在提取音轨并分段；未截断原文')
            parts = extract_audio(media, folder)
            texts = []
            for i, part in enumerate(parts):
                remaining = int(deadline - time.monotonic())
                if remaining < 1 or self.stopping:
                    raise UserError('本条处理超时或服务已停止，请单独重试。')
                self.update(job, status='transcribing', detail=f'转文字中：第 {i+1}/{len(parts)} 段（每段至多 3 分钟）')
                detail = f'转文字中：第 {i+1}/{len(parts)} 段（每段至多 3 分钟）'
                texts.append(self.call_provider('asr', job, 'transcribing', detail,
                             lambda: transcribe(part, secrets['asrKey'], model, min(600, max(1, int(deadline-time.monotonic())))), deadline))
            text = '\n\n'.join(texts).strip()
            if not text:
                raise UserError('转写结果为空，请检查视频是否有清晰人声。')
            self.update(job, status='success', transcript=text, originalTranscript=text, detail='转写成功，请查看并确认后加入原稿列表')
        except UserError as exc:
            self.update(job, status='failed', detail=str(exc), error=str(exc))
        except Exception:
            self.update(job, status='failed', detail='本条处理失败，请检查配置后单独重试。', error='本地处理异常，已有其他结果已保留。')
        finally:
            if folder.exists():
                try:
                    shutil.rmtree(folder)
                except OSError:
                    self.update(job, cleanupWarning='临时媒体被占用，将在下次启动时清理。')
            LOG.info('job=%s status=%s attempt=%s', job['id'], job['status'], job['attempts'])


class Handler(BaseHTTPRequestHandler):
    server_version = 'SpokenDNA/1.0'

    def log_message(self, *args):
        pass  # 不记录 URL、请求体、密钥或上游响应。

    def reply(self, data, status=200):
        raw = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(raw)

    def allowed(self, mutation=False):
        expected = f'127.0.0.1:{self.server.server_port}'
        host = self.headers.get('Host', '')
        if host not in (expected, f'localhost:{self.server.server_port}'):
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in ('http://' + expected, f'http://localhost:{self.server.server_port}'):
            return False
        return not mutation or self.headers.get('X-Spoken-DNA') == 'local'

    def do_GET(self):
        if not self.allowed():
            return self.reply({'error': '仅允许本机页面访问。'}, 403)
        path = parse.urlsplit(self.path).path
        if path == '/api/config':
            return self.reply(self.server.config.public())
        if path == '/api/skills':
            try:
                return self.reply(load_skills(self.server.root))
            except (OSError, UnicodeError, ValueError):
                return self.reply({'error': '项目 Skill 文件缺失、为空或无法读取，请检查 skills 目录；已有资料保留。'}, 500)
        if path == '/api/jobs':
            return self.reply({'jobs': self.server.jobs.public()})
        if path == '/api/library':
            try:
                return self.reply(self.server.library.load())
            except LibraryError as exc:
                return self.reply({'error': str(exc)}, 400)
        if path == '/api/workbench':
            try:
                return self.reply(self.server.workbench.load())
            except LibraryError as exc:
                return self.reply({'error': str(exc)}, 400)
        if path == '/api/health':
            return self.reply({'ok': True, 'app': '口播DNA', 'pid': os.getpid()})
        files = {'/': ('index.html', 'text/html; charset=utf-8'),
                 '/index.html': ('index.html', 'text/html; charset=utf-8'),
                 '/workshop.css': ('workshop.css', 'text/css; charset=utf-8'),
                 '/workshop-core.js': ('workshop-core.js', 'text/javascript; charset=utf-8'),
                 '/spoken-workshop.js': ('spoken-workshop.js', 'text/javascript; charset=utf-8'),
                 '/expression-profile.js': ('expression-profile.js', 'text/javascript; charset=utf-8'),
                 '/library.js': ('library.js', 'text/javascript; charset=utf-8'),
                 '/settings.js': ('settings.js', 'text/javascript; charset=utf-8'),
                 '/settings.css': ('settings.css', 'text/css; charset=utf-8'),
                 '/workflow.js': ('workflow.js', 'text/javascript; charset=utf-8'),
                 '/workflow.css': ('workflow.css', 'text/css; charset=utf-8'),
                 '/skills.js': ('skills.js', 'text/javascript; charset=utf-8'),
                 '/liquid-glass.css': ('liquid-glass.css', 'text/css; charset=utf-8'),
                 '/local.js': ('local.js', 'text/javascript; charset=utf-8'),
                 '/local.css': ('local.css', 'text/css; charset=utf-8')}
        if path == '/favicon.ico':
            self.send_response(204); self.end_headers(); return
        if path not in files:
            return self.reply({'error': '未找到内容。'}, 404)
        filename, ctype = files[path]
        file = self.server.root / 'web' / filename
        if not file.is_file():
            return self.reply({'error': '当前分支没有此资源。'}, 404)
        raw = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        self.mutate('POST')

    def do_PUT(self):
        self.mutate('PUT')

    def mutate(self, method):
        if not self.allowed(True):
            return self.reply({'error': '请求来源不允许，请从本地页面操作。'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            path = parse.urlsplit(self.path).path
            limit = 17 * 1024 * 1024 if path == '/api/workbench' else 9 * 1024 * 1024 if path == '/api/library' else 2 * 1024 * 1024
            if not 0 < length <= limit:
                raise UserError('请求为空或过大。')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise UserError('请求格式不正确。')
            path = parse.urlsplit(self.path).path
            if path == '/api/config' and method == 'PUT':
                return self.reply(self.server.config.save(payload))
            if path == '/api/workspace/choose' and method == 'POST':
                initial = str(self.server.config.workspace or self.server.root.parent)
                directory = choose_local_directory(initial)
                if not directory:
                    return self.reply({'cancelled': True})
                return self.reply(connect_workspace(self.server.config, self.server.library, directory))
            if path == '/api/writing' and method == 'POST':
                return self.reply(writing_request(self.server.config, payload))
            if path == '/api/library/config' and method == 'PUT':
                return self.reply(self.server.library.configure(payload.get('directory')))
            if path == '/api/library' and method == 'PUT':
                return self.reply(self.server.library.save(payload.get('dna')))
            if path == '/api/workbench' and method == 'PUT':
                if payload.get('workspaceDirectory') and payload['workspaceDirectory'] != str(self.server.config.workspace or ''):
                    raise WorkbenchConflict('工作目录已切换，本次旧目录的保存请求已停止；浏览器资料保留。')
                return self.reply(self.server.workbench.save(payload.get('state'), payload.get('revision')))
            if path == '/api/library/open' and method == 'POST':
                return self.reply(self.server.library.open_directory())
            if path == '/api/jobs' and method == 'POST':
                return self.reply(self.server.jobs.submit(payload.get('text')))
            match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})(/retry)?', path)
            if match:
                if match[2] and method == 'POST':
                    return self.reply(self.server.jobs.retry(match[1]))
                if not match[2] and method == 'PUT':
                    return self.reply(self.server.jobs.edit(match[1], payload))
            if path == '/api/jobs/clear' and method == 'POST':
                return self.reply(self.server.jobs.clear_finished())
            if path == '/api/shutdown' and method == 'POST':
                self.server.jobs.stopping = True
                self.reply({'ok': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            self.reply({'error': '未找到接口。'}, 404)
        except WorkbenchConflict as exc:
            self.reply({'error': str(exc)}, 409)
        except (UserError, LibraryError, FolderPickerError, ValueError) as exc:
            self.reply({'error': str(exc) if isinstance(exc, (UserError, LibraryError, FolderPickerError)) else '请求格式不正确。'}, 400)
        except Exception:
            self.reply({'error': '本地服务处理失败，请重试。配置和已完成结果会保留。'}, 500)


def make_server(root=ROOT, port=8765, legacy=None):
    for name in ('data', 'runtime/temp', 'runtime/logs'):
        (root / name).mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    config = Config(root, legacy)
    jobs = Jobs(root, config)
    server.root, server.config, server.jobs = root, config, jobs
    server.library = DnaStore(config)
    server.workbench = WorkbenchStore(config)
    return server


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--port', type=int, default=8765)
    options = args.parse_args()
    os.environ['TMP'] = os.environ['TEMP'] = str(ROOT / 'runtime/temp')
    (ROOT / 'runtime/logs').mkdir(parents=True, exist_ok=True)
    # 停止时可能仍在等待上游请求；文件锁避免旧任务退出前启动第二个写入进程。
    process_lock = (ROOT / 'runtime/process.lock').open('a+b')
    if os.name == 'nt':
        import msvcrt
        process_lock.seek(0)
        if not process_lock.read(1):
            process_lock.write(b'0'); process_lock.flush()
        process_lock.seek(0)
        try:
            msvcrt.locking(process_lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            print('服务仍在运行或正在结束当前请求，请等停止完成后再启动。')
            process_lock.close()
            raise SystemExit(1)
    handler = RotatingFileHandler(ROOT / 'runtime/logs/server.log', maxBytes=1024*1024, backupCount=2, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    LOG.addHandler(handler); LOG.setLevel(logging.INFO)
    try:
        server = make_server(port=options.port)
    except OSError:
        print('无法启动：本机端口被占用或项目目录无法写入。请查看启动日志。')
        raise SystemExit(1)
    atomic_json(ROOT / 'runtime/server.json', {'pid': os.getpid(), 'port': server.server_port})
    LOG.info('service started port=%s', server.server_port)
    print(f'口播DNA已启动：http://127.0.0.1:{server.server_port}')
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.jobs.stopping = True
        server.jobs.pool.shutdown(wait=True)
        server.server_close()
        (ROOT / 'runtime/server.json').unlink(missing_ok=True)
        LOG.info('service stopped')


if __name__ == '__main__':
    main()
