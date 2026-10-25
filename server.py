"""口播 DNA 本地服务。Python 标准库 + 本机 FFmpeg，无第三方运行依赖。"""
from __future__ import annotations

import argparse
import concurrent.futures
import ctypes
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

ROOT = Path(__file__).resolve().parent
PARSER_URL = 'https://api.istero.com/resource/v2/video/analysis'
ASR_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions'
ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall'
MAX_MEDIA = 400 * 1024 * 1024
MAX_SECONDS = 3600
MAX_JOB_SECONDS = 2700
ACTIVE = {'pending', 'parsing', 'downloading', 'extracting', 'transcribing'}
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'}
LOG = logging.getLogger('spoken-dna')


class UserError(Exception):
    pass


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
    def __init__(self, root=ROOT, legacy=None):
        self.root = root
        self.path = root / 'data/settings.json'
        self.secret_path = root / 'data/credentials.dpapi'
        self.lock = threading.RLock()
        self.settings = {'remember': False, 'reuseExisting': True, 'model': ASR_MODEL}
        self.secrets = {}
        self.sources = {}
        self.warning = ''
        if self.path.exists():
            self.settings.update(json.loads(self.path.read_text(encoding='utf-8')))
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

    def public(self):
        with self.lock:
            return {'parserConfigured': bool(self.secrets.get('parserToken')),
                    'asrConfigured': bool(self.secrets.get('asrKey')),
                    'parserSource': self.sources.get('parserToken', '未配置'),
                    'asrSource': self.sources.get('asrKey', '未配置'),
                    'remember': self.settings['remember'], 'model': self.settings['model'],
                    'warning': self.warning, 'ffmpeg': bool(shutil.which('ffmpeg')),
                    'ffprobe': bool(shutil.which('ffprobe'))}

    def snapshot(self):
        with self.lock:
            return dict(self.secrets), self.settings['model']

    def save(self, payload):
        with self.lock:
            updated = dict(self.secrets)
            if payload.get('forget'):
                updated = {}
            else:
                for key in ('parserToken', 'asrKey'):
                    value = payload.get(key)
                    if value is not None:
                        if not isinstance(value, str) or len(value) > 1024 or any(c in value for c in '\r\n'):
                            raise UserError('密钥格式不正确，请重新粘贴。')
                        if value.strip():
                            updated[key] = value.strip()
            model = payload.get('model', self.settings['model'])
            if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9_./:-]{1,150}', model):
                raise UserError('语音模型名称格式不正确。')
            remember = bool(payload.get('remember', False)) and not payload.get('forget')
            if remember:
                encrypted = dpapi(json.dumps(updated).encode('utf-8'))
                tmp = self.secret_path.with_suffix('.new')
                tmp.write_bytes(encrypted)
                tmp.replace(self.secret_path)
            else:
                self.secret_path.unlink(missing_ok=True)
            self.settings = {'remember': remember, 'reuseExisting': False, 'model': model}
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
        addresses = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == 'https' else 80), type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(x[4][0]).is_global for x in addresses):
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
    text = result.get('text') if isinstance(result, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise UserError('语音识别返回空文字；请确认视频有清晰人声。未将空结果标记为成功。')
    return text.strip()


class Jobs:
    def __init__(self, root, config):
        self.root, self.config = root, config
        self.path = root / 'data/jobs.json'
        self.temp = root / 'runtime/temp'
        self.lock = threading.RLock()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.rows = []
        self.stopping = False
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
            payload = provider_json(PARSER_URL, json.dumps({'url': job['originalUrl']}).encode('utf-8'),
                                    secrets['parserToken'], '起零数据')
            title, url = parse_media(payload)
            self.update(job, title=title, status='downloading', detail='正在下载临时视频')
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
                texts.append(transcribe(part, secrets['asrKey'], model, min(600, remaining)))
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
        if path == '/api/jobs':
            return self.reply({'jobs': self.server.jobs.public()})
        if path == '/api/health':
            return self.reply({'ok': True, 'app': '口播DNA', 'pid': os.getpid()})
        files = {'/': ('index.html', 'text/html; charset=utf-8'),
                 '/index.html': ('index.html', 'text/html; charset=utf-8'),
                 '/workshop.css': ('workshop.css', 'text/css; charset=utf-8'),
                 '/workshop-core.js': ('workshop-core.js', 'text/javascript; charset=utf-8'),
                 '/spoken-workshop.js': ('spoken-workshop.js', 'text/javascript; charset=utf-8'),
                 '/expression-profile.js': ('expression-profile.js', 'text/javascript; charset=utf-8'),
                 '/local.js': ('local.js', 'text/javascript; charset=utf-8'),
                 '/local.css': ('local.css', 'text/css; charset=utf-8')}
        if path == '/favicon.ico':
            self.send_response(204); self.end_headers(); return
        if path not in files:
            return self.reply({'error': '未找到内容。'}, 404)
        filename, ctype = files[path]
        raw = (self.server.root / 'web' / filename).read_bytes()
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
            if not 0 < length <= 2 * 1024 * 1024:
                raise UserError('请求为空或过大。')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise UserError('请求格式不正确。')
            path = parse.urlsplit(self.path).path
            if path == '/api/config' and method == 'PUT':
                return self.reply(self.server.config.save(payload))
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
        except (UserError, ValueError) as exc:
            self.reply({'error': str(exc) if isinstance(exc, UserError) else '请求格式不正确。'}, 400)
        except Exception:
            self.reply({'error': '本地服务处理失败，请重试。配置和已完成结果会保留。'}, 500)


def make_server(root=ROOT, port=8765, legacy=None):
    for name in ('data', 'runtime/temp', 'runtime/logs'):
        (root / name).mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    config = Config(root, legacy)
    jobs = Jobs(root, config)
    server.root, server.config, server.jobs = root, config, jobs
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
