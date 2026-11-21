'use strict';

/*
 * 사진 안전 정리
 * - 모든 처리는 브라우저(폰) 안에서만. 네트워크로 사진을 보내지 않는다.
 * - 저장은 캔버스를 다시 인코딩해 EXIF/APP1/XMP를 통째로 없앤다.
 */

const MAX_CANVAS_PIXELS = 16000000;   // iOS Safari 캔버스 한계(약 16.7M px)보다 조금 여유
const MAX_CANVAS_SIDE = 4096;
const DISPLAY_RADII = { small: 12, medium: 22, large: 40 }; // 화면(CSS px) 기준 반지름
const JPEG_QUALITY = 0.92;

const els = {
  fileInput: document.getElementById('fileInput'),
  pickArea: document.getElementById('pickArea'),
  editor: document.getElementById('editor'),
  canvas: document.getElementById('canvas'),
  stageEmpty: document.getElementById('stageEmpty'),
  badge: document.getElementById('exifBadge'),
  badgeIcon: document.getElementById('badgeIcon'),
  badgeTitle: document.getElementById('badgeTitle'),
  badgeSub: document.getElementById('badgeSub'),
  badgeMore: document.getElementById('badgeMore'),
  badgeDetail: document.getElementById('badgeDetail'),
  thumbStrip: document.getElementById('thumbStrip'),
  imgMeta: document.getElementById('imgMeta'),
  undoBtn: document.getElementById('undoBtn'),
  resetBtn: document.getElementById('resetBtn'),
  saveBtn: document.getElementById('saveBtn'),
  shareBtn: document.getElementById('shareBtn'),
  status: document.getElementById('status'),
  styleBtns: Array.prototype.slice.call(document.querySelectorAll('[data-style]')),
  sizeBtns: Array.prototype.slice.call(document.querySelectorAll('[data-size]'))
};

const canvas = els.canvas;
const ctx = canvas.getContext('2d');

const state = {
  items: [],
  index: -1,
  style: 'mosaic',
  size: 'medium',
  stroke: null,
  drawing: false
};

/* ------------------------------------------------------------------ *
 * 작은 도우미들
 * ------------------------------------------------------------------ */

function setStatus(text, kind) {
  els.status.textContent = text || '';
  if (kind) els.status.setAttribute('data-kind', kind);
  else els.status.removeAttribute('data-kind');
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function current() {
  return state.index >= 0 ? state.items[state.index] || null : null;
}

/* ------------------------------------------------------------------ *
 * JPEG EXIF 스캐너 (읽기 전용 · 파일 안에서만)
 * ------------------------------------------------------------------ */

function readAscii(view, offset, length) {
  let s = '';
  const end = Math.min(view.byteLength, offset + length);
  for (let i = offset; i < end; i++) {
    const c = view.getUint8(i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function typeSize(type) {
  switch (type) {
    case 1: case 2: case 7: return 1;   // BYTE, ASCII, UNDEFINED
    case 3: return 2;                   // SHORT
    case 4: case 9: return 4;           // LONG, SLONG
    case 5: case 10: return 8;          // RATIONAL, SRATIONAL
    default: return 0;
  }
}

function readIfd(view, base, limit, offset, u16, u32) {
  const map = new Map();
  if (!(offset >= base && offset + 2 <= limit)) return map;
  const count = u16(offset);
  if (count > 512) return map;
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (entry + 12 > limit) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const num = u32(entry + 4);
    const unit = typeSize(type);
    const bytes = unit ? unit * num : 0;
    let valueOffset = entry + 8;
    let valueBytes = bytes;
    if (bytes > 4) {
      valueOffset = base + u32(entry + 8);
      valueBytes = bytes;
    }
    if (valueOffset < base || valueOffset + Math.min(valueBytes, 4) > limit) continue;
    map.set(tag, { type: type, count: num, offset: valueOffset, bytes: valueBytes });
  }
  return map;
}

function tagText(view, base, limit, ifd, tag) {
  const item = ifd.get(tag);
  if (!item) return '';
  const start = item.offset;
  const end = Math.min(start + item.bytes, limit);
  if (start >= end) return '';
  let out = '';
  if (item.type === 2) {
    for (let i = start; i < end; i++) {
      const c = view.getUint8(i);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
  } else if (item.type === 3) {
    out = String(view.getUint16(start, item._little));
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (/^[0-9]{4}:[0-9]{2}:[0-9]{2} [0-9]{2}:[0-9]{2}/.test(out)) {
    out = out.replace(/^([0-9]{4}):([0-9]{2}):([0-9]{2})/, '$1-$2-$3');
  }
  return out;
}

function parseTiff(view, base, length, out) {
  if (length < 8) return;
  const limit = base + length;
  const order = view.getUint16(base, false);
  let little;
  if (order === 0x4949) little = true;
  else if (order === 0x4d4d) little = false;
  else return;

  const u16 = function (o) { return view.getUint16(o, little); };
  const u32 = function (o) { return view.getUint32(o, little); };

  if (u16(base + 2) !== 0x002a) return;
  const ifd0Offset = base + u32(base + 4);
  if (!(ifd0Offset >= base && ifd0Offset + 2 <= limit)) return;

  const ifd0 = readIfd(view, base, limit, ifd0Offset, u16, u32);
  ifd0.forEach(function (v) { v._little = little; });

  out.make = tagText(view, base, limit, ifd0, 0x010f);      // Make
  out.model = tagText(view, base, limit, ifd0, 0x0110);     // Model
  out.orientation = tagText(view, base, limit, ifd0, 0x0112);
  out.software = tagText(view, base, limit, ifd0, 0x0131);   // Software
  out.dateTime = tagText(view, base, limit, ifd0, 0x0132);   // DateTime

  const exifPointer = ifd0.get(0x8769);
  if (exifPointer) {
    const exifIfdOffset = base + readIfdValue32(view, ifd0, exifPointer, little);
    const exifIfd = readIfd(view, base, limit, exifIfdOffset, u16, u32);
    exifIfd.forEach(function (v) { v._little = little; });
    const original = tagText(view, base, limit, exifIfd, 0x9003);      // DateTimeOriginal
    const digitized = tagText(view, base, limit, exifIfd, 0x9004);     // DateTimeDigitized
    const lens = tagText(view, base, limit, exifIfd, 0xa434);          // LensModel
    const subsec = tagText(view, base, limit, exifIfd, 0x9291);
    out.dateTime = original || digitized || out.dateTime;
    if (lens) out.lens = lens;
    if (subsec) out.subsec = subsec;
  }

  const gpsPointer = ifd0.get(0x8825);
  if (gpsPointer) {
    const gpsOffset = base + readIfdValue32(view, ifd0, gpsPointer, little);
    const gpsIfd = readIfd(view, base, limit, gpsOffset, u16, u32);
    const hasLat = gpsIfd.has(1) && gpsIfd.has(2);
    const hasLon = gpsIfd.has(3) && gpsIfd.has(4);
    if (hasLat && hasLon) out.gps = true;
    if (gpsIfd.has(0x1d)) out.gpsDate = true; // GPSDateStamp
  }
}

function readIfdValue32(view, ifd, entry, little) {
  // 포인터 태그(LONG)의 값을 읽는다.
  if (!entry) return 0;
  try {
    if (entry.bytes >= 4 && entry.bytes <= 8) return view.getUint32(entry.offset, little);
    return view.getUint32(entry.offset, little);
  } catch (e) {
    return 0;
  }
}

function scanJpegMeta(buffer) {
  const out = {
    isJpeg: false,
    exif: false,
    xmp: false,
    gps: false,
    device: false,
    time: false,
    make: '',
    model: '',
    lens: '',
    software: '',
    dateTime: '',
    orientation: ''
  };

  let view;
  try { view = new DataView(buffer); } catch (e) { return out; }
  if (!view || view.byteLength < 4) return out;
  if (view.getUint16(0, false) !== 0xffd8) return out;
  out.isJpeg = true;

  const end = view.byteLength;
  let pos = 2;
  let guard = 0;

  while (pos + 4 <= end && guard++ < 600) {
    if (view.getUint8(pos) !== 0xff) { pos++; continue; }
    const marker = view.getUint8(pos + 1);
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // 이미지 데이터 시작

    if (pos + 4 > end) break;
    const length = view.getUint16(pos + 2, false);
    if (length < 2) break;
    const segStart = pos + 4;
    const segLength = length - 2;
    if (segStart + segLength > end) break;

    if (marker === 0xe1 && segLength >= 14) {
      const sig = readAscii(view, segStart, 6);
      if (sig === 'Exif' || sig.indexOf('Exif') === 0) {
        out.exif = true;
        try { parseTiff(view, segStart + 6, segLength - 6, out); } catch (e) { /* 손상된 EXIF는 무시 */ }
      } else {
        const head = readAscii(view, segStart, 40);
        if (head.indexOf('http://ns.adobe.com/xap') >= 0) {
          out.xmp = true;
          const text = readAscii(view, segStart, Math.min(segLength, 30000));
          if (/GPSLatitude|GPSLongitude|exif:GPS/i.test(text)) out.gps = true;
          if (/photoshop:City|photoshop:Country|Iptc4xmpCore:Location/i.test(text)) out.gps = true;
        }
      }
    }

    pos += 2 + length;
  }

  if (out.make || out.model || out.lens) out.device = true;
  if (out.dateTime || out.gpsDate) out.time = true;
  return out;
}

/* ------------------------------------------------------------------ *
 * 사진 불러오기
 * ------------------------------------------------------------------ */

function loadImage(url) {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error('decode-failed')); };
    img.decoding = 'sync';
    img.src = url;
  });
}

async function createItem(file) {
  const buffer = await file.arrayBuffer();
  const exif = scanJpegMeta(buffer);
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await loadImage(url);
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) {
    URL.revokeObjectURL(url);
    throw new Error('empty-image');
  }

  const scale = Math.min(
    1,
    MAX_CANVAS_SIDE / Math.max(w, h),
    Math.sqrt(MAX_CANVAS_PIXELS / (w * h))
  );
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  return {
    file: file,
    name: file.name || 'photo.jpg',
    size: file.size || 0,
    type: file.type || '',
    exif: exif,
    url: url,
    img: img,
    w: w,
    h: h,
    cw: cw,
    ch: ch,
    scaled: scale < 0.999,
    strokes: [],
    pixelCache: new Map(),
    version: 0,
    prepared: null,
    done: false
  };
}

async function addFiles(fileList) {
  const files = Array.prototype.slice.call(fileList || []).filter(function (f) {
    return f && (f.type.indexOf('image/') === 0 || /\.(jpe?g|png|heic|heif|webp|gif|bmp)$/i.test(f.name || ''));
  });
  if (!files.length) {
    setStatus('이미지 파일이 아니에요. 사진을 골라 주세요.', 'err');
    return;
  }

  setStatus(files.length > 1 ? files.length + '장을 여는 중…' : '사진을 여는 중…', 'busy');

  let added = 0;
  let firstAdded = -1;
  const failed = [];
  for (const file of files) {
    try {
      const item = await createItem(file);
      if (firstAdded < 0) firstAdded = state.items.length;
      state.items.push(item);
      added++;
    } catch (err) {
      failed.push(file.name || '사진');
    }
  }

  if (!added) {
    setStatus('사진을 열 수 없어요. HEIC 원본은 아이폰 사진 앱에서 "복사 → JPEG"로 내보낸 뒤 다시 시도해 주세요.', 'err');
    return;
  }

  els.editor.classList.remove('hidden');
  els.pickArea.classList.add('compact');

  if (state.index < 0) selectItem(0);
  else if (firstAdded >= 0) selectItem(firstAdded);
  else renderThumbs();

  if (failed.length) {
    setStatus(added + '장을 열었어요. ' + failed.length + '장은 브라우저가 열 수 없는 형식이에요.', 'err');
  } else {
    setStatus(added + '장을 열었어요. 가릴 곳을 손가락으로 문질러 보세요.', 'ok');
  }
}

/* ------------------------------------------------------------------ *
 * 화면 · 썸네일 · 배지
 * ------------------------------------------------------------------ */

function selectItem(index) {
  if (index < 0 || index >= state.items.length) return;
  state.index = index;
  const item = state.items[index];

  canvas.width = item.cw;
  canvas.height = item.ch;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(item.img, 0, 0, item.cw, item.ch);

  replayStrokes(item);

  els.stageEmpty.classList.add('hidden');
  els.editor.classList.remove('hidden');
  els.pickArea.classList.add('compact');
  els.saveBtn.disabled = false;

  item.prepared = null;
  schedulePrepare(item);

  renderBadge(item);
  renderThumbs();
  renderMeta(item);
  updateUndo();

  setStatus('');
}

function renderMeta(item) {
  const parts = [];
  parts.push(item.w + '×' + item.h + 'px');
  parts.push(formatBytes(item.size));
  if (item.scaled) parts.push('처리 크기 ' + item.cw + '×' + item.ch + '(아주 큰 사진은 자동 축소)');
  els.imgMeta.textContent = parts.join(' · ');
}

function renderBadge(item) {
  const e = item.exif;
  els.badgeDetail.classList.add('hidden');
  els.badgeMore.classList.add('hidden');
  els.badgeMore.setAttribute('aria-expanded', 'false');

  const chips = [];
  if (e.gps) chips.push('위치(GPS)');
  if (e.device) chips.push(e.model ? '기기: ' + e.model : '기기 정보');
  if (e.time) chips.push('촬영 시각');
  if (e.software) chips.push('편집 앱');
  if (e.xmp) chips.push('XMP');

  if (chips.length) {
    els.badge.setAttribute('data-state', 'warn');
    els.badgeIcon.textContent = '⚠️';
    els.badgeTitle.textContent = '위치·기기 정보 감지됨 → 저장할 때 자동 삭제';
    els.badgeSub.textContent = chips.join(' · ');
    els.badgeMore.classList.remove('hidden');
    els.badgeDetail.innerHTML = buildDetail(item, chips);
  } else if (e.isJpeg) {
    els.badge.setAttribute('data-state', 'ok');
    els.badgeIcon.textContent = '✅';
    els.badgeTitle.textContent = '메타데이터 없음';
    els.badgeSub.textContent = '이 JPEG에는 위치·기기·촬영 정보가 들어 있지 않아요. 저장해도 그대로 깨끗합니다.';
  } else {
    els.badge.setAttribute('data-state', 'neutral');
    els.badgeIcon.textContent = 'ℹ️';
    els.badgeTitle.textContent = 'JPEG가 아닌 형식 — 저장하면 자동 정리';
    els.badgeSub.textContent = '저장할 때 캔버스로 다시 그리기 때문에 메타데이터가 남지 않습니다.';
  }
}

function buildDetail(item, chips) {
  const e = item.exif;
  const rows = [];
  rows.push(['파일', escapeHtml(item.name)]);
  rows.push(['크기', formatBytes(item.size) + ' · ' + item.w + '×' + item.h]);
  if (e.gps) rows.push(['위치(GPS)', '있음']);
  else rows.push(['위치(GPS)', '없음']);
  if (e.make || e.model) rows.push(['기기', escapeHtml([e.make, e.model].filter(Boolean).join(' '))]);
  if (e.lens) rows.push(['렌즈', escapeHtml(e.lens)]);
  if (e.dateTime) rows.push(['촬영 시각', escapeHtml(e.dateTime)]);
  if (e.software) rows.push(['소프트웨어', escapeHtml(e.software)]);
  if (e.xmp) rows.push(['XMP', '있음']);

  let html = '<dl>' + rows.map(function (r) {
    return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>';
  }).join('') + '</dl>';
  html += '<p>저장하면 이 항목이 모두 빠진 새 JPEG로 다시 만들어집니다(촬영 시각·기기·위치·편집 앱 기록 없음).</p>';
  return html;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function renderThumbs() {
  const strip = els.thumbStrip;
  if (state.items.length < 2) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }
  strip.classList.remove('hidden');
  strip.innerHTML = state.items.map(function (item, i) {
    return '<button class="thumb" type="button" role="tab" data-i="' + i + '"' +
      ' aria-selected="' + (i === state.index ? 'true' : 'false') + '"' +
      ' aria-label="' + (i + 1) + '번째 사진' + (item.done ? ' (저장함)' : '') + '">' +
      '<img src="' + item.url + '" alt="">' +
      '<span class="thumb-idx">' + (i + 1) + '</span>' +
      (item.done ? '<span class="thumb-done">✓</span>' : '') +
      '</button>';
  }).join('');
}

/* ------------------------------------------------------------------ *
 * 그리기 (모자이크 · 블러)
 * ------------------------------------------------------------------ */

let scratch = null;
function getScratch(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w);
    scratch.height = Math.max(scratch.height, h);
  }
  return scratch;
}

function getPixelCanvas(item, block) {
  const key = block;
  const cached = item.pixelCache.get(key);
  if (cached) return cached;

  const sw = Math.max(1, Math.ceil(item.cw / block));
  const sh = Math.max(1, Math.ceil(item.ch / block));
  const pc = document.createElement('canvas');
  pc.width = sw;
  pc.height = sh;
  const pctx = pc.getContext('2d');
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(item.img, 0, 0, sw, sh);
  item.pixelCache.set(key, pc);
  return pc;
}

function stamp(item, x, y, radius, style) {
  const block = Math.max(4, Math.round(radius / 3));
  const x0 = Math.max(0, Math.floor((x - radius) / block) * block);
  const y0 = Math.max(0, Math.floor((y - radius) / block) * block);
  const x1 = Math.min(item.cw, Math.ceil((x + radius) / block) * block);
  const y1 = Math.min(item.ch, Math.ceil((y + radius) / block) * block);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();

  if (style === 'blur') {
    const sc = getScratch(w, h);
    const sctx = sc.getContext('2d');
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    // 얇은 글씨도 남지 않게 충분히 흐리게(한 번에 큰 반경)
    ctx.filter = 'blur(' + Math.max(3, Math.round(radius / 1.7)) + 'px)';
    ctx.drawImage(sc, 0, 0, w, h, x0, y0, w, h);
    ctx.filter = 'none';
  } else {
    const pc = getPixelCanvas(item, block);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pc, x0 / block, y0 / block, w / block, h / block, x0, y0, w, h);
    ctx.imageSmoothingEnabled = true;
  }

  ctx.restore();
}

function paintSegment(item, a, b, radius, style) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const spacing = Math.max(2, radius * 0.4);
  const steps = Math.max(1, Math.min(160, Math.ceil(dist / spacing)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stamp(item, a[0] + dx * t, a[1] + dy * t, radius, style);
  }
}

function replayStrokes(item) {
  for (const stroke of item.strokes) {
    if (!stroke.pts.length) continue;
    stamp(item, stroke.pts[0][0], stroke.pts[0][1], stroke.radius, stroke.style);
    for (let i = 1; i < stroke.pts.length; i++) {
      paintSegment(item, stroke.pts[i - 1], stroke.pts[i], stroke.radius, stroke.style);
    }
  }
}

function brushRadiusCanvas() {
  const rect = canvas.getBoundingClientRect();
  const display = DISPLAY_RADII[state.size] || DISPLAY_RADII.medium;
  const perCss = canvas.width / Math.max(1, rect.width);
  return Math.max(2, display * perCss);
}

function toCanvasPoint(ev) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / Math.max(1, rect.width);
  const sy = canvas.height / Math.max(1, rect.height);
  return [
    clamp((ev.clientX - rect.left) * sx, 0, canvas.width),
    clamp((ev.clientY - rect.top) * sy, 0, canvas.height)
  ];
}

/* ------------------------------------------------------------------ *
 * 포인터 이벤트 — 아이폰에서 화면이 스크롤되지 않게
 * ------------------------------------------------------------------ */

function onPointerDown(ev) {
  const item = current();
  if (!item) return;
  if (state.drawing) return; // 두 번째 손가는 무시(한 손가락으로만 칠하기)
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;

  ev.preventDefault();
  try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 무시 */ }

  state.drawing = true;
  const p = toCanvasPoint(ev);
  const radius = brushRadiusCanvas();
  state.stroke = { style: state.style, radius: radius, pts: [p] };
  stamp(item, p[0], p[1], radius, state.style);
}

function onPointerMove(ev) {
  if (!state.drawing || !state.stroke) return;
  const item = current();
  if (!item) return;
  ev.preventDefault();

  const events = (typeof ev.getCoalescedEvents === 'function') ? ev.getCoalescedEvents() : null;
  const list = events && events.length ? events : [ev];
  const stroke = state.stroke;

  for (let i = 0; i < list.length; i++) {
    const p = toCanvasPoint(list[i]);
    const last = stroke.pts[stroke.pts.length - 1];
    const dx = p[0] - last[0];
    const dy = p[1] - last[1];
    if (Math.sqrt(dx * dx + dy * dy) < stroke.radius * 0.3) continue;
    paintSegment(item, last, p, stroke.radius, stroke.style);
    stroke.pts.push(p);
    if (stroke.pts.length > 1200) break; // 안전장치
  }
}

function onPointerUp(ev) {
  if (!state.drawing || !state.stroke) return;
  state.drawing = false;
  const item = current();
  const stroke = state.stroke;
  state.stroke = null;
  try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 무시 */ }
  if (!item) return;
  if (stroke.pts.length) {
    item.strokes.push(stroke);
    item.done = false;
    renderThumbs();
    updateUndo();
    bumpVersion(item);
  }
}

canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
canvas.addEventListener('pointermove', onPointerMove, { passive: false });
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('pointerleave', function (ev) {
  if (ev.pointerType === 'mouse') onPointerUp(ev);
});
canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

/* ------------------------------------------------------------------ *
 * 도구 버튼
 * ------------------------------------------------------------------ */

function updateUndo() {
  const item = current();
  const has = !!(item && item.strokes.length);
  els.undoBtn.disabled = !has;
  els.resetBtn.disabled = !has;
}

els.styleBtns.forEach(function (btn) {
  btn.addEventListener('click', function () {
    state.style = btn.getAttribute('data-style');
    els.styleBtns.forEach(function (b) {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  });
});

els.sizeBtns.forEach(function (btn) {
  btn.addEventListener('click', function () {
    state.size = btn.getAttribute('data-size');
    els.sizeBtns.forEach(function (b) {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  });
});

els.undoBtn.addEventListener('click', function () {
  const item = current();
  if (!item || !item.strokes.length) return;
  item.strokes.pop();
  item.done = false;
  selectItem(state.index);
  bumpVersion(item);
  setStatus('한 단계 되돌렸어요.', 'ok');
});

els.resetBtn.addEventListener('click', function () {
  const item = current();
  if (!item || !item.strokes.length) return;
  item.strokes = [];
  item.done = false;
  selectItem(state.index);
  bumpVersion(item);
  setStatus('원본으로 되돌렸어요.', 'ok');
});

els.thumbStrip.addEventListener('click', function (ev) {
  const btn = ev.target.closest('.thumb');
  if (!btn) return;
  const i = parseInt(btn.getAttribute('data-i'), 10);
  if (!isNaN(i) && i !== state.index) selectItem(i);
});

els.badgeMore.addEventListener('click', function () {
  const open = els.badgeMore.getAttribute('aria-expanded') === 'true';
  els.badgeMore.setAttribute('aria-expanded', open ? 'false' : 'true');
  els.badgeDetail.classList.toggle('hidden', open);
});

els.fileInput.addEventListener('change', function (ev) {
  const files = ev.target.files;
  addFiles(files).then(function () {
    els.fileInput.value = '';
  });
});

/* ------------------------------------------------------------------ *
 * 내보내기 — 캔버스 재인코딩으로 EXIF 100% 제거 + 검증
 * ------------------------------------------------------------------ */

function outputName(item) {
  const base = (item.name || 'photo').replace(/\.[^.]+$/, '');
  return (base || 'photo') + '-clean.jpg';
}

function canvasToBlob() {
  return new Promise(function (resolve, reject) {
    try {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('toBlob-failed'));
      }, 'image/jpeg', JPEG_QUALITY);
    } catch (err) {
      reject(err);
    }
  });
}

async function makeCleanImage(item) {
  const blob = await canvasToBlob();
  const buffer = await blob.arrayBuffer();
  const check = scanJpegMeta(buffer);
  const leftovers = [];
  if (check.gps) leftovers.push('위치');
  if (check.device) leftovers.push('기기');
  if (check.time) leftovers.push('촬영시각');
  if (check.exif) leftovers.push('EXIF 블록');
  return { blob: blob, check: check, leftovers: leftovers };
}

/*
 * 공유는 사파리에서 "탭한 그 순간"에 navigator.share를 불러야 한다.
 * 그래서 편집이 멈추면 미리 EXIF 제거본을 만들어 두고, 공유 버튼에서는
 * 기다림 없이 그 파일을 넘긴다.
 */
let prepareTimer = null;

function bumpVersion(item) {
  item.version = (item.version || 0) + 1;
  item.prepared = null;
  schedulePrepare(item);
}

function schedulePrepare(item) {
  if (prepareTimer) clearTimeout(prepareTimer);
  prepareTimer = setTimeout(function () {
    prepareTimer = null;
    prepare(item);
  }, 350);
}

async function prepare(item) {
  if (current() !== item || state.drawing) return;
  const version = item.version || 0;
  if (item.prepared && item.prepared.version === version) return;
  try {
    const result = await makeCleanImage(item);
    if (current() !== item || (item.version || 0) !== version) return;
    item.prepared = {
      version: version,
      blob: result.blob,
      check: result.check,
      leftovers: result.leftovers
    };
  } catch (err) {
    /* 준비 실패는 버튼을 눌렀을 때 다시 시도한다 */
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(function () {
    try { a.remove(); } catch (e) { /* 무시 */ }
    URL.revokeObjectURL(url);
  }, 30000);
}

function markDone(item) {
  item.done = true;
  renderThumbs();
}

function freshResult(item) {
  const version = item.version || 0;
  if (item.prepared && item.prepared.version === version) return item.prepared;
  return null;
}

els.saveBtn.addEventListener('click', async function () {
  const item = current();
  if (!item) return;
  els.saveBtn.disabled = true;
  setStatus('메타데이터를 지워 저장하는 중…', 'busy');
  try {
    const result = freshResult(item) || await makeCleanImage(item);
    const name = outputName(item);
    download(result.blob, name);

    if (result.leftovers.length) {
      setStatus('저장했지만 확인이 필요해요: ' + result.leftovers.join(', ') + ' 항목이 남았습니다.', 'err');
    } else {
      markDone(item);
      const bits = ['저장 완료 · ' + formatBytes(result.blob.size), 'EXIF ' + (result.check.exif ? '1' : '0') + '건',
        '위치 ' + (result.check.gps ? '1' : '0') + '건', '기기 ' + (result.check.device ? '1' : '0') + '건'];
      setStatus(bits.join(' · ') + '\n사진 앱의 "파일"에 저장되거나 다운로드 목록에 나타납니다.', 'ok');
    }
  } catch (err) {
    setStatus('저장에 실패했어요: ' + (err && err.message ? err.message : '알 수 없는 오류') + '\n다시 시도하거나 다른 사진으로 확인해 주세요.', 'err');
  } finally {
    els.saveBtn.disabled = false;
  }
});

if (typeof navigator.share === 'function') {
  els.shareBtn.classList.remove('hidden');
}

async function shareResult(item, result) {
  const file = new File([result.blob], outputName(item), { type: 'image/jpeg' });
  if (navigator.canShare && !navigator.canShare({ files: [file] })) {
    download(result.blob, outputName(item));
    setStatus('이 브라우저는 파일 공유를 지원하지 않아 다운로드로 저장했어요.', 'err');
    return;
  }
  // 사용자 탭 직후(await 전)에 호출되어야 아이폰 공유 시트가 열린다.
  await navigator.share({ files: [file], title: '사진' });
  markDone(item);
  if (result.leftovers.length) {
    setStatus('공유했지만 ' + result.leftovers.join(', ') + ' 항목이 남았습니다.', 'err');
  } else {
    setStatus('공유 완료 · 위치·기기 정보 0건 확인', 'ok');
  }
}

els.shareBtn.addEventListener('click', async function () {
  const item = current();
  if (!item) return;

  const ready = freshResult(item);
  if (ready) {
    els.shareBtn.disabled = true;
    try {
      await shareResult(item, ready);
    } catch (err) {
      if (err && err.name === 'AbortError') setStatus('공유를 취소했어요.', '');
      else setStatus('공유에 실패했어요. 저장 버튼을 이용해 주세요.', 'err');
    } finally {
      els.shareBtn.disabled = false;
    }
    return;
  }

  // 아직 준비 전이면: 만들어 두고 한 번 더 눌러 달라고 안내
  els.shareBtn.disabled = true;
  setStatus('공유할 사진을 준비하는 중…', 'busy');
  try {
    await prepare(item);
    const after = freshResult(item);
    if (after) setStatus('준비됐어요. 공유 버튼을 한 번 더 눌러 주세요.', 'ok');
    else setStatus('공유 준비에 실패했어요. 저장 버튼을 이용해 주세요.', 'err');
  } finally {
    els.shareBtn.disabled = false;
  }
});

/* ------------------------------------------------------------------ *
 * 서비스 워커 (오프라인)
 * ------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () { /* 오프라인 캐시는 있으면 좋은 정도 */ });
  });
}


