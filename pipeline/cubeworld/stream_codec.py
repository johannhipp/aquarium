"""Chunk codec v2 for the streamed world (decoder: src/cubeworld/stream/format.ts decodeChunk).

A chunk is SPAN x SPAN columns (34 x 34, the 32 x 32 interior plus a one-cell ring) of class bytes, bottom up. Almost
every column of the 2.5D city is one of a few shapes, so a column is coded as

    pattern  (empty | ground | ground + surface class k | ground + building [+ roof] | ... | explicit run list)
    s        height of the ground run, predicted from the left/up neighbours (median edge detector)
    b        height of the building run: the same as left / up / up-right, or a fresh value
    exotic   trees, poles, decks, stacked roofs ...: the plain run list

Every symbol is coded with a static rANS model: per LOD level and per context a frequency table trained on the
build's own chunks (`train`), shipped inside dir.<hash>.bin. Static tables mean no per-chunk learning cost and no
header, which is what a 400-byte chunk needs; the context is a function of already decoded neighbours only.

Blob: u8 version (2), u16 ny, then the rANS byte stream (32-bit state, 12-bit probabilities, byte renormalisation,
first four bytes = initial state, little endian).
"""
from __future__ import annotations

import math
import struct
from collections import defaultdict

import numpy as np

CHUNK = 32
PAD = 1
SPAN = CHUNK + 2 * PAD
COLUMNS = SPAN * SPAN
VERSION = 2
PROB_BITS = 12
M = 1 << PROB_BITS
RANS_L = 1 << 23

# class ids (same as stream_build.py)
GROUND, ROAD, SIDEWALK, BUILDING, ROOF, WATER = 1, 2, 3, 4, 5, 8
# pattern id -> class sequence; the shapes handled without an explicit run list
PAT_EMPTY, PAT_GROUND, PAT_ROAD, PAT_SIDEWALK, PAT_BLDG_ROOF, PAT_WATER, PAT_BLDG, PAT_ROOF, PAT_EXOTIC = range(9)
SURFACE_CLASS = {PAT_ROAD: 2, PAT_SIDEWALK: 3, PAT_WATER: 8}
PATTERN_OF = {(): PAT_EMPTY, (1,): PAT_GROUND, (1, 2): PAT_ROAD, (1, 3): PAT_SIDEWALK, (1, 4, 5): PAT_BLDG_ROOF,
              (1, 8): PAT_WATER, (1, 4): PAT_BLDG, (1, 5): PAT_ROOF}
OUTSIDE = 9           # pattern id of a neighbour outside the chunk

# tables: id -> (contexts, alphabet)
T_PAT, T_S, T_BSEL, T_BVAL, T_XN, T_XC, T_XL = range(7)
TABLES = [(400, 9), (175, 25), (16, 4), (1, 25), (1, 25), (14, 13), (13, 25)]
LEVELS = 7
# levels pooled for training (the top levels have too few chunks of their own)
TRAIN_GROUP = [0, 1, 2, 3, 4, 4, 4]
GROUPS = 5            # models stored: levels 0-3 and one shared by 4-6


def vsym(v: int) -> tuple[int, int, int]:
    """v >= 0 -> (symbol, mantissa bits, mantissa): 0-11 direct, then one symbol per power of two."""
    if v < 12:
        return v, 0, 0
    k = v.bit_length() - 1
    return 12 + (k - 3), k, v - (1 << k)


def zigzag(d: int) -> int:
    return 2 * d if d >= 0 else -2 * d - 1


def unzigzag(z: int) -> int:
    return z >> 1 if not z & 1 else -((z + 1) >> 1)


def column_runs(win: np.ndarray) -> tuple[int, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(ny, SPAN, SPAN) -> ny (top of the highest solid cell) and, per column, its runs: counts, classes, lengths.
    A column is its runs bottom up; whatever is above the last solid cell is not a run."""
    ny = win.shape[0]
    top = int(np.nonzero(win.reshape(ny, -1).any(axis=1))[0].max()) + 1 if win.any() else 0
    cols = np.ascontiguousarray(win[:top].reshape(top, -1).T)
    nonair = cols != 0
    last = top - np.argmax(nonair[:, ::-1], axis=1)
    last[~nonair.any(axis=1)] = 0
    start = np.empty(cols.shape, bool)
    start[:, 0] = True
    start[:, 1:] = cols[:, 1:] != cols[:, :-1]
    start &= np.arange(top)[None, :] < last[:, None]
    counts = start.sum(axis=1)
    pos = np.nonzero(start.ravel())[0]
    col, y = pos // top, pos % top
    cls = cols.ravel()[pos]
    same = np.r_[col[1:] == col[:-1], False]
    length = np.where(same, np.r_[y[1:], 0], last[col]) - y
    return top, counts, cls, length, last


def symbolize(win: np.ndarray) -> tuple[int, list[tuple[int, int, int]]]:
    """Window -> (ny, ops). An op is (table, context, symbol), or (-1, bits, value) for `bits` raw bits."""
    ny, counts, cls, length, _ = column_runs(win)
    ops: list[tuple[int, int, int]] = []
    P = [[OUTSIDE] * (SPAN + 2) for _ in range(SPAN + 1)]      # pattern ids, row 0 and columns 0 / SPAN+1 are outside
    Sg = [[0] * (SPAN + 2) for _ in range(SPAN + 1)]
    Bh = [[0] * (SPAN + 2) for _ in range(SPAN + 1)]
    cl = cls.tolist()
    ln = length.tolist()
    cnt = counts.tolist()
    at = 0

    def emit_v(tid: int, ctx: int, v: int) -> None:
        sym, nb, man = vsym(v)
        ops.append((tid, ctx, sym))
        if nb:
            if nb > PROB_BITS:
                ops.append((-1, nb - PROB_BITS, man >> PROB_BITS))
                ops.append((-1, PROB_BITS, man & (M - 1)))
            else:
                ops.append((-1, nb, man))

    for z in range(SPAN):
        Z = z + 1
        for x in range(SPAN):
            X = x + 1
            n = cnt[z * SPAN + x]
            c = tuple(cl[at:at + n])
            l = ln[at:at + n]
            at += n
            pid = PATTERN_OF.get(c, PAT_EXOTIC)
            if pid in (PAT_ROAD, PAT_SIDEWALK, PAT_WATER, PAT_ROOF) and l[1] != 1:
                pid = PAT_EXOTIC
            elif pid == PAT_BLDG_ROOF and l[2] != 1:
                pid = PAT_EXOTIC
            pl, pu, pul, pur = P[Z][X - 1], P[Z - 1][X], P[Z - 1][X - 1], P[Z - 1][X + 1]
            ops.append((T_PAT, ((pl * 10 + pu) * 2 + (pul == pu)) * 2 + (pur == pu), pid))
            P[Z][X] = pid
            if pid == PAT_EMPTY:
                continue
            if x > 0:
                sl = Sg[Z][X - 1]
                su = Sg[Z - 1][X] if z > 0 else sl
                sul = Sg[Z - 1][X - 1] if z > 0 else sl
            elif z > 0:
                sl = su = sul = Sg[Z - 1][X]
            else:
                sl = su = sul = 0
            pred = min(max(sl + su - sul, min(sl, su)), max(sl, su))
            if pid == PAT_EXOTIC:
                emit_v(T_XN, 0, n - 1)
                prev = 13
                for k in range(n):
                    ops.append((T_XC, prev, c[k]))
                    emit_v(T_XL, c[k], l[k] - 1)
                    prev = c[k]
                Sg[Z][X] = l[0] if c and c[0] == GROUND else pred
                continue
            s = l[0]
            emit_v(T_S, ((max(-2, min(2, sl - sul)) + 2) * 5 + max(-2, min(2, su - sul)) + 2) * 7 + pid - 1, zigzag(s - pred))
            Sg[Z][X] = s
            if pid in (PAT_BLDG_ROOF, PAT_BLDG):
                b = l[1]
                bl, bu, bur = Bh[Z][X - 1], Bh[Z - 1][X], Bh[Z - 1][X + 1]
                sel = 0 if (bl and b == bl) else 1 if (bu and b == bu) else 2 if (bur and b == bur) else 3
                ops.append((T_BSEL, (((bl > 0) * 2 + (bu > 0)) * 4) + (pl == pid) * 2 + (pu == pid), sel))
                if sel == 3:
                    emit_v(T_BVAL, 0, b - 1)
                Bh[Z][X] = b
    return ny, ops


def run_list(pid: int, s: int, b: int) -> list[tuple[int, int]]:
    if pid == PAT_GROUND:
        return [(GROUND, s)]
    if pid in SURFACE_CLASS:
        return [(GROUND, s), (SURFACE_CLASS[pid], 1)]
    if pid == PAT_BLDG_ROOF:
        return [(GROUND, s), (BUILDING, b), (ROOF, 1)]
    if pid == PAT_BLDG:
        return [(GROUND, s), (BUILDING, b)]
    return [(GROUND, s), (ROOF, 1)]


# ----------------------------------------------------------------------------- model

class Model:
    """freq[level][table][ctx] = list of A frequencies summing to M."""

    def __init__(self, freq: list[list[list[list[int]]]]):
        self.freq = freq
        self.cum = [[[np.concatenate([[0], np.cumsum(f)]).tolist() for f in t] for t in lv] for lv in freq]

    def to_bytes(self) -> bytes:
        out = bytearray()
        for lv in self.freq[:GROUPS]:
            for t in lv:
                for f in t:
                    out += struct.pack(f'<{len(f)}H', *f)
        return bytes(out)

    @staticmethod
    def from_bytes(raw: bytes) -> "Model":
        at = 0
        freq = []
        for _ in range(GROUPS):
            lv = []
            for ctxs, alpha in TABLES:
                t = []
                for _c in range(ctxs):
                    t.append(list(struct.unpack_from(f'<{alpha}H', raw, at)))
                    at += 2 * alpha
                lv.append(t)
            freq.append(lv)
        return Model(freq + [freq[min(g, GROUPS - 1)] for g in range(GROUPS, LEVELS)])


MODEL_BYTES = GROUPS * sum(c * a for c, a in TABLES) * 2


def normalise(counts: np.ndarray) -> list[int]:
    """Counts -> frequencies summing to exactly M, each at least 1, smoothed so any symbol is encodable anywhere."""
    p = counts + 0.25
    f = np.maximum(1, np.round(p / p.sum() * M)).astype(np.int64)
    d = M - int(f.sum())
    order = np.argsort(-f)
    i = 0
    while d != 0:
        j = order[i % len(order)]
        step = 1 if d > 0 else -1
        if f[j] + step >= 1:
            f[j] += step
            d -= step
        i += 1
    return f.tolist()


class Counts:
    def __init__(self) -> None:
        self.c = [[np.zeros((ctxs, alpha), np.int64) for ctxs, alpha in TABLES] for _ in range(LEVELS)]

    def add(self, level: int, ops: list[tuple[int, int, int]]) -> None:
        for tid, ctx, sym in ops:
            if tid >= 0:
                self.c[level][tid][ctx, sym] += 1

    def merge(self, other: "Counts") -> None:
        for a, b in zip(self.c, other.c):
            for x, y in zip(a, b):
                x += y

    def model(self) -> Model:
        pooled = [[np.zeros_like(t) for t in lv] for lv in self.c]
        for lvl, g in enumerate(TRAIN_GROUP):
            for t in range(len(TABLES)):
                pooled[g][t] += self.c[lvl][t]
        freq = []
        for lvl in range(LEVELS):
            g = TRAIN_GROUP[lvl]
            freq.append([[normalise(row) for row in pooled[g][t]] for t in range(len(TABLES))])
        return Model(freq)


# ----------------------------------------------------------------------------- rANS

def rans_encode(ops: list[tuple[int, int, int]], model: Model, level: int) -> bytes:
    cum = model.cum[level]
    freq = model.freq[level]
    x = RANS_L
    out = bytearray()
    for tid, a, b in reversed(ops):
        if tid < 0:                           # `a` raw bits holding value b
            f = 1 << (PROB_BITS - a)
            start = b << (PROB_BITS - a)
        else:
            f = freq[tid][a][b]
            start = cum[tid][a][b]
        x_max = ((RANS_L >> PROB_BITS) << 8) * f
        while x >= x_max:
            out.append(x & 0xFF)
            x >>= 8
        x = ((x // f) << PROB_BITS) + (x % f) + start
    out += struct.pack('<I', x)[::-1]          # reversed below, so the state comes out first, little endian
    return bytes(out[::-1])


class Reader:
    def __init__(self, buf: bytes, model: Model, level: int):
        self.buf = buf
        self.pos = 4
        self.x = struct.unpack_from('<I', buf, 0)[0]
        self.cum = model.cum[level]
        self.freq = model.freq[level]

    def _norm(self) -> None:
        while self.x < RANS_L:
            self.x = (self.x << 8) | self.buf[self.pos]
            self.pos += 1

    def sym(self, tid: int, ctx: int) -> int:
        slot = self.x & (M - 1)
        cum = self.cum[tid][ctx]
        s = 0
        while cum[s + 1] <= slot:
            s += 1
        self.x = self.freq[tid][ctx][s] * (self.x >> PROB_BITS) + slot - cum[s]
        self._norm()
        return s

    def raw(self, nb: int) -> int:
        slot = self.x & (M - 1)
        v = slot >> (PROB_BITS - nb)
        self.x = (1 << (PROB_BITS - nb)) * (self.x >> PROB_BITS) + slot - (v << (PROB_BITS - nb))
        self._norm()
        return v

    def value(self, tid: int, ctx: int) -> int:
        s = self.sym(tid, ctx)
        if s < 12:
            return s
        k = s - 12 + 3
        if k > PROB_BITS:
            hi = self.raw(k - PROB_BITS)
            lo = self.raw(PROB_BITS)
            return (1 << k) + (hi << PROB_BITS) + lo
        return (1 << k) + self.raw(k)


def encode_blob(win: np.ndarray, model: Model, level: int) -> tuple[bytes, int] | None:
    """(blob, ny), or None when the 32 x 32 interior is all air."""
    if not win[:, PAD:CHUNK + PAD, PAD:CHUNK + PAD].any():
        return None
    ny, ops = symbolize(win)
    return struct.pack('<BH', VERSION, ny) + rans_encode(ops, model, level), ny


def decode_blob(blob: bytes, model: Model, level: int) -> np.ndarray:
    """Reference decoder (the shipped one is format.ts decodeChunk): blob -> (ny, SPAN, SPAN) cells."""
    assert blob[0] == VERSION
    ny = struct.unpack_from('<H', blob, 1)[0]
    rd = Reader(blob[3:], model, level)
    cells = np.zeros((ny, SPAN, SPAN), np.uint8)
    P = [[OUTSIDE] * (SPAN + 2) for _ in range(SPAN + 1)]
    Sg = [[0] * (SPAN + 2) for _ in range(SPAN + 1)]
    Bh = [[0] * (SPAN + 2) for _ in range(SPAN + 1)]
    for z in range(SPAN):
        Z = z + 1
        for x in range(SPAN):
            X = x + 1
            pl, pu, pul, pur = P[Z][X - 1], P[Z - 1][X], P[Z - 1][X - 1], P[Z - 1][X + 1]
            pid = rd.sym(T_PAT, ((pl * 10 + pu) * 2 + (pul == pu)) * 2 + (pur == pu))
            P[Z][X] = pid
            if pid == PAT_EMPTY:
                continue
            if x > 0:
                sl = Sg[Z][X - 1]
                su = Sg[Z - 1][X] if z > 0 else sl
                sul = Sg[Z - 1][X - 1] if z > 0 else sl
            elif z > 0:
                sl = su = sul = Sg[Z - 1][X]
            else:
                sl = su = sul = 0
            pred = min(max(sl + su - sul, min(sl, su)), max(sl, su))
            if pid == PAT_EXOTIC:
                n = rd.value(T_XN, 0) + 1
                runs = []
                prev = 13
                for _ in range(n):
                    c = rd.sym(T_XC, prev)
                    runs.append((c, rd.value(T_XL, c) + 1))
                    prev = c
                Sg[Z][X] = runs[0][1] if runs[0][0] == GROUND else pred
            else:
                s = pred + unzigzag(rd.value(T_S, ((max(-2, min(2, sl - sul)) + 2) * 5 + max(-2, min(2, su - sul)) + 2) * 7 + pid - 1))
                Sg[Z][X] = s
                b = 0
                if pid in (PAT_BLDG_ROOF, PAT_BLDG):
                    bl, bu, bur = Bh[Z][X - 1], Bh[Z - 1][X], Bh[Z - 1][X + 1]
                    sel = rd.sym(T_BSEL, (((bl > 0) * 2 + (bu > 0)) * 4) + (pl == pid) * 2 + (pu == pid))
                    b = bl if sel == 0 else bu if sel == 1 else bur if sel == 2 else rd.value(T_BVAL, 0) + 1
                    Bh[Z][X] = b
                runs = run_list(pid, s, b)
            y = 0
            for c, n in runs:
                if c:
                    cells[y:y + n, z, x] = c
                y += n
    return cells
