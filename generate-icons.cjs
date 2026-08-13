// 简单的 Node.js PNG 图标生成脚本
// 用纯 JS（无需第三方依赖）生成简单的橙色 PNG 图标文件
// 用法：node generate-icons.cjs

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * 生成一个简单的 RGBA PNG（圆角色块 + 中央白色字母/图案占位）
 * @param {number} size 边长（像素）
 * @param {string} outPath 输出路径
 */
function makePng(size, outPath) {
  const W = size, H = size;
  const data = Buffer.alloc(H * (1 + W * 4));

  // 圆角色块配色：橙黄渐变
  const c1 = [255, 152, 0, 255]; // 深橙
  const c2 = [255, 193, 7, 255]; // 浅橙

  const radius = Math.max(2, Math.round(W * 0.22));
  for (let y = 0; y < H; y++) {
    data[y * (1 + W * 4)] = 0; // filter None
    for (let x = 0; x < W; x++) {
      const o = y * (1 + W * 4) + 1 + x * 4;
      // 是否在圆角外 → 透明
      const inRounded = isInsideRounded(x, y, W, H, radius);
      if (!inRounded) {
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
        continue;
      }
      // 渐变
      const t = y / Math.max(1, H - 1);
      let r = Math.round(c1[0] * (1 - t) + c2[0] * t);
      let g = Math.round(c1[1] * (1 - t) + c2[1] * t);
      let b = Math.round(c1[2] * (1 - t) + c2[2] * t);
      // 中央画一个白色 "P" 形状（Pet 缩写）
      const cx = W / 2, cy = H / 2;
      const u = (x - cx) / W; // -0.5 ~ 0.5
      const v = (y - cy) / H;
      // P: 左侧竖线 + 上方半圆弧
      const stroke = 0.055;
      const inP =
        (Math.abs(u + 0.18) < stroke && v > -0.26 && v < 0.28) ||
        (u > -0.20 && u < 0.06 && Math.abs(v + 0.08) < stroke) ||
        (Math.hypot(u - 0.02, v + 0.08) < 0.17 &&
         Math.hypot(u - 0.02, v + 0.08) > 0.17 - stroke * 2 &&
         u > 0 && v < -0.04);
      if (inP) { r = 255; g = 255; b = 255; }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }

  const png = encodePng(W, H, data);
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, png);
  console.log('✓', outPath, `(${size}x${size}, ${png.length} bytes)`);
}

function isInsideRounded(x, y, w, h, r) {
  if (x < r && y < r) return (x - r + 0.5) ** 2 + (y - r + 0.5) ** 2 <= (r - 0.5) ** 2;
  if (x >= w - r && y < r) return (x - (w - r) + 0.5) ** 2 + (y - r + 0.5) ** 2 <= (r - 0.5) ** 2;
  if (x < r && y >= h - r) return (x - r + 0.5) ** 2 + (y - (h - r) + 0.5) ** 2 <= (r - 0.5) ** 2;
  if (x >= w - r && y >= h - r) return (x - (w - r) + 0.5) ** 2 + (y - (h - r) + 0.5) ** 2 <= (r - 0.5) ** 2;
  return true;
}

// ------- PNG 编码器（无依赖，RGBA 8bit） -------
function crc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crc32Table();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(w, h, raw) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------- 生成 ICO（Windows 图标）包含 16/32/48/64/128/256 PNG -------
function makeIco(sizes, outPath) {
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  const blobs = sizes.map(s => {
    const W = s, H = s;
    const data = Buffer.alloc(H * (1 + W * 4));
    const radius = Math.max(2, Math.round(W * 0.22));
    const c1 = [255, 152, 0, 255];
    const c2 = [255, 193, 7, 255];
    for (let y = 0; y < H; y++) {
      data[y * (1 + W * 4)] = 0;
      for (let x = 0; x < W; x++) {
        const o = y * (1 + W * 4) + 1 + x * 4;
        if (!isInsideRounded(x, y, W, H, radius)) {
          data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0; continue;
        }
        const t = y / Math.max(1, H - 1);
        let r = Math.round(c1[0] * (1 - t) + c2[0] * t);
        let g = Math.round(c1[1] * (1 - t) + c2[1] * t);
        let b = Math.round(c1[2] * (1 - t) + c2[2] * t);
        const cx = W / 2, cy = H / 2;
        const u = (x - cx) / W, v = (y - cy) / H;
        const stroke = 0.055;
        const inP =
          (Math.abs(u + 0.18) < stroke && v > -0.26 && v < 0.28) ||
          (u > -0.20 && u < 0.06 && Math.abs(v + 0.08) < stroke) ||
          (Math.hypot(u - 0.02, v + 0.08) < 0.17 &&
           Math.hypot(u - 0.02, v + 0.08) > 0.17 - stroke * 2 &&
           u > 0 && v < -0.04);
        if (inP) { r = 255; g = 255; b = 255; }
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
    return encodePng(W, H, data);
  });

  let offset = 6 + 16 * sizes.length;
  sizes.forEach((s, i) => {
    const entry = 6 + 16 * i;
    const sz = s >= 256 ? 0 : s;
    header.writeUInt8(sz, entry + 0);
    header.writeUInt8(sz, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(blobs[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += blobs[i].length;
  });

  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([header, ...blobs]));
  console.log('✓', outPath, `(${sizes.join('/')}, ${fs.statSync(outPath).size} bytes)`);
}

// ------- 生成托盘 PNG -------
function makeTray(outPath) {
  const size = 26;
  const W = size, H = size;
  const data = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    data[y * (1 + W * 4)] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * (1 + W * 4) + 1 + x * 4;
      const cx = W / 2, cy = H / 2;
      const rr = Math.min(W, H) / 2 - 1.5;
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      if (d > rr) { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0; continue; }
      const t = y / Math.max(1, H - 1);
      const r = Math.round(255 * (1 - t) + 255 * t);
      const g = Math.round(152 * (1 - t) + 193 * t);
      const b = Math.round(0 * (1 - t) + 7 * t);
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, encodePng(W, H, data));
  console.log('✓', outPath, `(${fs.statSync(outPath).size} bytes)`);
}

// ------- 执行 -------
const iconsDir = path.resolve(__dirname, 'src-tauri/icons');
console.log('生成图标到:', iconsDir);
makePng(32,  path.join(iconsDir, '32x32.png'));
makePng(128, path.join(iconsDir, '128x128.png'));
makePng(256, path.join(iconsDir, '256x256.png'));
makeIco([16, 32, 48, 64, 128, 256], path.join(iconsDir, 'icon.ico'));
makeTray(path.join(iconsDir, 'tray_placeholder.png'));
console.log('全部图标生成完成');
