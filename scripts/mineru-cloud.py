#!/usr/bin/env python3
"""Run MinerU-Skill with environment-proxy support for its HTTP transport.

Set PKU_STUDY_MINERU_SCRIPT to the installed MinerU-Skill mineru.py (3.3.1).
Only the request transport is replaced; routing, retries and parsing stay upstream.
"""
import importlib.util
import os
import sys
import urllib.error
import urllib.request


def send_once(method, url, *, headers=None, data=None, timeout=60, **_):
    request_headers = dict(headers or {})
    if method == "PUT" and not any(key.lower() == "content-type" for key in request_headers):
        # urllib otherwise adds application/x-www-form-urlencoded, invalidating
        # OSS upload signatures that were issued with an empty Content-Type.
        request_headers["Content-Type"] = ""
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.code, response.read(), response.headers.get("Retry-After")


def main():
    path = os.environ.get("PKU_STUDY_MINERU_SCRIPT")
    if not path or not os.path.isfile(path):
        print("Set PKU_STUDY_MINERU_SCRIPT to the installed MinerU-Skill mineru.py.", file=sys.stderr)
        return 2
    spec = importlib.util.spec_from_file_location("pku_study_mineru", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load MinerU-Skill script")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if not hasattr(module, "_send_once") or not hasattr(module, "main"):
        raise RuntimeError("Unsupported MinerU-Skill version; expected 3.3.1 transport")
    if any(key in urllib.request.getproxies() for key in ("http", "https")):
        module._send_once = send_once
    return module.main()


if __name__ == "__main__":
    sys.exit(main())
