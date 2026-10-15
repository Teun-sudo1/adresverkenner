// Minimal GeoTIFF reader for the elevation and flood rasters.
// Loaded as a classic script; see index.html for the load order.

// ---------- Raster reading (GeoTIFF) ----------

// Minimal GeoTIFF reader for the float32 RD New rasters used here: classic or
// BigTIFF, either byte order, strips or tiles, no or deflate compression and
// predictors 1–3. `fetchRange(offset, length)` returns a Uint8Array, so the
// same code reads a downloaded file or byte ranges of a remote Cloud-Optimized
// GeoTIFF. `inflate(bytes)` decompresses one zlib block.
const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8 };

async function openTiff(fetchRange, inflate) {
  const head = await fetchRange(0, 65536);
  const bytes = async (off, len) => off + len <= head.length ? head.subarray(off, off + len) : fetchRange(off, len);
  const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hv = view(head);
  const le = hv.getUint16(0) === 0x4949;
  const big = hv.getUint16(2, le) === 43;
  const u64 = (d, o) => Number(d.getBigUint64(o, le));

  const ifdOff = big ? u64(hv, 8) : hv.getUint32(4, le);
  const entrySize = big ? 20 : 12;
  const countBytes = await bytes(ifdOff, big ? 8 : 2);
  const n = big ? u64(view(countBytes), 0) : view(countBytes).getUint16(0, le);
  const ifd = view(await bytes(ifdOff + (big ? 8 : 2), n * entrySize));
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = i * entrySize;
    const tag = ifd.getUint16(e, le), type = ifd.getUint16(e + 2, le);
    const count = big ? u64(ifd, e + 4) : ifd.getUint32(e + 4, le);
    const fieldOff = ifdOff + (big ? 8 : 2) + e + (big ? 12 : 8);
    const inline = count * (TIFF_TYPE_SIZE[type] || 1) <= (big ? 8 : 4);
    const offset = inline ? fieldOff : (big ? u64(ifd, e + 12) : ifd.getUint32(e + 8, le));
    tags[tag] = { type, count, offset };
  }

  // Values [start, start + len) of a tag, fetched only when needed: the tile
  // offset tables of a national COG are megabytes long.
  async function values(tag, start = 0, len) {
    const t = tags[tag];
    if (!t) return null;
    len ??= t.count;
    const size = TIFF_TYPE_SIZE[t.type] || 1;
    const d = view(await bytes(t.offset + start * size, len * size));
    if (t.type === 2) return new TextDecoder().decode(new Uint8Array(d.buffer, d.byteOffset, len)).replace(/\0+$/, '');
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      const o = i * size;
      out[i] = t.type === 3 ? d.getUint16(o, le) : t.type === 4 ? d.getUint32(o, le) : t.type === 16 ? u64(d, o)
        : t.type === 11 ? d.getFloat32(o, le) : t.type === 12 ? d.getFloat64(o, le) : d.getUint8(o);
    }
    return out;
  }
  const one = async (tag, dflt) => (await values(tag, 0, 1))?.[0] ?? dflt;

  const width = await one(256), height = await one(257);
  const tiled = 322 in tags;
  const bw = tiled ? await one(322) : width;
  const bh = tiled ? await one(323) : await one(278, height);
  const compression = await one(259, 1), predictor = await one(317, 1);
  if ((await one(258)) !== 32 || (await one(339, 1)) !== 3) throw new Error('Alleen float32-rasters worden ondersteund.');
  if (compression !== 1 && compression !== 8) throw new Error(`TIFF-compressie ${compression} niet ondersteund.`);
  // Georeferencing is either pixel scale + tie point, or a transformation matrix.
  let sx, sy, originX, originY;
  if (33550 in tags) {
    [sx, sy] = await values(33550);
    const tp = await values(33922);
    originX = tp[3] - tp[0] * sx;
    originY = tp[4] + tp[1] * sy;
  } else {
    const m = await values(34264);
    [sx, sy, originX, originY] = [m[0], -m[5], m[3], m[7]];
  }
  const nodataStr = 42113 in tags ? await values(42113) : null;
  const nodata = nodataStr != null ? parseFloat(nodataStr) : null;
  const across = Math.ceil(width / bw);
  const offTag = tiled ? 324 : 273, cntTag = tiled ? 325 : 279;

  async function decodeBlock(raw, rows) {
    const data = compression === 8 ? await inflate(raw) : raw;
    const out = new Float32Array(bw * rows);
    const d = view(data);
    if (predictor === 3) {
      // Floating-point predictor: per row, bytes are differenced and split into
      // planes, most significant byte first.
      const rowBytes = bw * 4, tmp = new DataView(new ArrayBuffer(4));
      const row = new Uint8Array(rowBytes);
      for (let r = 0; r < rows; r++) {
        row.set(data.subarray(r * rowBytes, (r + 1) * rowBytes));
        for (let i = 1; i < rowBytes; i++) row[i] = (row[i] + row[i - 1]) & 0xff;
        for (let i = 0; i < bw; i++) {
          for (let b = 0; b < 4; b++) tmp.setUint8(b, row[b * bw + i]);
          out[r * bw + i] = tmp.getFloat32(0, false);
        }
      }
    } else if (predictor === 2) {
      // Horizontal differencing on the raw 32-bit words.
      const tmp = new DataView(new ArrayBuffer(4));
      for (let r = 0; r < rows; r++) {
        let acc = 0;
        for (let i = 0; i < bw; i++) {
          acc = (acc + d.getUint32((r * bw + i) * 4, le)) >>> 0;
          tmp.setUint32(0, acc, true);
          out[r * bw + i] = tmp.getFloat32(0, true);
        }
      }
    } else {
      for (let i = 0; i < bw * rows; i++) out[i] = d.getFloat32(i * 4, le);
    }
    return out;
  }

  // Reads the pixels covering an RD bounding box; nodata becomes NaN.
  async function readWindow(minX, minY, maxX, maxY) {
    const c0 = Math.max(0, Math.floor((minX - originX) / sx)), c1 = Math.min(width, Math.ceil((maxX - originX) / sx));
    const r0 = Math.max(0, Math.floor((originY - maxY) / sy)), r1 = Math.min(height, Math.ceil((originY - minY) / sy));
    const w = c1 - c0, h = r1 - r0;
    const out = new Float32Array(Math.max(0, w * h)).fill(NaN);
    if (w <= 0 || h <= 0) return { data: out, width: 0, height: 0, x0: originX, y0: originY, res: sx };
    const bx0 = Math.floor(c0 / bw), bx1 = Math.floor((c1 - 1) / bw);
    const by0 = Math.floor(r0 / bh), by1 = Math.floor((r1 - 1) / bh);
    const jobs = [];
    for (let by = by0; by <= by1; by++) {
      const first = by * across + bx0, len = bx1 - bx0 + 1;
      jobs.push(Promise.all([values(offTag, first, len), values(cntTag, first, len)]).then(([offs, cnts]) =>
        Promise.all(offs.map(async (off, k) => {
          const bx = bx0 + k;
          const rows = tiled ? bh : Math.min(bh, height - by * bh);
          if (!cnts[k]) return;
          const block = await decodeBlock(await fetchRange(off, cnts[k]), rows);
          for (let r = 0; r < rows; r++) {
            const gy = by * bh + r;
            if (gy < r0 || gy >= r1) continue;
            for (let c = 0; c < bw; c++) {
              const gx = bx * bw + c;
              if (gx < c0 || gx >= c1) continue;
              const v = block[r * bw + c];
              out[(gy - r0) * w + (gx - c0)] = v === nodata || !(Math.abs(v) < 1e30) ? NaN : v;
            }
          }
        }))));
    }
    await Promise.all(jobs);
    return { data: out, width: w, height: h, x0: originX + c0 * sx, y0: originY - r0 * sy, res: sx };
  }

  return { width, height, res: sx, readWindow };
}
