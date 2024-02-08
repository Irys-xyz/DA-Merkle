import { MerkelNode } from "./types";

export function intToBuffer(note: number, size = 6): Uint8Array {
    const buffer = new Uint8Array(size);
  
    for (var i = buffer.length - 1; i >= 0; i--) {
      var byte = note % 256;
      buffer[i] = byte;
      note = (note - byte) / 256;
    }
  
    return buffer;
  }
  
  export function bufferToInt(buffer: Uint8Array): number {
    let value = 0;
    for (var i = 0; i < buffer.length; i++) {
      value *= 256;
      value += buffer[i];
    }
    return value;
  }
  
  // converts a buffer into a bigint
  export function bufferToBigInt(buffer: Buffer): bigint {
    const hex = buffer.toString("hex");
    if (!hex) return 0n;
    return BigInt(`0x${hex}`);
  }
  
  
  export function bigIntToBuffer(note: bigint, size: number): Buffer {
    // taken from the bigint-buffer package
    // TODO: use that package as it has a much faster C impl
    const hex = note.toString(16);
    const buf = Buffer.from(hex.padStart(size * 2, '0').slice(0, size * 2), 'hex');
    return buf;
  }


export const bigIntMax = (...args) => args.reduce((m, e) => e > m ? e : m);
export const bigIntMin = (...args) => args.reduce((m, e) => e < m ? e : m);




  export const arrayCompare = (a: Uint8Array | any[], b: Uint8Array | any[]) =>
  a.every((value: any, index: any) => b[index] === value);

  export function randomNumber(min: number, max: number): number {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


const cmpErr = (a: MerkelNode, b: MerkelNode, k: string, path: string, cmpFn = (ak, bk) => ak === bk) => {
  const ak = a[k];
  const bk = b[k];
  if (!cmpFn(ak, bk)) throw { a, b, k, path };
};
const cmpBuf = (av, bv) => Buffer.compare(av, bv) === 0;

export function treeCompare(a: MerkelNode, b: MerkelNode, path = "") {
  if (a.type !== b.type) throw {a, b, k: "type", path}
  if (a.type === "branch" && b.type === "branch") {
    treeCompare(a.leftChild!, b.leftChild!, path + ".leftChild");
    treeCompare(a.rightChild!, b.rightChild!, path+ ".rightChild");
  }
  if (a.type === "leaf" && b.type === "leaf") {
    cmpErr(a, b, "offset", path);
    cmpErr(a, b, "maxOffset", path);
    cmpErr(a, b, "maxOffset", path);
    cmpErr(a, b, "id", path,cmpBuf);
    cmpErr(a, b, "hash", path, cmpBuf);
  }
}