"""Run a node's code artifact locally against uploaded input files.

The rest of the Studio deliberately never executes user code (see modify.py). This is
the one opt-in exception: the Playground's "Run" button, for a developer running their
own pipeline code on their own data on their own machine. It is NOT a sandbox - the code
runs as a normal subprocess with your user's permissions - so it is meant for local dev
only, never a shared/hosted deployment.

Two ways your code can consume the uploaded input_artifacts, so nothing is hardcoded:

  1. Function mode (preferred - fully generic). Define a function and set it as the
     entrypoint. The harness binds each uploaded file to the parameter of the same name
     (param `trips` <- `trips.txt`) as a re-iterable `Table` of CSV rows, calls your
     function, and writes whatever it RETURNS into output/ (a dict {filename: data}
     writes one file each; a list of rows / DataFrame / str / json-able value writes a
     single result file). No open(), no paths, no filenames in your code.

  2. Script mode (fallback / backward compatible). If the code has no callable entrypoint
     it just runs top-to-bottom in a dir that already contains input_artifacts/ and
     output/; read/write those yourself.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DEFAULT_TIMEOUT = 60
_MAX_STREAM_CHARS = 20000        # cap stdout/stderr returned to the UI
_MAX_OUTPUT_BYTES = 5 * 1024 * 1024  # per output file
_MAX_OUTPUT_FILES = 50

# Runs in the subprocess: imports the user's code as `user_code`, resolves an entrypoint,
# binds input_artifacts files to its parameters by name, calls it, writes its return to
# output/. ENTRYPOINT is prepended by run_code so the body stays brace-safe (no .format).
_HARNESS_BODY = r'''
import csv, json, os, inspect

INPUT_DIR, OUTPUT_DIR = "input_artifacts", "output"


class Table:
    """One uploaded file as a re-iterable stream of CSV rows (a dict per row). Iterate it
    as often as you like - it never holds the whole file in memory. `.path` is the raw
    file path if you need to parse it differently; `.rows()` materialises a list."""
    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
    def __iter__(self):
        with open(self.path, newline="") as handle:
            yield from csv.DictReader(handle)
    def __len__(self):
        return sum(1 for _ in self)
    def rows(self):
        return list(self)


def _inputs():
    if not os.path.isdir(INPUT_DIR):
        return {}
    return {name: os.path.join(INPUT_DIR, name) for name in sorted(os.listdir(INPUT_DIR)) if os.path.isfile(os.path.join(INPUT_DIR, name))}


def _resolve(entrypoint, produced_before):
    funcs = {k: v for k, v in vars(user_code).items() if inspect.isfunction(v) and getattr(v, "__module__", "") == "user_code" and not k.startswith("_")}
    if entrypoint:
        if entrypoint not in funcs:
            raise SystemExit("Entrypoint '%s' is not a function defined in your code. Defined: %s" % (entrypoint, ", ".join(funcs) or "(none)"))
        return funcs[entrypoint]
    for name in ("main", "run"):
        if name in funcs:
            return funcs[name]
    # a single function is unambiguous - but only take over if the script didn't already
    # produce output on import (otherwise it was script-mode that happens to define one).
    if len(funcs) == 1 and not produced_before:
        return next(iter(funcs.values()))
    return None


def _bind(func, inputs):
    params = list(inspect.signature(func).parameters)
    by_key = {}
    for name, path in inputs.items():
        by_key[name.lower()] = path
        by_key[os.path.splitext(name)[0].lower()] = path
    args = [None] * len(params)
    used = set()
    unmatched = []
    for i, param in enumerate(params):
        path = by_key.get(param.lower())
        if path is not None:
            args[i] = Table(path); used.add(path)
        else:
            unmatched.append(i)
    # bind any files that matched no parameter name to the still-empty slots, in order
    leftover = [path for path in inputs.values() if path not in used]
    for slot, path in zip(unmatched, leftover):
        args[slot] = Table(path)
    missing = [params[i] for i in unmatched[len(leftover):]]
    if missing:
        raise SystemExit("Could not match parameter(s) %s to an uploaded file. Name your function's parameters after the files in input_artifacts (e.g. trips, stop_times)." % ", ".join(missing))
    return args


def _write_one(path, value, add_ext=False):
    if isinstance(value, str):
        Path(path + (".txt" if add_ext else "")).write_text(value)
    elif isinstance(value, (list, tuple)) and value and isinstance(value[0], (list, tuple)):
        with open(path + (".csv" if add_ext else ""), "w", newline="") as f:
            csv.writer(f).writerows(value)
    elif isinstance(value, (list, tuple)) and value and isinstance(value[0], dict):
        with open(path + (".csv" if add_ext else ""), "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(value[0].keys())); writer.writeheader(); writer.writerows(value)
    elif hasattr(value, "to_csv"):
        value.to_csv(path + (".csv" if add_ext else ""), index=False)
    else:
        Path(path + (".json" if add_ext else "")).write_text(json.dumps(value, indent=2, default=str))


def _write_outputs(result):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    if result is None:
        return
    if isinstance(result, dict) and all(isinstance(k, str) for k in result):
        for filename, value in result.items():
            _write_one(os.path.join(OUTPUT_DIR, os.path.basename(filename)), value)
    else:
        _write_one(os.path.join(OUTPUT_DIR, "result"), result, add_ext=True)


from pathlib import Path
_before = os.path.isdir(OUTPUT_DIR) and any(Path(OUTPUT_DIR).rglob("*"))
import user_code
_produced = os.path.isdir(OUTPUT_DIR) and any(p.is_file() for p in Path(OUTPUT_DIR).rglob("*"))

_func = _resolve(ENTRYPOINT, _produced and not _before)
if _func is not None:
    _sig = inspect.signature(_func)
    _args = _bind(_func, _inputs()) if _sig.parameters else []
    _write_outputs(_func(*_args))
'''


def _clip(text: str, limit: int = _MAX_STREAM_CHARS) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n… ({len(text) - limit} more chars truncated)"


def _safe_name(filename: str) -> str:
    name = os.path.basename((filename or "").strip())
    if not name or name in (".", ".."):
        raise ValueError(f"Invalid input filename: {filename!r}")
    return name


def run_code(code: str, language: str, inputs: list[tuple[str, bytes]], entrypoint: str = "", timeout: int = DEFAULT_TIMEOUT) -> dict:
    """inputs: list of (filename, bytes). Runs the code (function mode if it has an
    entrypoint, else script mode) and returns stdout/stderr plus the files written to
    output/."""
    if not code or not code.strip():
        raise ValueError("There is no code to run — add code on this node first.")
    if (language or "python").lower() not in ("python", "py"):
        raise ValueError(f"Only Python execution is supported (got {language!r}).")

    with tempfile.TemporaryDirectory(prefix="rdf-run-") as tmp:
        base = Path(tmp)
        (base / "input_artifacts").mkdir()
        (base / "output").mkdir()
        for filename, data in inputs:
            (base / "input_artifacts" / _safe_name(filename)).write_bytes(data)
        (base / "user_code.py").write_text(code, encoding="utf-8")
        harness = f"ENTRYPOINT = {json.dumps((entrypoint or '').strip())}\n" + _HARNESS_BODY
        (base / "main.py").write_text(harness, encoding="utf-8")

        env = dict(os.environ)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        started = time.time()
        try:
            proc = subprocess.run(
                [sys.executable, "main.py"],
                cwd=base,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "ok": False,
                "returncode": None,
                "timedOut": True,
                "durationMs": int((time.time() - started) * 1000),
                "stdout": _clip(exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")),
                "stderr": _clip((exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")) + f"\nExecution exceeded the {timeout}s time limit and was stopped."),
                "outputs": [],
            }

        outputs = []
        for path in sorted((base / "output").rglob("*")):
            if not path.is_file():
                continue
            if len(outputs) >= _MAX_OUTPUT_FILES:
                break
            data = path.read_bytes()
            truncated = len(data) > _MAX_OUTPUT_BYTES
            data = data[:_MAX_OUTPUT_BYTES]
            entry = {"filename": str(path.relative_to(base / "output")), "bytes": len(data), "truncated": truncated}
            try:
                entry["text"] = data.decode("utf-8")
            except UnicodeDecodeError:
                entry["base64"] = base64.b64encode(data).decode("ascii")
            outputs.append(entry)

        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "timedOut": False,
            "durationMs": int((time.time() - started) * 1000),
            "stdout": _clip(proc.stdout or ""),
            "stderr": _clip(proc.stderr or ""),
            "outputs": outputs,
        }
