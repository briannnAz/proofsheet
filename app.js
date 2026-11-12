"use strict";

const $ = s => document.querySelector(s);
const state = {
  photos: [],
  batches: [],
  filter: "all",
  filterStars: 0,
  filterColor: null,
  filterSubject: "",
  compareSet: new Set(),
  activeId: null,
  autoAdvance: true,
  continueSaved: false,
  carry: []
};

const COLORS = { red:"#F04E6B", yellow:"#FFC531", green:"#38C98A", blue:"#4DA3FF", purple:"#9B7BFF" };
const COLOR_NAMES = Object.keys(COLORS);
const focus10 = p => (p.focus / 10).toFixed(1);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fileInput = $("#file-input"), folderInput = $("#folder-input");

const RAW_EXTS = new Set(["cr2","cr3","nef","nrw","arw","srf","sr2","raf","orf","rw2","dng","pef","srw","raw","rwl","3fr","iiq","erf","kdc","mos","x3f"]);
const isRaw = name => RAW_EXTS.has(name.split(".").pop().toLowerCase());
const isImageFile = f => f.type.startsWith("image/") || isRaw(f.name);

const SPEED_KEY = "proofsheet_import_speed_v1";
const SPEED_PRESETS = { gentle: 1, balanced: 3, fast: 6 };

function getSpeedPreference() {
  try { return localStorage.getItem(SPEED_KEY) || "auto"; } catch { return "auto"; }
}
function setSpeedPreference(v) {
  try { localStorage.setItem(SPEED_KEY, v); } catch {  }
  $("#speed-select").value = v;
}
function computeConcurrency(fileCount) {
  const pref = getSpeedPreference();
  const n = pref === "auto"
    ? Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))
    : (SPEED_PRESETS[pref] || 3);
  return Math.max(1, Math.min(n, fileCount));
}
$("#speed-select").value = getSpeedPreference();
$("#speed-select").addEventListener("change", e => setSpeedPreference(e.target.value));

function formatDuration(ms) {
  if (!isFinite(ms) || ms < 0) return "0s";
  const s = ms / 1000;
  if (s < 60) return s < 10 ? s.toFixed(1) + "s" : Math.round(s) + "s";
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}m ${String(r).padStart(2,"0")}s`;
}

function findEmbeddedJpegs(u8) {
  const n = u8.length, found = [];
  let i = 0;
  while (i < n - 3) {
    if (u8[i] === 0xFF && u8[i+1] === 0xD8 && u8[i+2] === 0xFF) {
      const end = walkJpeg(u8, i, n);
      if (end) { found.push([i, end]); i = end; continue; }
    }
    i++;
  }
  return found.sort((a, b) => (b[1]-b[0]) - (a[1]-a[0]));
}

function walkJpeg(u8, start, n) {
  let p = start + 2;
  while (p < n - 1) {
    if (u8[p] !== 0xFF) return null;
    const m = u8[p+1];
    if (m === 0xD9) return p + 2;
    if (m === 0xD8) return null;
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
    if (p + 3 >= n) return null;
    const len = (u8[p+2] << 8) | u8[p+3];
    if (len < 2) return null;
    if (m === 0xDA) {
      p += 2 + len;
      while (p < n - 1) {
        if (u8[p] === 0xFF) {
          const m2 = u8[p+1];
          if (m2 === 0x00 || (m2 >= 0xD0 && m2 <= 0xD7)) { p += 2; continue; }
          break;
        }
        p++;
      }
      continue;
    }
    p += 2 + len;
  }
  return null;
}

async function rawToPreviewBlob(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  const jpegs = findEmbeddedJpegs(u8);
  for (const [s, e] of jpegs) {
    if (e - s < 20000) break;
    const blob = new Blob([u8.subarray(s, e)], { type: "image/jpeg" });
    try {

      const test = await createImageBitmap(blob, { resizeWidth: 32 }).catch(() => createImageBitmap(blob));
      test.close();

      const own = tiffOrientation(findExifTiff(u8.subarray(s, e)) || new Uint8Array(0));
      return { blob, rot: own ? 0 : (ORIENT_DEG[rawOrientation(u8)] || 0) };
    } catch {  }
  }
  throw new Error("No decodable preview found in RAW file");
}

async function analyze(file) {
  const raw = isRaw(file.name);
  let source = file, auto = 0;
  if (raw) { const r = await rawToPreviewBlob(file); source = r.blob; auto = r.rot; }

  let exifSubject = "";
  try {
    const srcBytes = new Uint8Array(await source.arrayBuffer());
    exifSubject = readExifSubject(srcBytes);
  } catch {  }

  const W = 256;
  let bmp;
  try {
    bmp = await createImageBitmap(source, { resizeWidth: W, resizeQuality: "medium" });
  } catch {

    const full = await createImageBitmap(source);
    const fh = Math.max(1, Math.round(full.height * (W / full.width)));
    const rc = document.createElement("canvas"); rc.width = W; rc.height = fh;
    rc.getContext("2d").drawImage(full, 0, 0, W, fh);
    full.close();
    bmp = await createImageBitmap(rc);
  }
  const H = bmp.height;

  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data;

  const g = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++)
    g[j] = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];

  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < H-1; y++) for (let x = 1; x < W-1; x++) {
    const c = y*W + x;
    const v = 4*g[c] - g[c-1] - g[c+1] - g[c-W] - g[c+W];
    sum += v; sum2 += v*v; n++;
  }
  const mean = sum/n, sharp = sum2/n - mean*mean;

  let dark = 0, bright = 0, lum = 0;
  for (let j = 0; j < g.length; j++) {
    if (g[j] < 8) dark++; else if (g[j] > 247) bright++;
    lum += g[j];
  }
  const clip = (dark + bright) / g.length;
  const mid = lum / g.length / 255;
  const expScore = Math.max(0, Math.min(100,
    100 - clip*260 - Math.abs(mid - 0.5)*90));

  const upright = auto ? rotateCanvas(cv, auto) : bmp;
  const hash   = avgHash(upright, 8);
  const hash16 = avgHash(upright, 16);

  const srcUrl = URL.createObjectURL(source);
  let thumbUrl = "";
  try {
    const tb = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.74));
    if (tb) thumbUrl = URL.createObjectURL(tb);
  } catch {  }

  bmp.close();
  return {
    id: crypto.randomUUID(), file, source, raw,
    url: srcUrl, thumb: thumbUrl || srcUrl,
    name: file.name, time: file.lastModified,
    hash, hash16, sharp, exp: expScore,
    focus: 0, score: 0,
    auto, userRot: 0,
    flag: "none", stars: 0, color: null,
    subject: exifSubject, exifSubject,
    badges: [], batch: 0
  };
}

function avgHash(bmp, n) {
  const hc = document.createElement("canvas"); hc.width = n; hc.height = n;
  const hx = hc.getContext("2d"); hx.drawImage(bmp, 0, 0, n, n);
  const hd = hx.getImageData(0, 0, n, n).data;
  const hg = []; let hm = 0;
  for (let i = 0; i < hd.length; i += 4) { const v = 0.299*hd[i]+0.587*hd[i+1]+0.114*hd[i+2]; hg.push(v); hm += v; }
  hm /= (n * n);
  return hg.map(v => v > hm ? 1 : 0);
}

function findExifTiff(u8) {
  let i = 2;
  while (i < u8.length - 10) {
    if (u8[i] !== 0xFF) { i++; continue; }
    const m = u8[i+1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xDA || m === 0xD9) break;
    const len = (u8[i+2] << 8) | u8[i+3];
    if (m === 0xE1 && u8[i+4] === 0x45 && u8[i+5] === 0x78 && u8[i+6] === 0x69 && u8[i+7] === 0x66)
      return u8.subarray(i + 10, i + 2 + len);
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

function readExifSubject(u8) {
  const tiff = findExifTiff(u8);
  return tiff ? parseExifSubject(tiff) : "";
}

function parseExifSubject(exif) {
  if (exif.length < 6) return "";
  const isLe = exif[0] === 0x49;
  const r16 = o => isLe ? (exif[o] | exif[o+1]<<8) : (exif[o]<<8 | exif[o+1]);
  const r32 = o => (isLe ? (exif[o] | exif[o+1]<<8 | exif[o+2]<<16 | exif[o+3]<<24) : (exif[o]<<24|exif[o+1]<<16|exif[o+2]<<8|exif[o+3])) >>> 0;
  const ifd0 = r32(4);
  if (ifd0 + 2 > exif.length) return "";
  const nEntries = r16(ifd0);
  const WANT = new Set([0x9C9F, 0x010E, 0x013B, 0x8298]);
  for (let e = 0; e < nEntries; e++) {
    const off = ifd0 + 2 + e * 12;
    if (off + 12 > exif.length) break;
    const tag = r16(off), type = r16(off+2), count = r32(off+4);
    if (!WANT.has(tag)) continue;
    const valOff = count <= 4 ? off+8 : r32(off+8);
    if (valOff + count > exif.length) continue;
    try {

      if (type === 1 || type === 7) {
        const bytes = exif.subarray(valOff, valOff + count);
        const str = new TextDecoder("utf-16le").decode(bytes).replace(/\0/g,"").trim();
        if (str) return str;
      } else if (type === 2) {
        const str = new TextDecoder("ascii").decode(exif.subarray(valOff, valOff + count)).replace(/\0/g,"").trim();
        if (str) return str;
      }
    } catch {  }
  }
  return "";
}

function tiffOrientation(t) {
  if (t.length < 12 || t[0] !== t[1] || (t[0] !== 0x49 && t[0] !== 0x4D)) return 0;
  const le = t[0] === 0x49;
  const r16 = o => le ? (t[o] | t[o+1] << 8) : (t[o] << 8 | t[o+1]);
  const r32 = o => (le ? (t[o] | t[o+1] << 8 | t[o+2] << 16 | t[o+3] << 24)
                       : (t[o] << 24 | t[o+1] << 16 | t[o+2] << 8 | t[o+3])) >>> 0;
  const ifd = r32(4);
  if (ifd + 2 > t.length) return 0;
  const n = r16(ifd);
  for (let e = 0; e < n; e++) {
    const off = ifd + 2 + e * 12;
    if (off + 12 > t.length) break;
    if (r16(off) === 0x0112) { const v = r16(off + 8); return v >= 1 && v <= 8 ? v : 0; }
  }
  return 0;
}

function rawOrientation(u8) {
  const o = tiffOrientation(u8);
  if (o) return o;
  const lim = Math.min(u8.length - 4, 1 << 20);
  for (let i = 4; i < lim; i++) {
    if (u8[i] === 0x43 && u8[i+1] === 0x4D && u8[i+2] === 0x54 && u8[i+3] === 0x31)
      return tiffOrientation(u8.subarray(i + 4));
  }
  return 0;
}

const ORIENT_DEG = { 3: 180, 6: 90, 8: 270 };

const rotOf = p => (((p.auto || 0) + (p.userRot || 0)) % 360 + 360) % 360;

function rotateCanvas(src, deg) {
  const swap = deg % 180 !== 0;
  const c = document.createElement("canvas");
  c.width = swap ? src.height : src.width; c.height = swap ? src.width : src.height;
  const x = c.getContext("2d");
  x.translate(c.width / 2, c.height / 2); x.rotate(deg * Math.PI / 180);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function softDist(bits, centroid) {
  let d = 0;
  for (let i = 0; i < bits.length; i++) d += Math.abs(bits[i] - centroid[i]);
  return d;
}

function updateCentroid(centroid, bits, k) {
  for (let i = 0; i < centroid.length; i++) centroid[i] += (bits[i] - centroid[i]) / k;
  return centroid;
}

const BATCH_TIME_GAP_S   = 60;
const HASH8_THRESHOLD    = 16;
const HASH8_MARGIN       = 6;
const HASH16_THRESHOLD   = HASH8_THRESHOLD * 4;

function matchesBatch(p, prevTime, centroid8, centroid16) {
  const gap = (p.time - prevTime) / 1000;
  if (gap > BATCH_TIME_GAP_S) return false;

  const dist8 = softDist(p.hash, centroid8);
  if (dist8 <= HASH8_THRESHOLD - HASH8_MARGIN) return true;
  if (dist8 >= HASH8_THRESHOLD + HASH8_MARGIN) return false;

  const dist16 = softDist(p.hash16, centroid16);
  return dist16 <= HASH16_THRESHOLD;
}

function finalize() {
  const ps = state.photos;
  if (!ps.length) return;
  if (state.continueSaved) { applySession(loadSession()); state.continueSaved = false; }

  const logs = ps.map(p => Math.log10(p.sharp + 1));
  const lo = Math.min(...logs), hi = Math.max(...logs), span = (hi - lo) || 1;
  ps.forEach((p, i) => p.focus = Math.round(((logs[i] - lo) / span) * 100));

  ps.forEach(p => { p.score = Math.round(0.62 * p.focus + 0.38 * p.exp); });

  ps.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  state.batches = [];
  let cur = [], centroid8 = null, centroid16 = null, prevTime = 0, k = 0;

  ps.forEach((p, i) => {
    if (i === 0) {
      cur = [p];
      centroid8  = Float64Array.from(p.hash);
      centroid16 = Float64Array.from(p.hash16);
      prevTime = p.time; k = 1;
      return;
    }
    if (matchesBatch(p, prevTime, centroid8, centroid16)) {
      cur.push(p);
      k++;
      updateCentroid(centroid8,  p.hash,   k);
      updateCentroid(centroid16, p.hash16, k);
    } else {
      state.batches.push(cur);
      cur = [p];
      centroid8  = Float64Array.from(p.hash);
      centroid16 = Float64Array.from(p.hash16);
      k = 1;
    }
    prevTime = p.time;
  });
  if (cur.length) state.batches.push(cur);

  ps.forEach(p => p.badges = []);
  state.batches.forEach((batch, bi) => {
    batch.forEach(p => { p.batch = bi; });
    const best = batch.reduce((a, b) => b.score > a.score ? b : a);
    if (batch.length > 1) best.badges.push(["b-batch", "BEST OF BATCH"]);
  });
  const bestGallery = ps.reduce((a, b) => b.score > a.score ? b : a);
  bestGallery.badges.unshift(["b-gallery", "★ BEST OF GALLERY"]);
  ps.reduce((a, b) => b.focus > a.focus ? b : a).badges.push(["b-focus", "BEST IN FOCUS"]);

  state.compareSet.clear();
  updateSubjectFilter();
  render();
}

function visible(p) {
  if (state.filterStars && p.stars < state.filterStars) return false;
  if (state.filterColor && p.color !== state.filterColor) return false;
  if (state.filterSubject) {
    const s = state.filterSubject;
    const q = s.toLowerCase();
    const match = (p.subject && p.subject.toLowerCase().includes(q))
      || (p.exifSubject && p.exifSubject.toLowerCase().includes(q));
    if (!match) return false;
  }
  switch (state.filter) {
    case "pick": return p.flag === "pick";
    case "reject": return p.flag === "reject";
    case "best": return p.badges.length > 0;
    default: return true;
  }
}

function scoreClass(s) { return s >= 70 ? "hi" : s < 40 ? "lo" : ""; }
function updateSubjectFilter() {
  const sel = $("#f-subj");
  const prev = sel.value;

  const labels = new Set();
  state.photos.forEach(p => {
    if (p.subject) labels.add(p.subject);
    if (p.exifSubject) labels.add(p.exifSubject);
  });
  sel.innerHTML = `<option value="">All</option>` +
    [...labels].sort().map(l => `<option value="${esc(l)}"${l===prev?" selected":""}>${esc(l)}</option>`).join("");
  if (![...labels].includes(prev)) state.filterSubject = "";
}

function esc(s) { return s.replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }

const stamp = () => {
  const d = new Date(), z = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
const getPicks = () => state.photos.filter(p => p.flag === "pick");
const manifestText = picks => picks.map(p =>
  [p.name,
   "★".repeat(p.stars) || "-",
   p.color || "-",
   `focus ${focus10(p)}/10`,
   `score ${p.score}`,
   p.subject || p.exifSubject || "-"
  ].join("\t")).join("\n");

$("#btn-folder").addEventListener("click", async () => {
  const picks = getPicks();
  if (!picks.length) return toast("Nothing kept yet. Keep a few photos first.");

  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      const sub = await dir.getDirectoryHandle(`Proofsheet Picks ${stamp()}`, { create: true });
      let done = 0;
      for (const p of picks) {
        const fh = await sub.getFileHandle(p.name, { create: true });
        const w = await fh.createWritable();
        await w.write(p.file); await w.close();
        done++;
      }
      const mh = await sub.getFileHandle("picks-manifest.txt", { create: true });
      const mw = await mh.createWritable();
      await mw.write(manifestText(picks)); await mw.close();
      return toast(`Saved ${done} pick${done>1?"s":""} into "${sub.name}".`);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.warn("Folder access unavailable, falling back to ZIP:", err);
    }
  }
  await zipPicks(picks);
});

async function zipPicks(picks) {
  toast("Folder access isn't available here, so I'm packaging your kept photos as a ZIP…");
  const folder = `Proofsheet Picks ${stamp()}/`;
  const entries = [];
  for (const p of picks)
    entries.push({ name: folder + p.name, data: new Uint8Array(await p.file.arrayBuffer()) });
  entries.push({ name: folder + "picks-manifest.txt", data: new TextEncoder().encode(manifestText(picks)) });
  const blob = buildZip(entries);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `proofsheet-picks-${stamp()}.zip`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Downloaded ${picks.length} pick${picks.length>1?"s":""} — unzip to get your picks folder.`);
}

$("#btn-move").addEventListener("click", async () => {
  if (!window.showDirectoryPicker)
    return toast("This browser can't grant folder access — use Export Picks for a ZIP instead.");
  const picks = getPicks();
  if (!picks.length) return toast("Nothing kept yet. Keep a few photos first.");

  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    const wanted = new Set(picks.map(p => p.name));
    const sub = await dir.getDirectoryHandle(`Proofsheet Picks ${stamp()}`, { create: true });

    const copied = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file" || !wanted.has(name)) continue;
      const f = await handle.getFile();
      const out = await sub.getFileHandle(name, { create: true });
      const w = await out.createWritable();
      await w.write(f); await w.close();
      copied.push(name);
    }
    if (!copied.length)
      return toast("No filenames in that folder matched your picks — nothing was moved.");

    const doMove = (await askDialog({
      title: "Move your originals too?",
      body: `Copied <b>${copied.length}</b> of ${wanted.size} kept photos into <b>${esc(sub.name)}</b>. Delete the originals from the source folder to finish the move?`,
      actions: [{ label: "Yes, move them", kind: "primary", value: true }, { label: "No, keep copies", kind: "ghost", value: false }]
    })) === true;
    if (doMove) {
      for (const name of copied) await dir.removeEntry(name);
      toast(`Moved ${copied.length} pick${copied.length>1?"s":""} into "${sub.name}".`);
    } else {
      toast(`Copied ${copied.length} pick${copied.length>1?"s":""} into "${sub.name}" — originals kept.`);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    toast("Couldn't access that folder — check permissions and try again.");
  }
});

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(entries) {
  const enc = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dDate = (((now.getFullYear() - 1980) & 0x7F) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data), sz = e.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);  h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true);      h.setUint16(8, 0, true);
    h.setUint16(10, dTime, true);      h.setUint16(12, dDate, true);
    h.setUint32(14, crc, true);        h.setUint32(18, sz, true);    h.setUint32(22, sz, true);
    h.setUint16(26, name.length, true);h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), name, e.data);
    central.push({ name, crc, sz, offset });
    offset += 30 + name.length + sz;
  }
  const cdStart = offset;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true);  h.setUint16(4, 20, true);  h.setUint16(6, 20, true);
    h.setUint16(8, 0x0800, true);      h.setUint16(10, 0, true);
    h.setUint16(12, dTime, true);      h.setUint16(14, dDate, true);
    h.setUint32(16, c.crc, true);      h.setUint32(20, c.sz, true);  h.setUint32(24, c.sz, true);
    h.setUint16(28, c.name.length, true);
    h.setUint32(42, c.offset, true);
    chunks.push(new Uint8Array(h.buffer), c.name);
    offset += 46 + c.name.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true); eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - cdStart, true); eocd.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(eocd.buffer));
  return new Blob(chunks, { type: "application/zip" });
}

let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3600);
}

let dlgResolve = null;
function askDialog({ title, body = "", actions }) {
  return new Promise(res => {
    if (dlgResolve) dlgResolve(null);
    dlgResolve = res;
    $("#dlg-title").textContent = title;
    $("#dlg-body").innerHTML = body;
    const box = $("#dlg-actions"); box.innerHTML = "";
    actions.forEach(a => {
      const b = document.createElement("button");
      b.className = "btn big " + (a.kind || "ghost");
      b.textContent = a.label;
      b.addEventListener("click", () => closeDialog(a.value));
      box.appendChild(b);
    });
    $("#dialog").classList.add("open");
    const first = box.querySelector("button"); if (first) first.focus();
  });
}
function closeDialog(v) {
  $("#dialog").classList.remove("open");
  const r = dlgResolve; dlgResolve = null;
  if (r) r(v === undefined ? null : v);
}
const dialogOpen = () => $("#dialog").classList.contains("open");

const arenaActive = () => $("#screen-arena").classList.contains("active");
function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === "screen-" + name));
  closePopover();
  if (name === "intro") refreshIntro();
  else requestAnimationFrame(() => centerActive(false));
  window.scrollTo(0, 0);
}

const SESSION_KEY = "proofsheet_session_v1";
let saveTimer, savedT, dirty = false;

function saveSession() {
  if (!state.photos.length) return;
  try {
    const photos = state.photos.map(p => ({
      n: p.name, fl: p.flag, st: p.stars, co: p.color, su: p.subject,
      ...(p.userRot ? { ro: p.userRot } : {})
    }));
    const names = new Set(photos.map(x => x.n));
    const carried = (state.carry || []).filter(x => !names.has(x.n));
    localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 2, savedAt: Date.now(), photos: photos.concat(carried) }));
    dirty = false;
    const c = $("#saved-chip"); c.hidden = false; c.classList.add("pulse");
    clearTimeout(savedT); savedT = setTimeout(() => c.classList.remove("pulse"), 1800);
  } catch {  }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return Array.isArray(d) ? { v: 1, savedAt: null, photos: d } : d;
  } catch { return null; }
}
function applySession(s) {
  const saved = s && s.photos; if (!saved) return 0;
  const map = new Map(saved.map(x => [x.n, x]));
  let n = 0;
  state.photos.forEach(p => {
    const x = map.get(p.name); if (!x) return;
    p.flag = x.fl || "none"; p.stars = x.st || 0; p.color = x.co || null;
    p.subject = x.su || p.subject;
    p.userRot = [90, 180, 270].includes(x.ro) ? x.ro : 0;
    n++;
  });
  return n;
}
const scheduleSave = () => { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveSession, 1500); };
window.addEventListener("pagehide", () => { if (dirty) { clearTimeout(saveTimer); saveSession(); } });

function refreshIntro() {
  const btn = $("#btn-continue"), note = $("#continue-note");
  if (state.photos.length) {
    const kept = state.photos.filter(p => p.flag === "pick").length;
    btn.disabled = false; btn.textContent = "↩ Back to your project";
    note.innerHTML = `${state.photos.length} photos open · ${kept} kept`;
    return;
  }
  const s = loadSession();
  if (s && s.photos && s.photos.length) {
    const kept = s.photos.filter(x => x.fl === "pick").length;
    const when = s.savedAt ? new Date(s.savedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    btn.disabled = false; btn.textContent = "Continue last project";
    note.innerHTML = `${s.photos.length} photos · ${kept} kept${when ? " · saved " + when : ""}<small>Starting a new project replaces the saved one.</small>`;
  } else {
    btn.disabled = true; btn.textContent = "Continue last project";
    note.textContent = "Nothing saved yet. Your first project will show up here.";
  }
}

let pickMode = "new";
async function routePicked(files) {
  if (!files.length) return;
  if (pickMode === "continue") return verifyAndOpen(files);
  if (pickMode === "add") return ingest(files, { fresh: false });
  return setStartSelection(files);
}
fileInput.addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; routePicked(f); });
folderInput.addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; routePicked(f); });

async function confirmReplaceThenPick(useFolder) {
  if (state.photos.length) {
    const ok = await askDialog({
      title: "Start a new project?",
      body: "Your current project is saved on this device. You can continue it later, until you start culling the new one.",
      actions: [{ label: "Yes, start new", kind: "primary", value: true }, { label: "Keep working on this one", kind: "ghost", value: false }]
    });
    if (ok !== true) return;
  }
  openStartModal();
  if (useFolder) { pickMode = "new"; folderInput.click(); }
}
$("#btn-start").addEventListener("click", () => confirmReplaceThenPick(false));
$("#btn-start-folder").addEventListener("click", () => confirmReplaceThenPick(true));

let startFiles = [], startThumbs = [];
const startOpen = () => $("#start-modal").classList.contains("open");
function openStartModal(files) {
  startFiles = []; clearStartThumbs();
  $("#start-modal").classList.add("open");
  if (files && files.length) setStartSelection(files); else $("#start-modal").dataset.step = "pick";
  if (!files || !files.length) $("#sm-files").focus();
}
function closeStartModal() { $("#start-modal").classList.remove("open", "dragover"); clearStartThumbs(); startFiles = []; }
function clearStartThumbs() { startThumbs.forEach(u => URL.revokeObjectURL(u)); startThumbs = []; $("#sm-thumbs").innerHTML = ""; }
function fmtBytes(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(n / 1e6)) + " MB"; }
function setStartSelection(all) {
  const files = all.filter(isImageFile);
  if (!files.length) { toast("No photos found in that selection. Try another."); $("#start-modal").classList.add("open"); return; }
  if (!startOpen()) $("#start-modal").classList.add("open");
  startFiles = files; clearStartThumbs();
  const raws = files.filter(f => isRaw(f.name)).length, size = files.reduce((s, f) => s + f.size, 0);
  $("#sm-count").textContent = files.length;
  $("#sm-count-lbl").textContent = files.length === 1 ? "photo selected" : "photos selected";
  const chips = [];
  if (files.length - raws) chips.push((files.length - raws) + " JPEG/PNG");
  if (raws) chips.push(raws + " RAW");
  chips.push(fmtBytes(size));
  if (all.length > files.length) chips.push((all.length - files.length) + " non-photo skipped");
  $("#sm-chips").innerHTML = chips.map(c => `<span class="sm-chip">${c}</span>`).join("");
  const tb = $("#sm-thumbs");
  files.filter(f => !isRaw(f.name)).slice(0, 5).forEach(f => {
    const im = document.createElement("img"), u = URL.createObjectURL(f);
    startThumbs.push(u); im.src = u; im.alt = f.name; tb.appendChild(im);
  });
  if (files.length > tb.children.length) { const m = document.createElement("span"); m.textContent = "+" + (files.length - tb.children.length); tb.appendChild(m); }
  $("#start-modal").dataset.step = "review";
  $("#sm-confirm").focus();
}
$("#sm-files").addEventListener("click", () => { pickMode = "new"; fileInput.click(); });
$("#sm-folder").addEventListener("click", () => { pickMode = "new"; folderInput.click(); });
$("#sm-change").addEventListener("click", () => { $("#start-modal").dataset.step = "pick"; clearStartThumbs(); startFiles = []; });
$("#sm-close").addEventListener("click", closeStartModal);
$("#start-modal").addEventListener("mousedown", e => { if (e.target.id === "start-modal") closeStartModal(); });
$("#sm-confirm").addEventListener("click", () => {
  const f = startFiles; closeStartModal();
  if (f.length) ingest(f, { fresh: true });
});

$("#btn-continue").addEventListener("click", async () => {
  if (state.photos.length) { showScreen("arena"); return; }
  const s = loadSession();
  if (!s || !s.photos || !s.photos.length) return;
  const choice = await askDialog({
    title: "Let's find your photos",
    body: `Your last project had <b>${s.photos.length}</b> photos. Pick the folder they live in and I'll check that everything is still there.`,
    actions: [
      { label: "Choose the folder", kind: "primary", value: "folder" },
      { label: "Choose files instead", kind: "ghost", value: "files" },
      { label: "Not now", kind: "ghost", value: null }
    ]
  });
  if (!choice) return;
  pickMode = "continue";
  (choice === "folder" ? folderInput : fileInput).click();
});

async function verifyAndOpen(files) {
  const imgs = files.filter(isImageFile);
  const s = loadSession(); const saved = (s && s.photos) || [];
  const savedNames = new Set(saved.map(x => x.n));
  const found = imgs.filter(f => savedNames.has(f.name));
  const total = saved.length;

  if (!found.length) {
    const a = await askDialog({
      title: "Those don't look like the same photos",
      body: `None of the ${imgs.length} file${imgs.length === 1 ? "" : "s"} you picked match the ${total} photos in your saved project. Try the folder you imported from last time.`,
      actions: [{ label: "Choose another folder", kind: "primary", value: "again" }, { label: "Cancel", kind: "ghost", value: null }]
    });
    if (a === "again") { pickMode = "continue"; folderInput.click(); }
    return;
  }
  const foundNames = new Set(found.map(f => f.name));
  const missing = total - foundNames.size;
  const a = await askDialog({
    title: missing === 0 ? "Everything's here!" : "Most of it is here",
    body: missing === 0
      ? `Found all <b>${total}</b> photos from your last project.`
      : `Found <b>${foundNames.size}</b> of <b>${total}</b> photos from your last project. The other ${missing} aren't in this location, so they'll be left out for now (your choices for them stay saved).`,
    actions: [{ label: "Open my project", kind: "primary", value: "open" }, { label: "Choose another folder", kind: "ghost", value: "again" }]
  });
  if (a === "open") {
    await ingest(found, { fresh: true, continueSaved: true, carry: saved.filter(x => !foundNames.has(x.n)) });
  } else if (a === "again") { pickMode = "continue"; folderInput.click(); }
}

function openImportModal() {
  const m = $("#import-modal");
  m.classList.remove("is-done", "fading"); m.classList.add("open");
  $("#im-pct").textContent = "0"; $("#im-fill").style.width = "0%";
  $("#im-lbl").textContent = "Starting…"; $("#im-timing").textContent = "";
}
function closeImportModal() { $("#import-modal").classList.remove("open", "fading", "is-done"); }
async function finishImportModal() {
  const m = $("#import-modal");
  await sleep(350);
  m.classList.add("is-done");
  await sleep(2000);
  m.classList.add("fading");
  await sleep(520);
  closeImportModal();
}
const importBusy = () => $("#import-modal").classList.contains("open");

function clearProject() {
  state.photos.forEach(p => {
    try { URL.revokeObjectURL(p.url); if (p.thumb && p.thumb !== p.url) URL.revokeObjectURL(p.thumb); } catch {}
  });
  state.photos = []; state.batches = []; state.compareSet.clear(); state.activeId = null;
  state.filter = "all"; state.filterStars = 0; state.filterColor = null; state.filterSubject = "";
  state.carry = []; state.continueSaved = false;
  buildFilters(); syncSeg(); updateSubjectFilter(); render();
}

async function ingest(files, { fresh = false, continueSaved = false, carry = [] } = {}) {
  files = files.filter(isImageFile);
  if (!files.length) { toast("No photos found in that selection."); return; }
  if (importBusy()) return;
  if (fresh) clearProject();
  else {
    const have = new Set(state.photos.map(p => `${p.name}|${p.file.size}|${p.file.lastModified}`));
    files = files.filter(f => !have.has(`${f.name}|${f.size}|${f.lastModified}`));
    if (!files.length) { toast("Those photos are already in this project."); return; }
  }
  state.carry = fresh ? carry : state.carry;
  state.continueSaved = continueSaved;

  const before = state.photos.length;
  const total = files.length, tStart = performance.now(), skipped = [], active = new Set();
  let completed = 0;
  const CONCURRENCY = computeConcurrency(total);
  openImportModal();

  function update() {
    const pct = Math.round((completed / total) * 100);
    $("#im-pct").textContent = pct; $("#im-fill").style.width = pct + "%";
    const names = [...active].slice(0, 2).join(", ") + (active.size > 2 ? ` +${active.size - 2} more` : "");
    $("#im-lbl").textContent = `Analyzing ${completed} of ${total}` + (names ? " — " + names : "");
    const el = performance.now() - tStart;
    $("#im-timing").textContent = completed
      ? `${formatDuration(el)} elapsed · about ${formatDuration(el / completed * (total - completed))} left` + (CONCURRENCY > 1 ? ` · ${CONCURRENCY} at once` : "")
      : "Warming up…";
  }
  update();

  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const f = files[cursor++];
      active.add(f.name); update();
      try { state.photos.push(await analyze(f)); }
      catch (err) { console.error("Skipped", f.name, err); skipped.push(f.name); }
      active.delete(f.name); completed++; update();
      await sleep(0);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  const elapsed = performance.now() - tStart;

  if (state.photos.length === before) {
    closeImportModal(); state.continueSaved = false;
    toast("None of those files could be read as photos.");
    showScreen(before ? "arena" : "intro");
    return;
  }

  try { finalize(); }
  catch (err) {
    console.error(err);
    closeImportModal();
    toast("Something went wrong while grouping your photos. Try importing again.");
    return;
  }
  if (continueSaved) {
    const first = state.batches.flat().find(p => p.flag === "none");
    if (first) { state.activeId = first.id; render(); }
  }
  showScreen("arena");
  await finishImportModal();

  if (skipped.length) toast(`Skipped ${skipped.length} file${skipped.length > 1 ? "s" : ""} with no readable preview: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`);
  else if (continueSaved) toast(`Welcome back! ${state.photos.filter(p => p.flag === "pick").length} kept so far.`);
  else toast(`Analyzed ${total} photo${total > 1 ? "s" : ""} in ${formatDuration(elapsed)}.`);
}

let rows = [], setEls = [], thumbEls = new Map(), flatIds = [], byId = new Map(), suppressUntil = 0;
const strip = $("#strip"), stage = $("#stage"), stageImg = $("#stage-img"), stageZoom = $("#stage-zoom");
const BADGE_TEXT = { "b-gallery": "Best of gallery", "b-batch": "Best of set", "b-focus": "Sharpest" };

const activePhoto = () => (state.activeId ? byId.get(state.activeId) : null);
function locate(id) {
  for (let r = 0; r < rows.length; r++) { const c = rows[r].findIndex(p => p.id === id); if (c >= 0) return [r, c]; }
  return null;
}

function updateStats() {
  $("#st-total").textContent = state.photos.length;
  $("#st-picks").textContent = state.photos.filter(p => p.flag === "pick").length;
  $("#st-rejects").textContent = state.photos.filter(p => p.flag === "reject").length;
}
function updateCompareUI() {
  const n = state.compareSet.size;
  $("#btn-compare").textContent = n ? `⊞ Compare (${n})` : "⊞ Compare";
}

function render() {
  byId = new Map(state.photos.map(p => [p.id, p]));
  const oldFlat = flatIds;
  rows = state.batches.map(b => b.filter(visible)).filter(r => r.length);
  flatIds = rows.flat().map(p => p.id);
  const keep = new Set(flatIds);
  if (!state.activeId || !keep.has(state.activeId)) {

    let pick = null; const oi = oldFlat.indexOf(state.activeId);
    if (oi >= 0) {
      for (let i = oi + 1; i < oldFlat.length && !pick; i++) if (keep.has(oldFlat[i])) pick = oldFlat[i];
      for (let i = oi - 1; i >= 0 && !pick; i--) if (keep.has(oldFlat[i])) pick = oldFlat[i];
    }
    state.activeId = pick || flatIds[0] || null;
  }
  updateStats(); updateCompareUI();
  buildStrip(); syncStage();
  requestAnimationFrame(() => centerActive(false));
}

function buildStrip() {
  strip.innerHTML = ""; setEls = []; thumbEls.clear();
  if (!rows.length) { strip.innerHTML = '<div class="strip-empty">No photos to show</div>'; return; }
  const frag = document.createDocumentFragment();
  rows.forEach((row, ri) => {
    const first = row[0];
    const when = new Date(first.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const el = document.createElement("div"); el.className = "set"; el.dataset.r = String(ri);
    el.innerHTML = `<div class="set-head"><span class="set-tag">Set ${first.batch + 1}</span><span class="set-info">${row.length} photo${row.length > 1 ? "s" : ""} · ${when}</span></div><div class="set-photos"></div>`;
    const holder = el.querySelector(".set-photos");
    row.forEach(p => holder.appendChild(makeThumb(p)));
    frag.appendChild(el); setEls.push(el);
  });
  strip.appendChild(frag);
  markActive();
}

function makeThumb(p) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "thumb"; b.dataset.id = p.id;
  b.setAttribute("aria-label", `${p.name}, set ${p.batch + 1}`);
  b.innerHTML = `<img src="${p.thumb}" alt="" decoding="async" loading="lazy"><span class="tb-flag" aria-hidden="true"></span><span class="tb-meta"></span>`;
  b.addEventListener("click", () => setActive(p.id));
  thumbEls.set(p.id, b); paintThumb(p);
  return b;
}
function paintThumb(p) {
  const b = thumbEls.get(p.id); if (!b) return;
  b.classList.toggle("pick", p.flag === "pick");
  b.classList.toggle("reject", p.flag === "reject");
  b.classList.toggle("cmp", state.compareSet.has(p.id));
  const rd = rotOf(p);
  b.style.setProperty("--rot", rd + "deg"); b.classList.toggle("rq", rd % 180 !== 0);
  b.querySelector(".tb-flag").textContent = p.flag === "pick" ? "✓" : p.flag === "reject" ? "✕" : "";
  b.querySelector(".tb-meta").innerHTML = p.stars ? `<span class="tb-star">★ ${p.stars}</span>` : "";
  let dot = b.querySelector(".tb-dot");
  if (p.color) { if (!dot) { dot = document.createElement("span"); dot.className = "tb-dot"; b.appendChild(dot); } dot.style.background = COLORS[p.color]; }
  else if (dot) dot.remove();
}
function markActive() {
  strip.querySelectorAll(".thumb.active").forEach(x => x.classList.remove("active"));
  const th = thumbEls.get(state.activeId);
  if (th) th.classList.add("active");
}

function centerActive(smooth = true) {
  const id = state.activeId; if (!id) return;
  const loc = locate(id); if (!loc) return;
  const setEl = setEls[loc[0]], th = thumbEls.get(id); if (!setEl || !th) return;
  suppressUntil = performance.now() + (smooth ? 700 : 150);
  const top = setEl.offsetTop - (strip.clientHeight - setEl.offsetHeight) / 2;
  strip.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  const holder = th.parentElement;
  holder.scrollTo({ left: Math.max(0, th.offsetLeft - (holder.clientWidth - th.offsetWidth) / 2), behavior: smooth ? "smooth" : "auto" });
}

function setActive(id, { center = true } = {}) {
  if (!id || !byId.has(id)) return;
  state.activeId = id; markActive(); syncStage();
  if (center) centerActive(true);
}

function go(dr, dc) {
  const loc = locate(state.activeId); if (!loc) return;
  const [r, c] = loc;
  if (dr) { const nr = r + dr; if (nr >= 0 && nr < rows.length) setActive(rows[nr][0].id); }
  else if (dc) { const nc = c + dc; if (nc >= 0 && nc < rows[r].length) setActive(rows[r][nc].id); }
}
function advance() {
  const loc = locate(state.activeId); if (!loc) return;
  const [r, c] = loc;
  if (c < rows[r].length - 1) go(0, 1);
  else if (r < rows.length - 1) go(1, 0);
}

let settleT;
strip.addEventListener("scroll", () => {
  if (performance.now() < suppressUntil) return;
  clearTimeout(settleT); settleT = setTimeout(settleStrip, 140);
}, { passive: true });
function settleStrip() {
  if (!setEls.length) return;
  const mid = strip.scrollTop + strip.clientHeight / 2;
  let best = 0, bd = Infinity;
  setEls.forEach((el, i) => { const d = Math.abs(el.offsetTop + el.offsetHeight / 2 - mid); if (d < bd) { bd = d; best = i; } });
  const loc = locate(state.activeId);
  if (!loc || loc[0] !== best) setActive(rows[best][0].id); else centerActive(true);
}

function syncStage() {
  const p = activePhoto();
  const bar = $("#photobar");
  $("#st-empty").hidden = !!p;
  bar.classList.toggle("off", !p);
  if (!p) {
    stageImg.hidden = true; stageImg.dataset.id = ""; stageImg.removeAttribute("src");
    $("#st-badges").innerHTML = ""; $("#pb-set").textContent = "No photo selected"; $("#pb-name").textContent = "—";
    return;
  }
  stageImg.hidden = false;
  if (stageImg.dataset.id !== p.id) {
    stageImg.dataset.id = p.id; resetZoom(); stageImg.alt = p.name;
    stageImg.src = p.thumb;
    const full = new Image(), want = p.id;
    full.onload = () => { if (stageImg.dataset.id === want) stageImg.src = p.url; };
    full.src = p.url;
  }
  paintStageRot(p);
  $("#st-badges").innerHTML = p.badges.map(([c]) => `<span class="pill ${c}">${BADGE_TEXT[c] || ""}</span>`).join("") + (p.raw ? '<span class="pill raw">RAW</span>' : "");

  const loc = locate(p.id);
  $("#pb-set").textContent = loc ? `Set ${p.batch + 1} of ${state.batches.length} · photo ${loc[1] + 1} of ${rows[loc[0]].length}` : `Set ${p.batch + 1}`;
  $("#pb-name").textContent = p.name; $("#pb-name").title = p.name;
  $("#act-keep").classList.toggle("on", p.flag === "pick");
  $("#act-reject").classList.toggle("on", p.flag === "reject");
  $("#pb-stars").querySelectorAll(".star").forEach(b => b.classList.toggle("on", +b.dataset.s <= p.stars));
  $("#pb-colors").querySelectorAll(".dot").forEach(b => b.classList.toggle("on", b.dataset.c === p.color));
  const si = $("#pb-subject"); if (document.activeElement !== si) si.value = p.subject || "";
  si.placeholder = p.exifSubject || "Who's in it?";
  $("#pb-focus").textContent = `Focus ${focus10(p)}/10`;
  const sc = $("#pb-score"); sc.textContent = `Score ${p.score}`; sc.className = "score-chip " + scoreClass(p.score);
  $("#btn-cmp-toggle").classList.toggle("on", state.compareSet.has(p.id));
}

function paintStageRot(p) {
  const rd = rotOf(p);
  stageZoom.style.setProperty("--rot", rd + "deg"); stageZoom.classList.toggle("rq", rd % 180 !== 0);
}
function rotatePhoto(p, dir) {
  if (!p) return;
  p.userRot = ((p.userRot || 0) + 90 * dir + 360) % 360;
  resetZoom(); paintThumb(p); paintStageRot(p); scheduleSave();
}
$("#btn-rot-l").addEventListener("click", () => rotatePhoto(activePhoto(), -1));
$("#btn-rot-r").addEventListener("click", () => rotatePhoto(activePhoto(), 1));

let zoomed = false;
function resetZoom() { zoomed = false; stage.classList.remove("zoomed"); stageZoom.style.transform = ""; }
function toggleZoom(e) {
  if (zoomed) return resetZoom();
  const r = stageZoom.getBoundingClientRect();
  const ox = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
  const oy = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
  stageZoom.style.transformOrigin = `${ox}% ${oy}%`; stageZoom.style.transform = "scale(2.6)";
  zoomed = true; stage.classList.add("zoomed");
}
let ptr = null;
stage.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; ptr = { x: e.clientX, y: e.clientY }; });
stage.addEventListener("pointerup", e => {
  if (!ptr) return;
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y; ptr = null;
  if (Math.hypot(dx, dy) < 10) { if (activePhoto()) toggleZoom(e); return; }
  if (zoomed) return;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) go(0, dx < 0 ? 1 : -1);
  else if (Math.abs(dy) > 60) go(dy < 0 ? 1 : -1, 0);
});
$("#nav-l").addEventListener("click", () => go(0, -1));
$("#nav-r").addEventListener("click", () => go(0, 1));
$("#nav-u").addEventListener("click", () => go(-1, 0));
$("#nav-d").addEventListener("click", () => go(1, 0));

function refresh(p) {
  const filtered = state.filter !== "all" || state.filterStars || state.filterColor || state.filterSubject;
  if (filtered) render(); else { paintThumb(p); syncStage(); updateStats(); }
  scheduleSave();
}
function setFlag(p, f, { noAdvance = false } = {}) {
  p.flag = f; refresh(p);
  if (!noAdvance && state.autoAdvance && f !== "none" && state.activeId === p.id) advance();
}
function setStars(p, n) { p.stars = n; refresh(p); }
function setColor(p, c) { p.color = c; refresh(p); }
function setSubject(p, s) { p.subject = s; updateSubjectFilter(); scheduleSave(); syncStage(); }

function buildPhotobar() {
  $("#pb-stars").innerHTML = [1, 2, 3, 4, 5].map(n => `<button class="star" data-s="${n}" aria-label="${n} star${n > 1 ? "s" : ""}" title="${n} star${n > 1 ? "s" : ""} (${n})">★</button>`).join("");
  $("#pb-colors").innerHTML = COLOR_NAMES.map((k, i) => `<button class="dot" data-c="${k}" style="--c:${COLORS[k]}" aria-label="${k} tag" title="${k}${i < 4 ? " (" + (6 + i) + ")" : ""}"></button>`).join("");
  $("#pb-stars").addEventListener("click", e => {
    const b = e.target.closest(".star"), p = activePhoto(); if (!b || !p) return;
    const n = +b.dataset.s; setStars(p, n === p.stars ? 0 : n);
  });
  $("#pb-colors").addEventListener("click", e => {
    const b = e.target.closest(".dot"), p = activePhoto(); if (!b || !p) return;
    setColor(p, b.dataset.c === p.color ? null : b.dataset.c);
  });
  $("#act-keep").addEventListener("click", () => { const p = activePhoto(); if (p) setFlag(p, p.flag === "pick" ? "none" : "pick"); });
  $("#act-reject").addEventListener("click", () => { const p = activePhoto(); if (p) setFlag(p, p.flag === "reject" ? "none" : "reject"); });
  const si = $("#pb-subject");
  si.addEventListener("change", () => { const p = activePhoto(); if (p) setSubject(p, si.value.trim()); });
  si.addEventListener("keydown", e => { if (e.key === "Enter") si.blur(); });
  $("#btn-cmp-toggle").addEventListener("click", () => toggleCompare(activePhoto()));
}

document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") {
    if (dialogOpen()) closeDialog(null);
    else if (startOpen()) closeStartModal();
    else if ($("#compare").classList.contains("open")) closeCompare();
    else if (popoverOpen()) closePopover();
    else resetZoom();
    return;
  }
  const tag = e.target.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (typing || !arenaActive() || importBusy() || startOpen() || dialogOpen() || popoverOpen() || $("#compare").classList.contains("open")) return;
  const p = activePhoto();
  switch (e.key) {
    case "ArrowLeft":  e.preventDefault(); go(0, -1); break;
    case "ArrowRight": e.preventDefault(); go(0, 1); break;
    case "ArrowUp":    e.preventDefault(); go(-1, 0); break;
    case "ArrowDown":  e.preventDefault(); go(1, 0); break;
    case "p": case "P": case "k": case "K": if (p) setFlag(p, p.flag === "pick" ? "none" : "pick"); break;
    case "x": case "X": if (p) setFlag(p, p.flag === "reject" ? "none" : "reject"); break;
    case "c": case "C": toggleCompare(p); break;
    case "r": rotatePhoto(p, 1); break;
    case "R": rotatePhoto(p, -1); break;
    case "z": case "Z": if (p) { if (zoomed) resetZoom(); else { const r = stageImg.getBoundingClientRect(); toggleZoom({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); } } break;
    case " ": if (tag !== "BUTTON") { e.preventDefault(); advance(); } break;
    default:
      if (p && /^[0-5]$/.test(e.key)) setStars(p, +e.key);
      else if (p && /^[6-9]$/.test(e.key)) { const c = COLOR_NAMES[+e.key - 6]; setColor(p, p.color === c ? null : c); }
  }
});

function popoverOpen() { return $("#tools-pop").classList.contains("open"); }
function openPopover() { $("#tools-pop").classList.add("open"); $("#btn-tools").setAttribute("aria-expanded", "true"); }
function closePopover() { $("#tools-pop").classList.remove("open"); $("#btn-tools").setAttribute("aria-expanded", "false"); }
$("#btn-tools").addEventListener("click", e => { e.stopPropagation(); popoverOpen() ? closePopover() : openPopover(); });
document.addEventListener("click", e => {
  if (popoverOpen() && !e.target.closest("#tools-pop") && !e.target.closest("#btn-tools")) closePopover();
});
["btn-add", "btn-move", "btn-export", "btn-compare"].forEach(id => $("#" + id).addEventListener("click", closePopover));

function syncSeg() { document.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", b.dataset.f === state.filter)); }
document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => { state.filter = b.dataset.f; syncSeg(); render(); }));

function buildFilters() {
  const fs = $("#f-stars");
  fs.innerHTML = [1, 2, 3, 4, 5].map(n => `<button data-s="${n}" aria-label="At least ${n} star${n > 1 ? "s" : ""}">★</button>`).join("");
  const paintStars = () => fs.querySelectorAll("button").forEach(x => x.classList.toggle("on", +x.dataset.s <= state.filterStars));
  fs.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    const n = +b.dataset.s; state.filterStars = state.filterStars === n ? 0 : n; paintStars(); render();
  }));
  paintStars();

  const fc = $("#f-clrs");
  fc.innerHTML = COLOR_NAMES.map(k => `<button class="dot" data-c="${k}" style="--c:${COLORS[k]}" aria-label="Show ${k} only" title="${k}"></button>`).join("")
    + `<button class="x" title="Clear color filter" aria-label="Clear color filter">✕</button>`;
  const paintC = () => fc.querySelectorAll(".dot").forEach(x => x.classList.toggle("on", x.dataset.c === state.filterColor));
  fc.querySelectorAll(".dot").forEach(b => b.addEventListener("click", () => {
    state.filterColor = state.filterColor === b.dataset.c ? null : b.dataset.c; paintC(); render();
  }));
  fc.querySelector(".x").addEventListener("click", () => { state.filterColor = null; paintC(); render(); });
  paintC();
}
$("#f-subj").addEventListener("change", e => { state.filterSubject = e.target.value; render(); });
$("#btn-showall").addEventListener("click", () => {
  state.filter = "all"; state.filterStars = 0; state.filterColor = null; state.filterSubject = "";
  buildFilters(); syncSeg(); updateSubjectFilter(); render();
});
$("#opt-advance").addEventListener("change", e => {
  state.autoAdvance = e.target.checked;
  try { localStorage.setItem("proofsheet_autoadvance", e.target.checked ? "1" : "0"); } catch {}
});

$("#btn-autocull").addEventListener("click", () => {
  state.batches.forEach(batch => {
    const best = batch.reduce((a, b) => b.score > a.score ? b : a);
    batch.forEach(p => {
      if (p.flag === "none") {
        if (p === best) p.flag = "pick";
        else if (p.score < best.score - 22 || p.focus < 25) p.flag = "reject";
      }
      if (p.stars === 0)
        p.stars = p.score >= 85 ? 5 : p.score >= 70 ? 4 : p.score >= 55 ? 3 : p.score >= 40 ? 2 : 1;
    });
  });
  render(); scheduleSave();
  toast("Auto-cull done. The best of each set is kept and the weakest are rejected. Photos you already flagged were left alone.");
});

$("#btn-export").addEventListener("click", () => {
  const picks = state.photos.filter(p => p.flag === "pick");
  if (!picks.length) return toast("Nothing kept yet. Keep a few photos first.");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([manifestText(picks)], { type: "text/plain" }));
  a.download = "proofsheet-picks.txt"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Exported ${picks.length} kept photo${picks.length > 1 ? "s" : ""} as a filename list.`);
});

$("#btn-add").addEventListener("click", () => { pickMode = "add"; fileInput.click(); });

$("#btn-reset").addEventListener("click", async () => {
  const ok = await askDialog({
    title: "Start over?",
    body: "This clears the photos from this screen <b>and your saved project</b>. Your original files are never touched.",
    actions: [{ label: "Yes, start over", kind: "primary", value: true }, { label: "Never mind", kind: "ghost", value: false }]
  });
  if (ok !== true) return;
  clearProject();
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  $("#saved-chip").hidden = true; dirty = false;
  showScreen("intro");
});

$("#btn-home").addEventListener("click", () => showScreen("intro"));

function toggleCompare(p) {
  if (!p) return;
  if (state.compareSet.has(p.id)) state.compareSet.delete(p.id);
  else {
    if (state.compareSet.size >= 4) return toast("You can compare up to 4 photos at once.");
    state.compareSet.add(p.id);
  }
  paintThumb(p); updateCompareUI(); syncStage();
}
function closeCompare() { $("#compare").classList.remove("open"); }
function openCompare() {
  const ps = [...state.compareSet].map(id => byId.get(id)).filter(Boolean);
  if (ps.length < 2) return toast("Tap ⊞ on 2 to 4 photos first, then open Compare.");
  const grid = $("#cmp-grid"); grid.innerHTML = "";
  grid.style.setProperty("--cols", ps.length <= 2 ? 2 : ps.length === 3 ? 3 : 2);
  ps.forEach(p => {
    const cell = document.createElement("div"); cell.className = "cmp-cell";
    const rd = rotOf(p);
    cell.style.setProperty("--rot", rd + "deg"); cell.classList.toggle("rq", rd % 180 !== 0);
    cell.innerHTML = `<div class="cmp-img"><img src="${p.url}" alt="${esc(p.name)}"></div><div class="cmp-bar"><span class="nm" title="${esc(p.name)}">${esc(p.name)}</span><span class="score-chip focus">Focus ${focus10(p)}</span><span class="score-chip ${scoreClass(p.score)}">Score ${p.score}</span><button class="act keep">Keep</button><button class="act nope">Reject</button></div>`;
    const keep = cell.querySelector(".keep"), nope = cell.querySelector(".nope");
    const paint = () => { keep.classList.toggle("on", p.flag === "pick"); nope.classList.toggle("on", p.flag === "reject"); };
    keep.addEventListener("click", () => { setFlag(p, p.flag === "pick" ? "none" : "pick", { noAdvance: true }); paint(); });
    nope.addEventListener("click", () => { setFlag(p, p.flag === "reject" ? "none" : "reject", { noAdvance: true }); paint(); });
    cell.querySelector("img").addEventListener("click", () => cell.classList.toggle("zoomed"));
    paint(); grid.appendChild(cell);
  });
  $("#cmp-note").textContent = `${ps.length} photos · click a photo to zoom in`;
  $("#compare").classList.add("open");
}
$("#btn-compare").addEventListener("click", openCompare);
$("#cmp-close").addEventListener("click", closeCompare);

document.addEventListener("dragenter", e => { e.preventDefault(); document.body.classList.add("dragging"); });
document.addEventListener("dragover", e => { e.preventDefault(); if (startOpen()) $("#start-modal").classList.add("dragover"); });
document.addEventListener("dragleave", e => { if (e.relatedTarget === null) { document.body.classList.remove("dragging"); $("#start-modal").classList.remove("dragover"); } });
document.addEventListener("drop", e => {
  e.preventDefault(); document.body.classList.remove("dragging");
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  if (!files.length || importBusy() || dialogOpen()) return;
  if (!(arenaActive() && state.photos.length)) {
    $("#start-modal").classList.remove("dragover");
    if (startOpen()) setStartSelection(files); else openStartModal(files);
    return;
  }
  ingest(files);
});

let resizeT;
window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => centerActive(false), 150); });

try {
  state.autoAdvance = localStorage.getItem("proofsheet_autoadvance") !== "0";
  $("#opt-advance").checked = state.autoAdvance;
} catch {}
buildFilters(); buildPhotobar(); syncSeg(); updateSubjectFilter();
showScreen("intro");
