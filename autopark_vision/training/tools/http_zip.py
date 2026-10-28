"""Read members of a remote zip via HTTP Range requests (no full download)."""
from __future__ import annotations

import io
import urllib.request


class HTTPRangeFile(io.RawIOBase):
    def __init__(self, url: str, block: int = 1 << 16, timeout: int = 120):
        self.url, self.block, self.timeout = url, block, timeout
        self.pos = 0
        self._cache: dict[int, bytes] = {}
        req = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            self.url = r.geturl()  # pin the redirected CDN URL
            self.size = int(r.headers["Content-Range"].split("/")[-1])

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, offset, whence=0):
        self.pos = {0: offset, 1: self.pos + offset, 2: self.size + offset}[whence]
        return self.pos

    def _get(self, start: int, end: int) -> bytes:
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.read()
            except OSError:
                if attempt == 3:
                    raise

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        if n <= self.block:  # small reads (zip headers): cache whole blocks
            b0 = self.pos // self.block * self.block
            if b0 not in self._cache:
                self._cache[b0] = self._get(b0, min(self.size, b0 + self.block) - 1)
            chunk = self._cache[b0][self.pos - b0 : self.pos - b0 + n]
            if len(chunk) == n:
                self.pos += n
                return chunk
        data = self._get(self.pos, self.pos + n - 1)
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)
