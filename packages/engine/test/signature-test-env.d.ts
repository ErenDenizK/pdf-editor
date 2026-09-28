/** Test-only declarations for the signature tests (M5 W3): the test PKI's .p12 files. */
declare module '*.p12?url' {
  const url: string;
  export default url;
}
