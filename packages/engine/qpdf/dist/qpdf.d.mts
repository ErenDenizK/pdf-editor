/** Types for the Emscripten ES module factory built by ../build.sh. */
export interface QpdfFileSystem {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  analyzePath(path: string): { readonly exists: boolean };
}

export interface QpdfModule {
  readonly FS: QpdfFileSystem;
  callMain(args: string[]): number;
}

export interface QpdfModuleOverrides {
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  locateFile?: (path: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => object;
}

export default function createQpdf(overrides?: QpdfModuleOverrides): Promise<QpdfModule>;
