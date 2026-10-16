"""Staleproof sandbox entry point: runs example.py the way a reader would.

Async docs are written for an async REPL (`python -m asyncio`, IPython, Jupyter):
`async with httpx.AsyncClient() as client:` at the top level. Run as a script that is
a SyntaxError, which would report the example as broken when it is not. Such code is
compiled with top-level await allowed and run on an event loop instead; everything
else runs unchanged.
"""
import ast
import asyncio

_PATH = "example.py"

with open(_PATH, encoding="utf-8") as _f:
    _source = _f.read()

try:
    _code = compile(_source, _PATH, "exec")
    _is_async = False
except SyntaxError as _err:
    if "outside async function" not in str(_err) and "'await' outside function" not in str(_err):
        raise
    _code = compile(_source, _PATH, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    _is_async = True

_globals = {"__name__": "__main__", "__file__": _PATH, "__builtins__": __builtins__}
_result = eval(_code, _globals)  # noqa: S307 - the sandboxed example itself
if _is_async and asyncio.iscoroutine(_result):
    asyncio.run(_result)
