"""Procedural generator of top-down parking-lot images with exact slot labels.

Each call to ``render_scene`` draws a lot (ground, painted slot lines, cars,
distractors, lighting, camera effects) and returns the image plus every slot's
quadrilateral and ground-truth occupancy. ``slot_patches`` then cuts slot crops
with deliberate ROI misalignment, like a hand-configured ROI would have.

Designed to cover the scale-model use case (cardboard/paper ground, toy cars)
as well as real asphalt/concrete lots seen from above.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

# ------------------------------------------------------------------ palettes (BGR)
REAL_CAR_COLORS = [
    (235, 235, 235), (245, 245, 240), (190, 190, 190), (160, 160, 165), (120, 120, 125),
    (60, 60, 60), (25, 25, 28), (40, 40, 170), (30, 30, 120), (150, 80, 30), (110, 50, 20),
    (60, 90, 40), (80, 150, 200), (40, 140, 220), (160, 175, 190), (90, 70, 60),
]
TOY_CAR_COLORS = [
    (0, 0, 220), (0, 200, 255), (0, 140, 255), (200, 80, 0), (50, 180, 40), (180, 0, 160),
    (255, 160, 0), (20, 20, 20), (240, 240, 240), (0, 230, 230), (120, 0, 0),
]
LINE_COLORS = [(240, 240, 240), (225, 225, 220), (0, 200, 240), (0, 170, 220), (30, 30, 30), (40, 40, 200)]


@dataclass
class Slot:
    quad: np.ndarray  # 4x2 float32 corners in image coords
    occupied: bool


# ------------------------------------------------------------------ helpers


def smooth_noise(rng, h, w, scale, amp):
    """Low-frequency noise field in [-amp, amp]."""
    sh, sw = max(2, int(h / scale)), max(2, int(w / scale))
    small = rng.normal(0, 1, (sh, sw)).astype(np.float32)
    field = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    return field / (np.abs(field).max() + 1e-6) * amp


def jitter_color(rng, color, amount=18):
    return tuple(int(np.clip(c + rng.integers(-amount, amount + 1), 0, 255)) for c in color)


def make_ground(rng, h, w):
    kind = rng.choice(["asphalt", "concrete", "cardboard", "paper", "painted"], p=[0.3, 0.25, 0.25, 0.1, 0.1])
    if kind == "asphalt":
        base = rng.uniform(55, 120)
        img = np.full((h, w, 3), base, np.float32) + rng.normal(0, rng.uniform(4, 14), (h, w, 1))
        img += smooth_noise(rng, h, w, rng.uniform(20, 80), rng.uniform(4, 15))[..., None]
        tint = rng.uniform(-6, 6, 3)
    elif kind == "concrete":
        base = rng.uniform(140, 205)
        img = np.full((h, w, 3), base, np.float32) + rng.normal(0, rng.uniform(3, 9), (h, w, 1))
        img += smooth_noise(rng, h, w, rng.uniform(15, 60), rng.uniform(5, 18))[..., None]
        tint = rng.uniform(-5, 8, 3)
        # expansion-joint seams (a common false "edge" source)
        step = int(rng.uniform(0.08, 0.35) * w)
        seam = rng.uniform(20, 60)
        for x in range(int(rng.uniform(0, step)), w, step):
            cv2.line(img, (x, 0), (x, h), (base - seam,) * 3, 1)
        for y in range(int(rng.uniform(0, step)), h, step):
            cv2.line(img, (0, y), (w, y), (base - seam,) * 3, 1)
    elif kind == "cardboard":
        b, g, r = rng.uniform(85, 135), rng.uniform(135, 175), rng.uniform(170, 215)
        img = np.empty((h, w, 3), np.float32)
        img[...] = (b, g, r)
        img += rng.normal(0, rng.uniform(2, 7), (h, w, 1))
        period = rng.uniform(6, 14)
        axis = rng.integers(0, 2)
        coord = np.arange(w if axis == 0 else h, dtype=np.float32)
        stripes = (np.sin(coord / period * 2 * math.pi) * rng.uniform(1, 5)).astype(np.float32)
        img += stripes[None, :, None] if axis == 0 else stripes[:, None, None]
        img += smooth_noise(rng, h, w, rng.uniform(30, 90), rng.uniform(3, 12))[..., None]
        tint = np.zeros(3)
    elif kind == "paper":
        base = rng.uniform(205, 245)
        img = np.full((h, w, 3), base, np.float32) + rng.normal(0, 3, (h, w, 1))
        img += smooth_noise(rng, h, w, 60, rng.uniform(3, 10))[..., None]
        tint = rng.uniform(-8, 4, 3)
    else:  # painted surface (green/blue/grey epoxy floor or coloured board)
        col = np.array(jitter_color(rng, [(80, 120, 70), (140, 110, 70), (110, 110, 110), (60, 90, 130)][rng.integers(0, 4)], 25), np.float32)
        img = np.empty((h, w, 3), np.float32)
        img[...] = col
        img += rng.normal(0, 4, (h, w, 1)) + smooth_noise(rng, h, w, 50, 10)[..., None]
        tint = np.zeros(3)
    return img + tint, str(kind)


def draw_car_layer(rng, length, width, toy: bool):
    """Render one top-down vehicle facing 'up' on an RGBA canvas. Returns (bgr, alpha)."""
    ss = 2  # supersample for anti-aliasing
    L, W = int(length * ss), int(width * ss)
    pad = int(0.25 * max(L, W))
    H, Wc = L + 2 * pad, W + 2 * pad
    bgr = np.zeros((H, Wc, 3), np.float32)
    alpha = np.zeros((H, Wc), np.float32)
    x0, y0, x1, y1 = pad, pad, pad + W, pad + L
    color = np.array(jitter_color(rng, (TOY_CAR_COLORS if toy else REAL_CAR_COLORS)[
        rng.integers(0, len(TOY_CAR_COLORS if toy else REAL_CAR_COLORS))]), np.float32)

    kind = rng.choice(["sedan", "hatch", "suv", "van", "pickup", "moto"], p=[0.34, 0.24, 0.2, 0.1, 0.08, 0.04])
    if kind == "moto":  # narrow, short vehicle, still OCCUPIED
        mw = int(W * rng.uniform(0.3, 0.45))
        ml = int(L * rng.uniform(0.45, 0.6))
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        x0, x1 = cx - mw // 2, cx + mw // 2
        y0, y1 = cy - ml // 2, cy + ml // 2
    radius = int(min(x1 - x0, y1 - y0) * rng.uniform(0.15, 0.4 if toy else 0.3))

    # body (rounded rectangle via thick lines + rect)
    def rrect(target, a, b, c, d, r, value):
        r = max(1, min(r, (c - a) // 2, (d - b) // 2))
        cv2.rectangle(target, (a + r, b), (c - r, d), value, -1)
        cv2.rectangle(target, (a, b + r), (c, d - r), value, -1)
        for cx, cy in ((a + r, b + r), (c - r, b + r), (a + r, d - r), (c - r, d - r)):
            cv2.circle(target, (cx, cy), r, value, -1)

    rrect(alpha, x0, y0, x1, y1, radius, 1.0)
    body = np.zeros_like(alpha)
    rrect(body, x0, y0, x1, y1, radius, 1.0)
    bgr[body > 0] = color

    # wheels peeking out at the sides (real cars) / visible wheels (toys)
    if kind != "moto":
        ww, wl = int((x1 - x0) * 0.1), int((y1 - y0) * 0.14)
        for wy in (y0 + int((y1 - y0) * 0.14), y1 - int((y1 - y0) * 0.14) - wl):
            for wx in (x0 - ww // 2, x1 - ww // 2):
                cv2.rectangle(bgr, (wx, wy), (wx + ww, wy + wl), (18, 18, 18), -1)
                cv2.rectangle(alpha, (wx, wy), (wx + ww, wy + wl), 1.0, -1)

    # lateral shading: highlight along centre, darker flanks
    xs = np.linspace(-1, 1, Wc, dtype=np.float32)
    shade = 1.0 + rng.uniform(0.05, 0.25) * (1 - xs ** 2) - rng.uniform(0.05, 0.2) * xs ** 4
    bgr *= shade[None, :, None]

    if kind != "moto":
        bw, bl = x1 - x0, y1 - y0
        glass = np.array(jitter_color(rng, (55, 45, 40) if rng.random() < 0.7 else (170, 150, 120), 15), np.float32)
        front = rng.uniform(0.18, 0.3)
        cab_len = {"sedan": 0.38, "hatch": 0.48, "suv": 0.55, "van": 0.7, "pickup": 0.3}[kind]
        m = int(bw * rng.uniform(0.1, 0.16))
        # windscreen, roof, rear window
        ws0, ws1 = y0 + int(bl * front), y0 + int(bl * (front + 0.12))
        rw0 = y0 + int(bl * (front + cab_len))
        rw1 = rw0 + int(bl * 0.08)
        cv2.rectangle(bgr, (x0 + m, ws0), (x1 - m, ws1), glass.tolist(), -1)
        if kind != "van":
            cv2.rectangle(bgr, (x0 + m, rw0), (x1 - m, min(rw1, y1 - 3)), glass.tolist(), -1)
        roof = (color * rng.uniform(0.85, 1.15)).clip(0, 255)
        cv2.rectangle(bgr, (x0 + m, ws1), (x1 - m, rw0), roof.tolist(), -1)
        if rng.random() < 0.15:  # sunroof
            cv2.rectangle(bgr, (x0 + 2 * m, ws1 + 4), (x1 - 2 * m, ws1 + int(bl * 0.12)), glass.tolist(), -1)
        if kind == "pickup":  # open bed
            cv2.rectangle(bgr, (x0 + m // 2, rw1 + 2), (x1 - m // 2, y1 - m // 2), (color * 0.55).tolist(), -1)
        # side windows as thin glass strips
        cv2.line(bgr, (x0 + m // 2, ws1), (x0 + m // 2, rw0), glass.tolist(), max(1, m // 3))
        cv2.line(bgr, (x1 - m // 2, ws1), (x1 - m // 2, rw0), glass.tolist(), max(1, m // 3))
        # mirrors, lights
        for mx in (x0 - m // 2, x1 - m // 3):
            cv2.rectangle(bgr, (mx, ws0), (mx + m // 2, ws0 + m // 2), (color * 0.7).tolist(), -1)
            cv2.rectangle(alpha, (mx, ws0), (mx + m // 2, ws0 + m // 2), 1.0, -1)
        lr = max(2, bw // 12)
        for lx in (x0 + bw // 5, x1 - bw // 5):
            cv2.circle(bgr, (lx, y0 + lr + 2), lr, (200, 240, 255), -1)
            cv2.circle(bgr, (lx, y1 - lr - 2), lr, (30, 30, 200), -1)
        if toy and rng.random() < 0.5:  # toy details: stripes / number decal
            cv2.line(bgr, ((x0 + x1) // 2, y0 + 3), ((x0 + x1) // 2, y1 - 3), (255, 255, 255), max(2, bw // 10))
    else:
        cv2.circle(bgr, ((x0 + x1) // 2, (y0 + y1) // 2), max(3, (x1 - x0) // 2), (30, 30, 30), -1)

    if rng.random() < 0.5:  # specular glint
        gx = int(rng.uniform(x0, x1))
        gy = int(rng.uniform(y0, y1))
        cv2.ellipse(bgr, (gx, gy), (max(2, W // 6), max(2, L // 10)), 0, 0, 360, (250, 250, 250), -1)

    bgr = cv2.GaussianBlur(bgr, (3, 3), 0)
    small = (Wc // ss, H // ss)
    return cv2.resize(bgr, small, interpolation=cv2.INTER_AREA), cv2.resize(alpha, small, interpolation=cv2.INTER_AREA)


def composite(img, layer_bgr, layer_alpha, center, angle_deg, shadow=None):
    h, w = layer_alpha.shape
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle_deg, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    rb = cv2.warpAffine(layer_bgr, M, (nw, nh), flags=cv2.INTER_LINEAR)
    ra = cv2.warpAffine(layer_alpha, M, (nw, nh), flags=cv2.INTER_LINEAR)
    x0, y0 = int(center[0] - nw / 2), int(center[1] - nh / 2)
    H, W = img.shape[:2]
    sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(W, x0 + nw), min(H, y0 + nh)
    if sx1 <= sx0 or sy1 <= sy0:
        return
    lx0, ly0 = sx0 - x0, sy0 - y0
    region = img[sy0:sy1, sx0:sx1]
    a = ra[ly0 : ly0 + sy1 - sy0, lx0 : lx0 + sx1 - sx0, None]
    if shadow is not None:  # soft drop shadow
        dx, dy, strength, blur = shadow
        sa = cv2.GaussianBlur(ra, (0, 0), blur)
        sa = np.roll(np.roll(sa, dy, 0), dx, 1)[ly0 : ly0 + sy1 - sy0, lx0 : lx0 + sx1 - sx0, None]
        region *= 1 - strength * sa
    region[:] = region * (1 - a) + rb[ly0 : ly0 + sy1 - sy0, lx0 : lx0 + sx1 - sx0] * a


def add_distractor(rng, img, quad):
    """Things that are NOT vehicles inside an empty slot (hard negatives)."""
    cx, cy = quad.mean(0)
    sw = np.linalg.norm(quad[1] - quad[0])
    sl = np.linalg.norm(quad[3] - quad[0])
    kind = rng.choice(["shadow", "stain", "arrow", "text", "stopper", "leaves", "manhole", "tape"])
    if kind == "shadow":
        pts = (quad.mean(0) + rng.normal(0, 0.35, (5, 2)) * [sw, sl]).astype(np.int32)
        mask = np.zeros(img.shape[:2], np.float32)
        cv2.fillPoly(mask, [pts], 1.0)
        mask = cv2.GaussianBlur(mask, (0, 0), rng.uniform(2, 8))
        img *= 1 - rng.uniform(0.2, 0.5) * mask[..., None]
    elif kind == "stain":
        for _ in range(rng.integers(1, 4)):
            c = (int(cx + rng.normal(0, sw / 4)), int(cy + rng.normal(0, sl / 4)))
            ax = (max(2, int(sw * rng.uniform(0.05, 0.25))), max(2, int(sw * rng.uniform(0.05, 0.2))))
            mask = np.zeros(img.shape[:2], np.float32)
            cv2.ellipse(mask, c, ax, rng.uniform(0, 180), 0, 360, 1.0, -1)
            mask = cv2.GaussianBlur(mask, (0, 0), 1.5)[..., None] * rng.uniform(0.15, 0.45)
            img[:] = img * (1 - mask) + np.float32(30) * mask
    elif kind == "arrow":
        col = LINE_COLORS[rng.integers(0, 3)]
        p0 = (int(cx), int(cy + sl * 0.25))
        p1 = (int(cx), int(cy - sl * 0.25))
        cv2.arrowedLine(img, p0, p1, col, max(2, int(sw * 0.06)), tipLength=0.35)
    elif kind == "text":
        txt = str(rng.integers(1, 99)) if rng.random() < 0.7 else rng.choice(["P", "EV", "S1", "S3", "VIP"])
        scale = sw / 45
        mask = np.zeros(img.shape[:2], np.uint8)  # putText needs 8-bit; draw a mask and blend
        cv2.putText(mask, txt, (int(cx - sw * 0.3), int(cy + sl * 0.1)), cv2.FONT_HERSHEY_SIMPLEX,
                    scale, 255, max(1, int(scale * 2)))
        m = (mask.astype(np.float32) / 255)[..., None]
        img[:] = img * (1 - m) + np.array(LINE_COLORS[rng.integers(0, 3)], np.float32) * m
    elif kind == "stopper":
        y = int(cy - sl * 0.38)
        cv2.rectangle(img, (int(cx - sw * 0.3), y), (int(cx + sw * 0.3), y + max(3, int(sl * 0.05))),
                      (rng.uniform(80, 200),) * 3, -1)
    elif kind == "leaves":
        for _ in range(rng.integers(3, 15)):
            c = (int(cx + rng.normal(0, sw / 3)), int(cy + rng.normal(0, sl / 3)))
            cv2.ellipse(img, c, (rng.integers(2, 6), rng.integers(1, 4)), rng.uniform(0, 180), 0, 360,
                        jitter_color(rng, (30, 90, 120), 30), -1)
    elif kind == "manhole":
        cv2.circle(img, (int(cx), int(cy)), int(sw * rng.uniform(0.15, 0.3)), (rng.uniform(40, 90),) * 3, -1)
    else:  # tape / pen marks on a model lot
        p0 = (int(cx + rng.normal(0, sw / 3)), int(cy + rng.normal(0, sl / 3)))
        p1 = (int(cx + rng.normal(0, sw / 3)), int(cy + rng.normal(0, sl / 3)))
        cv2.line(img, p0, p1, jitter_color(rng, (60, 160, 200), 60), rng.integers(1, 6))


# ------------------------------------------------------------------ scene


def render_scene(rng: np.random.Generator, occupancy_p: float | None = None):
    """Return (bgr_uint8_image, slots, meta)."""
    H = int(rng.choice([360, 480, 540, 720]))
    W = int(H * rng.uniform(1.3, 1.9))
    img, ground = make_ground(rng, H, W)
    toy = bool(rng.random() < (0.75 if ground in ("cardboard", "paper", "painted") else 0.1))
    occupancy_p = rng.uniform(0.3, 0.75) if occupancy_p is None else occupancy_p

    n_slots = int(rng.integers(5, 10))
    rows = int(rng.choice([1, 2], p=[0.4, 0.6]))
    slot_w = W * rng.uniform(0.75, 0.95) / n_slots
    slot_l = slot_w * rng.uniform(1.7, 2.6)
    if rows * slot_l > H * 0.92:
        slot_l = H * 0.92 / rows
        slot_w = min(slot_w, slot_l / 1.6)
    aisle = rng.uniform(0, 0.12) * H
    total_h = rows * slot_l + (rows - 1) * aisle
    ox = (W - n_slots * slot_w) / 2 + rng.uniform(-0.03, 0.03) * W
    oy = (H - total_h) / 2 + rng.uniform(-0.04, 0.04) * H

    line_col = LINE_COLORS[rng.integers(0, len(LINE_COLORS))]
    line_col = line_col if ground not in ("paper",) or line_col != (240, 240, 240) else (30, 30, 30)
    thick = max(1, int(slot_w * rng.uniform(0.03, 0.08)))
    style = rng.choice(["full", "T", "open_end", "double"], p=[0.45, 0.2, 0.25, 0.1])

    slots: list[Slot] = []
    for r in range(rows):
        y0 = oy + r * (slot_l + aisle)
        for i in range(n_slots):
            x0 = ox + i * slot_w
            quad = np.array([[x0, y0], [x0 + slot_w, y0], [x0 + slot_w, y0 + slot_l], [x0, y0 + slot_l]], np.float32)
            slots.append(Slot(quad, bool(rng.random() < occupancy_p)))
        # painted lines
        for i in range(n_slots + 1):
            x = int(ox + i * slot_w)
            ya, yb = int(y0), int(y0 + slot_l)
            if style == "T":
                ya = int(y0 + slot_l * 0.75) if r == 0 else ya
                yb = int(y0 + slot_l * 0.25) if r == 1 else yb
            if style == "double":
                cv2.line(img, (x - thick, ya), (x - thick, yb), line_col, thick)
                cv2.line(img, (x + thick, ya), (x + thick, yb), line_col, thick)
            else:
                cv2.line(img, (x, ya), (x, yb), line_col, thick)
        if style != "open_end":
            yb = int(y0 + slot_l) if r == 0 else int(y0)
            cv2.line(img, (int(ox), yb), (int(ox + n_slots * slot_w), yb), line_col, thick)

    # vehicles and distractors
    for idx, slot in enumerate(slots):
        q = slot.quad
        cx, cy = q.mean(0)
        if slot.occupied:
            # real cars are ~1.9-2.6x longer than wide; fit that inside the slot
            width = slot_w * rng.uniform(0.55, 0.88)
            length = min(width * rng.uniform(1.9, 2.6), slot_l * rng.uniform(0.75, 0.95))
            width = min(width, length / 1.7)
            if toy:
                s = rng.uniform(0.7, 1.0)
                length, width = length * s, width * s
            bgr, alpha = draw_car_layer(rng, length, width, toy)
            heading = 0 if rng.random() < 0.5 else 180
            angle = heading + rng.normal(0, 4)
            centre = (cx + rng.normal(0, 0.07) * slot_w, cy + rng.normal(0, 0.06) * slot_l)
            shadow = (int(rng.integers(-6, 7)), int(rng.integers(-6, 7)), rng.uniform(0.2, 0.55), rng.uniform(2, 6))
            composite(img, bgr.astype(np.float32), alpha, centre, angle, shadow)
        elif rng.random() < 0.45:
            add_distractor(rng, img, q)

    # neighbour overhang into empty slots: draw a car mostly outside the slot
    for idx, slot in enumerate(slots):
        if not slot.occupied and rng.random() < 0.08:
            q = slot.quad
            cx, cy = q.mean(0)
            bgr, alpha = draw_car_layer(rng, slot_l * 0.85, slot_w * 0.8, toy)
            side = 1 if rng.random() < 0.5 else -1
            composite(img, bgr.astype(np.float32), alpha, (cx + side * slot_w * rng.uniform(0.85, 1.0), cy), rng.normal(0, 3))

    # lighting
    gx = np.linspace(-1, 1, W, dtype=np.float32)[None, :]
    gy = np.linspace(-1, 1, H, dtype=np.float32)[:, None]
    a, b = rng.uniform(-0.25, 0.25, 2)
    light = 1 + a * gx + b * gy - rng.uniform(0, 0.25) * (gx ** 2 + gy ** 2)
    img *= light[..., None]
    img *= rng.uniform(0.85, 1.15, 3)  # white balance
    img = img * rng.uniform(0.7, 1.25) + rng.uniform(-20, 20)
    img = np.clip(img, 0, 255).astype(np.uint8)

    # camera: mild perspective + optional 90-degree rotation of the whole frame
    quads = np.stack([s.quad for s in slots])
    src = np.array([[0, 0], [W, 0], [W, H], [0, H]], np.float32)
    d = rng.uniform(0, 0.06, (4, 2)) * [W, H]
    dst = src + d * [[1, 1], [-1, 1], [-1, -1], [1, -1]]
    P = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
    border = tuple(int(v) for v in img[0, 0])
    img = cv2.warpPerspective(img, P, (W, H), borderMode=cv2.BORDER_REPLICATE)
    quads = cv2.perspectiveTransform(quads.reshape(-1, 1, 2), P).reshape(-1, 4, 2)
    k = int(rng.integers(0, 4))
    for _ in range(k):
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        h_prev = img.shape[1]  # after rotation width == previous height
        quads = np.stack([np.stack([h_prev - 1 - quads[..., 1], quads[..., 0]], -1)])[0]

    # sensor/compression effects
    if rng.random() < 0.4:
        img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.4, 1.5))
    if rng.random() < 0.4:
        img = np.clip(img + rng.normal(0, rng.uniform(2, 8), img.shape), 0, 255).astype(np.uint8)
    if rng.random() < 0.3:  # resolution loss
        f = rng.uniform(0.35, 0.7)
        small = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR)
    q = int(rng.uniform(40, 95))
    img = cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])[1], cv2.IMREAD_COLOR)

    for s, qd in zip(slots, quads):
        s.quad = qd.astype(np.float32)
    return img, slots, {"ground": ground, "toy": bool(toy), "border": border}


def slot_patches(rng, img, slots, size=128, misalign=0.08):
    """Axis-aligned crops around each slot with random ROI misalignment."""
    H, W = img.shape[:2]
    out = []
    for s in slots:
        x0, y0 = s.quad.min(0)
        x1, y1 = s.quad.max(0)
        w, h = x1 - x0, y1 - y0
        sx, sy = rng.uniform(1 - misalign, 1 + misalign * 1.5, 2)
        dx, dy = rng.normal(0, misalign / 2, 2) * [w, h]
        cx, cy = (x0 + x1) / 2 + dx, (y0 + y1) / 2 + dy
        hw, hh = w * sx / 2, h * sy / 2
        a0, b0 = int(max(0, cx - hw)), int(max(0, cy - hh))
        a1, b1 = int(min(W, cx + hw)), int(min(H, cy + hh))
        if a1 - a0 < 8 or b1 - b0 < 8:
            continue
        crop = cv2.resize(img[b0:b1, a0:a1], (size, size), interpolation=cv2.INTER_AREA)
        out.append((crop, s.occupied))
    return out
