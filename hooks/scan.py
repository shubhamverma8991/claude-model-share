"""Sum token usage per model across Claude Code transcripts since a start time.

Usage: python3 -I scan.py <start_epoch_ms | auto>
"auto" starts at the latest Thursday 7:30 pm, local time.
Prints JSON: {"models": {model_id: weighted_tokens},
             "split": {model_id: {"input": n, "output": n, "cached": n}},
             "files": n, "start": epoch_ms}
"input" is fresh input plus cache writes, "cached" is cache reads (raw counts).
"""
import json, os, sys
from datetime import datetime, timedelta

root = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'projects')
if sys.argv[1] == 'auto':
    now = datetime.now()
    s = (now - timedelta(days=(now.weekday() - 3) % 7)).replace(hour=19, minute=30, second=0, microsecond=0)
    if s > now:
        s -= timedelta(days=7)
    start = s.timestamp()
else:
    start = int(sys.argv[1]) / 1000
seen = set()
models = {}
split = {}
files = 0

for dirpath, _, names in os.walk(root):
    for name in names:
        if not name.endswith('.jsonl'):
            continue
        path = os.path.join(dirpath, name)
        try:
            if os.path.getmtime(path) < start:
                continue
            fh = open(path, encoding='utf-8', errors='replace')
        except OSError:
            continue
        files += 1
        with fh:
            for line in fh:
                if '"usage"' not in line or '"assistant"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get('type') != 'assistant':
                    continue
                m = d.get('message') or {}
                u = m.get('usage')
                model = m.get('model')
                if not u or not model or model == '<synthetic>':
                    continue
                ts = d.get('timestamp')
                try:
                    if datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() < start:
                        continue
                except Exception:
                    continue
                key = (m.get('id'), d.get('requestId'))
                if key in seen:
                    continue
                seen.add(key)
                fresh = (u.get('input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0)
                out = u.get('output_tokens') or 0
                cached = u.get('cache_read_input_tokens') or 0
                models[model] = models.get(model, 0) + fresh + out + 0.1 * cached
                one = split.setdefault(model, {'input': 0, 'output': 0, 'cached': 0})
                one['input'] += fresh
                one['output'] += out
                one['cached'] += cached

print(json.dumps({'models': models, 'split': split, 'files': files, 'start': int(start * 1000)}))
