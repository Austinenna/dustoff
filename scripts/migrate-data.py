#!/usr/bin/env python3
"""从停写后的只读快照构建 Linux 数据副本。源快照始终保留，不原地迁移。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def migrate(source_home, source_notes, old_home, old_notes, destination, profile=None, gateway_base=None):
    source_home, source_notes, destination = map(lambda p: Path(p).resolve(), (source_home, source_notes, destination))
    if destination.exists():
        raise ValueError('目标必须是尚不存在的新目录')
    if any(destination == p or p in destination.parents or destination in p.parents for p in (source_home, source_notes)):
        raise ValueError('源与目标目录不能重叠')
    if not (source_home / 'index.sqlite').is_file() or not source_notes.is_dir():
        raise ValueError('源账本或笔记目录不存在')
    for name in ['index.sqlite', 'dustoff.conf']:
        if (source_home/name).is_symlink():
            raise ValueError('账本与配置必须为普通文件')
    if (source_home / 'index.sqlite-wal').exists():
        raise ValueError('源快照仍有 WAL，请先停止写入并生成一致数据库快照')
    if profile is not None and not Path(profile).is_dir():
        raise ValueError('Linux 登录资料不存在')
    old_home, old_notes = str(old_home).rstrip('/'), str(old_notes).rstrip('/')
    mappings = [(old_notes, source_notes, destination / 'notes'), (old_home, source_home, destination)]

    def mapped(value):
        for prefix, source, target in mappings:
            if value.startswith(prefix + '/'):
                relative = Path(value[len(prefix) + 1:])
                if '..' in relative.parts:
                    raise ValueError('账本路径包含上级目录')
                return source / relative, target / relative
        raise ValueError('存在未映射的账本路径，迁移已停止')

    # 在创建目标前确认所有仍应存在的业务产物都能读取，并记录源哈希。
    db = sqlite3.connect((source_home / 'index.sqlite').as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    rows = list(db.execute('SELECT * FROM items'))
    counts = {name: db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
              for name in ['items', 'daily_state', 'daily_queue', 'daily_usage']}
    expected, updates, deleted = {}, [], 0
    for row in rows:
        changes = {}
        for column in ['media_path', 'text_path', 'note_path']:
            value = row[column]
            if not value:
                continue
            source, target = mapped(value)
            changes[column] = str(target)
            if source.is_file():
                expected[str(target)] = digest(source)
            elif column == 'media_path' and row['media_deleted']:
                deleted += 1
            else:
                raise ValueError(f'有效产物缺失：{column}，迁移已停止')
        updates.append((row['platform'], row['id'], changes))
    db.close()

    def ignore(directory, names):
        if Path(directory) == source_home:
            return [n for n in names if n == 'chrome-profile' or n.startswith('.lock.')]
        return []

    shutil.copytree(source_home, destination, symlinks=True, ignore=ignore)
    shutil.copytree(source_notes, destination / 'notes', symlinks=True)
    if profile is not None:
        shutil.copytree(profile, destination / 'chrome-profile', symlinks=True)
        for name in ['SingletonLock', 'SingletonCookie', 'SingletonSocket']:
            link = destination / 'chrome-profile' / name
            if link.is_symlink():
                link.unlink()

    db = sqlite3.connect(destination / 'index.sqlite')
    try:
        with db:
            for platform, item_id, values in updates:
                if values:
                    sql = 'UPDATE items SET ' + ','.join(f'{column}=?' for column in values) + ' WHERE platform=? AND id=?'
                    db.execute(sql, [*values.values(), platform, item_id])
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('目标数据库完整性检查失败')
        for name, count in counts.items():
            if db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] != count:
                raise ValueError('迁移前后表数量不一致')
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    finally:
        db.close()

    conf = destination / 'dustoff.conf'
    settings = {
        'DUST_HOME': str(destination), 'DUST_MEDIA': str(destination / 'media'),
        'DUST_SAVED_MEDIA': str(destination / 'saved-media'), 'DUST_TEXT': str(destination / 'text'),
        'DUST_NOTES': str(destination / 'notes'), 'DUST_PROFILE': str(destination / 'chrome-profile'),
        'DUST_CHROME': '/usr/bin/google-chrome', 'DUST_NOTIFY': '0',
    }
    if gateway_base:
        from urllib.parse import urlsplit
        url = urlsplit(gateway_base)
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            raise ValueError('同机网关地址必须是回环 HTTP 地址')
        base = gateway_base.rstrip('/')
        settings.update(DUST_ROUTER_BASE=base+'/v1', DUST_ASR_BASE=base+'/v1/asr/transcriptions', DUST_LLM_BASE=base+'/v1/chat/completions')
    lines, remaining = [], dict(settings)
    for line in conf.read_text().splitlines() if conf.exists() else []:
        match = re.match(r'^\s*(DUST_[A-Z0-9_]+)\s*=', line)
        if match and match[1] in settings:
            lines.append(match[1] + '=' + settings[match[1]])
            remaining.pop(match[1], None)
        else:
            lines.append(line)
    conf.write_text('\n'.join(lines + [key+'='+value for key, value in remaining.items()]) + '\n')
    os.chmod(conf, 0o600)
    for target, value in expected.items():
        if digest(target) != value:
            raise ValueError('业务文件迁移后哈希不一致')
    # 全部笔记、文字稿和收藏媒体目录逐文件校验，包括未被账本引用的旧产物。
    files_checked = 0
    for source, target in [(source_notes, destination/'notes')] + [(source_home/name, destination/name) for name in ['text', 'media', 'saved-media', 'transcript-meta']]:
        if not source.exists():
            continue
        for file in source.rglob('*'):
            if file.is_file() and not file.is_symlink():
                if digest(file) != digest(target/file.relative_to(source)):
                    raise ValueError('产物目录逐文件校验失败')
                files_checked += 1
    report = {'tables': counts, 'mappedRows': len(updates), 'verifiedReferencedFiles': len(expected),
              'verifiedArtifactFiles': files_checked, 'previouslyDeletedMedia': deleted,
              'sourcePreserved': True, 'sqliteIntegrity': 'ok', 'linuxProfileImported': profile is not None}
    (destination/'migration-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['source-home', 'source-notes', 'old-home', 'old-notes', 'destination']:
        parser.add_argument('--'+flag, required=True)
    parser.add_argument('--profile')
    parser.add_argument('--gateway-base')
    args = vars(parser.parse_args())
    print(json.dumps(migrate(**args), ensure_ascii=False))
