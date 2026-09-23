declare module "pngjs" {
  export class PNG {
    width: number;
    height: number;
    data: Buffer;
    static sync: { read(bytes: Buffer | Uint8Array): PNG; write(image: PNG): Buffer };
  }
}
