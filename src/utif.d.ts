declare module 'utif' {
  export interface IFD {
    width: number;
    height: number;
    [key: string]: unknown;
  }
  export function decode(buf: ArrayBuffer | Uint8Array): IFD[];
  export function decodeImage(buf: ArrayBuffer | Uint8Array, ifd: IFD, ifds?: IFD[]): void;
  export function toRGBA8(ifd: IFD): Uint8Array;
  const UTIF: { decode: typeof decode; decodeImage: typeof decodeImage; toRGBA8: typeof toRGBA8 };
  export default UTIF;
}
