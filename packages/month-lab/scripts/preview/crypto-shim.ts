/** Enough of node:crypto for the engine's hash chain in a browser preview. SHA-256, synchronous. */
const K = new Uint32Array(64);
const H0 = new Uint32Array(8);
(() => {
  const frac = (x: number) => ((x - Math.floor(x)) * 0x100000000) >>> 0;
  let n = 0;
  for (let p = 2; n < 64; p++) {
    let prime = true;
    for (let d = 2; d * d <= p; d++) if (p % d === 0) prime = false;
    if (!prime) continue;
    if (n < 8) H0[n] = frac(Math.sqrt(p));
    K[n] = frac(Math.cbrt(p));
    n += 1;
  }
})();

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function sha256(bytes: Uint8Array): string {
  const length = bytes.length;
  const blocks = ((length + 9 + 63) >>> 6) << 6;
  const data = new Uint8Array(blocks);
  data.set(bytes);
  data[length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(blocks - 8, Math.floor(length / 0x20000000));
  view.setUint32(blocks - 4, (length << 3) >>> 0);
  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let offset = 0; offset < blocks; offset += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15] as number;
      const b = w[t - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, i] = h as unknown as number[];
    for (let t = 0; t < 64; t++) {
      const v = e as number;
      const s1 = rotr(v, 6) ^ rotr(v, 11) ^ rotr(v, 25);
      const ch = (v & (f as number)) ^ (~v & (g as number));
      const t1 = ((i as number) + s1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const x = a as number;
      const s0 = rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
      const maj = (x & (b as number)) ^ (x & (c as number)) ^ ((b as number) & (c as number));
      const t2 = (s0 + maj) >>> 0;
      i = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, i].forEach((v, n) => {
      h[n] = ((h[n] as number) + (v as number)) >>> 0;
    });
  }
  return [...h].map((v) => v.toString(16).padStart(8, "0")).join("");
}

export function createHash(_algorithm: string) {
  let input = "";
  const api = {
    update(text: string) {
      input += text;
      return api;
    },
    digest(_encoding: string) {
      return sha256(new TextEncoder().encode(input));
    },
  };
  return api;
}
