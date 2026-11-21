/**
 * MPO (CIPA DC-007 Multi-Picture Object) writer: a stereo pair stored as two
 * JPEGs in one file, as produced by 3D cameras and read by 3D displays,
 * Nintendo 3DS, StereoPhoto Maker, etc. Image 1 = left eye, image 2 = right.
 */

const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

class Writer {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 255); }
  u16(v: number) { this.u8(v >>> 8); this.u8(v); }
  u32(v: number) { this.u16(v >>> 16); this.u16(v & 0xffff); }
  raw(a: number[]) { for (const b of a) this.u8(b); }
  get length() { return this.bytes.length; }
  set32(pos: number, v: number) {
    this.bytes[pos] = (v >>> 24) & 255; this.bytes[pos + 1] = (v >>> 16) & 255;
    this.bytes[pos + 2] = (v >>> 8) & 255; this.bytes[pos + 3] = v & 255;
  }
}

const TYPE_LONG = 4, TYPE_UNDEFINED = 7, TYPE_RATIONAL = 5, TYPE_SRATIONAL = 10;

interface Entry { tag: number; type: number; count: number; value: number[] | number }

/**
 * Write an IFD (big-endian, offsets relative to the TIFF header). Values that
 * do not fit in 4 bytes go into a data area after the IFD.
 */
function writeIFD(w: Writer, headerPos: number, entries: Entry[], nextIfd: number | 'none'): { nextPtrPos: number } {
  const ifdStart = w.length - headerPos;
  const dataStart = ifdStart + 2 + entries.length * 12 + 4;
  const data: number[] = [];
  w.u16(entries.length);
  for (const e of entries) {
    w.u16(e.tag); w.u16(e.type); w.u32(e.count);
    if (typeof e.value === 'number') {
      w.u32(e.value);
    } else if (e.value.length <= 4) {
      const v = [...e.value, 0, 0, 0, 0].slice(0, 4);
      w.raw(v);
    } else {
      w.u32(dataStart + data.length);
      data.push(...e.value);
    }
  }
  const nextPtrPos = w.length;
  w.u32(nextIfd === 'none' ? 0 : nextIfd);
  w.raw(data);
  return { nextPtrPos };
}

function rational(num: number, den: number): number[] {
  const w = new Writer();
  w.u32(num >>> 0); w.u32(den >>> 0);
  return w.bytes;
}

function attributeEntries(index: number): Entry[] {
  return [
    { tag: 0xb000, type: TYPE_UNDEFINED, count: 4, value: enc('0100') },
    { tag: 0xb101, type: TYPE_LONG, count: 1, value: index },
    { tag: 0xb204, type: TYPE_LONG, count: 1, value: 1 }, // base viewpoint = image 1
    { tag: 0xb205, type: TYPE_SRATIONAL, count: 1, value: rational(0, 1) }, // convergence angle
    { tag: 0xb206, type: TYPE_RATIONAL, count: 1, value: rational(65, 1000) }, // baseline 65 mm
  ];
}

/** Build the APP2 "MPF" segment. Returns bytes plus patch positions. */
function buildApp2(first: boolean, index: number) {
  const w = new Writer();
  w.u16(0xffe2);
  const lenPos = w.length;
  w.u16(0);
  w.raw([...enc('MPF'), 0]);
  const headerPos = w.length;
  w.raw([0x4d, 0x4d, 0x00, 0x2a]);
  w.u32(8);
  let entriesPos = -1;
  if (first) {
    // MP Index IFD → MP entries → MP Attribute IFD.
    const indexEntries: Entry[] = [
      { tag: 0xb000, type: TYPE_UNDEFINED, count: 4, value: enc('0100') },
      { tag: 0xb001, type: TYPE_LONG, count: 1, value: 2 },
      { tag: 0xb002, type: TYPE_UNDEFINED, count: 32, value: new Array(32).fill(0) },
    ];
    const { nextPtrPos } = writeIFD(w, headerPos, indexEntries, 0);
    // MP entry data sits in the data area right after the IFD's next pointer.
    entriesPos = nextPtrPos + 4;
    w.set32(nextPtrPos, w.length - headerPos);
    writeIFD(w, headerPos, attributeEntries(index), 'none');
  } else {
    writeIFD(w, headerPos, attributeEntries(index), 'none');
  }
  const len = w.length - 2;
  w.bytes[lenPos] = len >>> 8;
  w.bytes[lenPos + 1] = len & 255;
  return { bytes: w.bytes, headerPos, entriesPos };
}

/** Insert a segment after SOI and any APP0/APP1 segments. */
function insertSegment(jpeg: Uint8Array, seg: number[]): { out: Uint8Array; at: number } {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG');
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff && (jpeg[pos + 1] === 0xe0 || jpeg[pos + 1] === 0xe1)) {
    pos += 2 + ((jpeg[pos + 2] << 8) | jpeg[pos + 3]);
  }
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, pos), 0);
  out.set(seg, pos);
  out.set(jpeg.subarray(pos), pos + seg.length);
  return { out, at: pos };
}

/** Combine left- and right-eye JPEGs into one MPO file. */
export function assembleMPO(leftJpeg: Uint8Array, rightJpeg: Uint8Array): Uint8Array {
  const a1 = buildApp2(true, 1);
  const a2 = buildApp2(false, 2);
  const img1 = insertSegment(leftJpeg, a1.bytes);
  const img2 = insertSegment(rightJpeg, a2.bytes);
  const headerInFile = img1.at + a1.headerPos;
  const entriesInFile = img1.at + a1.entriesPos;
  const out = new Uint8Array(img1.out.length + img2.out.length);
  out.set(img1.out, 0);
  out.set(img2.out, img1.out.length);
  const put32 = (pos: number, v: number) => {
    out[pos] = (v >>> 24) & 255; out[pos + 1] = (v >>> 16) & 255; out[pos + 2] = (v >>> 8) & 255; out[pos + 3] = v & 255;
  };
  // Entry 1: representative image, multi-frame disparity, offset 0.
  put32(entriesInFile, 0x20020002);
  put32(entriesInFile + 4, img1.out.length);
  put32(entriesInFile + 8, 0);
  // Entry 2: disparity image; offset relative to image 1's MP header.
  put32(entriesInFile + 16, 0x00020002);
  put32(entriesInFile + 20, img2.out.length);
  put32(entriesInFile + 24, img1.out.length - headerInFile);
  return out;
}
